import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, resolveRulesDir } from "./config";
import { AuditProgress } from "./progress";
import { createPredictor } from "./predictor";
import { buildFixMessage, buildReport, describeScope } from "./report";
import { loadRules, planGroups } from "./rules";
import { resolveAuditScope } from "./scope";
import type { PredictionResult, Rule } from "./types";
import { type SdkExports, validateGroup } from "./validator";

async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

export default function lintAudit(pi: ExtensionAPI) {
	pi.setLabel("Lint Audit");
	pi.registerCommand("lint-audit", {
		description: "Predict lint violations, validate positive groups read-only, report (fix=true to apply)",
		handler: async (args, ctx) => {
			let progress: AuditProgress | undefined;
			try {
				const sdk = pi.pi as unknown as Partial<SdkExports>;
				if (!sdk.createAgentSession || !sdk.SessionManager) throw new Error("SDK exports unavailable (createAgentSession/SessionManager)");
				const fullSdk = sdk as SdkExports;
				const cfg = await loadConfig(args, ctx.cwd);
				progress = new AuditProgress(ctx.ui, ctx.hasUI, cfg.concurrency);
				const rulesDir = resolveRulesDir(cfg.rulesDir, ctx.cwd);
				if (!rulesDir) throw new Error("rules directory not found (dir=... or bundle rules/ next to the extension)");
				const allRules = await loadRules(rulesDir);
				if (allRules.length === 0) throw new Error(`no valid rule JSON files in ${rulesDir}`);
				const rulesById = new Map(allRules.map((rule) => [String(rule.id), rule]));
				const predictorModel = cfg.predictorModel ? ctx.models.resolve(cfg.predictorModel) : ctx.models.current();
				if (!predictorModel) throw new Error(`cannot resolve predictor model "${cfg.predictorModel || "<current>"}"`);
				const validatorModel = cfg.validatorModel ? ctx.models.resolve(cfg.validatorModel) : ctx.models.current();
				if (!validatorModel) throw new Error(`cannot resolve validator model "${cfg.validatorModel || "<current>"}"`);
				const predictorName = `${predictorModel.provider}/${predictorModel.id}`;
				const validatorName = `${validatorModel.provider}/${validatorModel.id}`;

				const exec = pi.exec.bind(pi);
				const scope = await resolveAuditScope(exec, ctx.cwd, cfg.scope, cfg.base);
				if (scope.kind === "full" && cfg.scope === "auto") progress.announce("lint-audit: auto selected a full-tree snapshot");
				const diffBytes = Buffer.byteLength(scope.diffText, "utf8");
				let diffLines = scope.diffText && !scope.diffText.endsWith("\n") ? 1 : 0;
				for (let i = 0; i < scope.diffText.length; i++) if (scope.diffText.charCodeAt(i) === 10) diffLines++;
				progress.announce(
					`lint-audit: captured ${diffBytes} bytes (${(diffBytes / 1024).toFixed(1)} KiB), ${diffLines} lines; ${describeScope(scope)}${scope.kind === "diff" ? "; tracked files only, no merge-base or untracked additions" : ""}`,
				);
				if (diffBytes === 0) {
					progress.announce("lint-audit: empty diff; no model requests will be made");
					return;
				}
				const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
				const runDir = join(ctx.cwd, ".omp", "lint-audit", runId);
				await mkdir(runDir, { recursive: true });
				await writeFile(join(runDir, "snapshot.diff"), scope.diffText);
				const reportPath = cfg.out ? (cfg.out.startsWith("/") ? cfg.out : join(ctx.cwd, cfg.out)) : join(runDir, "report.md");
				const auditProgress = progress;
				auditProgress.startPredictions(allRules.length);
				progress.announce(
					`lint-audit: snapshot ${join(runDir, "snapshot.diff")}; ${allRules.length} rules; predictor ${predictorName}; validator ${validatorName}`,
				);
				const predict = createPredictor({
					model: predictorModel,
					apiKey: ctx.modelRegistry.resolver(predictorModel, runId),
					diffText: scope.diffText,
					cacheKey: `lint-audit-${runId}`,
					timeoutSec: cfg.predictorTimeoutSec,
					thinkingTokens: cfg.predictorThinkingTokens,
				});
				const predictRule = async (rule: Rule): Promise<PredictionResult> => {
					auditProgress.updateActivity(`rule-${rule.id}`, rule.title);
					const result = await predict(rule);
					auditProgress.completePrediction(rule, result);
					return result;
				};
				// Warm the shared prefix before the concurrent requests, rather than racing cold cache writes.
				const predictions = [await predictRule(allRules[0]), ...(await pool(allRules.slice(1), cfg.concurrency, predictRule))];
				await writeFile(join(runDir, "predictions.json"), JSON.stringify(predictions, null, 2));
				const candidates = allRules.filter((_, index) => predictions[index].answer === "a");
				const groups = planGroups(candidates, cfg.groupSize);
				auditProgress.startValidation(groups.length);
				const results = await pool(groups, cfg.concurrency, async (group) => {
					auditProgress.updateActivity(group.label, `starting (${group.rules.length} candidates)`);
					const result = await validateGroup(group, scope, {
						sdk: fullSdk,
						model: validatorModel,
						modelRegistry: ctx.modelRegistry,
						cwd: ctx.cwd,
						timeoutSec: cfg.evalTimeoutSec,
						thinking: cfg.validatorThinking,
						onActivity: (action) => auditProgress.updateActivity(group.label, action),
					});
					await writeFile(join(runDir, `${group.label}.json`), JSON.stringify(result, null, 2));
					auditProgress.completeGroup(result);
					return result;
				});
				const findings = results.flatMap((result) => result.findings);
				const failedPredictions = predictions.filter((result) => result.error).length;
				const failedGroups = results.filter((result) => result.error).length;
				const report = buildReport({
					generatedAt: new Date(),
					scope,
					predictorModel: predictorName,
					validatorModel: validatorName,
					rulesTotal: allRules.length,
					predictions,
					groups: results,
					rulesById,
					runDir,
				});
				await mkdir(dirname(reportPath), { recursive: true });
				await writeFile(reportPath, report);
				await writeFile(
					join(runDir, "summary.json"),
					JSON.stringify(
						{
							config: { ...cfg, predictorModel: predictorName, validatorModel: validatorName },
							scope:
								scope.kind === "diff"
									? { kind: "diff", base: scope.base, baseCommit: scope.baseCommit, files: scope.files, deletedFiles: scope.deletedFiles }
									: { kind: "full", files: scope.files },
							snapshotPath: join(runDir, "snapshot.diff"),
							diffBytes,
							diffLines,
							totalRules: allRules.length,
							predictedRules: predictions.length - failedPredictions,
							predictedViolations: candidates.map((rule) => rule.id),
							failedPredictions,
							validationRules: candidates.length,
							groups: results.map((result) => ({
								group: result.group,
								ruleIds: result.ruleIds,
								findings: result.findings.length,
								clean: result.clean,
								error: result.error,
							})),
							reportPath,
						},
						null,
						2,
					),
				);
				progress.clear();
				ctx.ui.notify(
					`lint-audit: ${findings.length} confirmed findings; ${candidates.length}/${allRules.length} candidates; ${failedPredictions} predictions and ${failedGroups} groups failed. Report: ${reportPath}`,
					findings.length || failedPredictions || failedGroups ? "warning" : "info",
				);
				pi.sendMessage({ customType: "lint-audit.report", content: report, display: true }, { triggerTurn: false });
				if (!ctx.hasUI) process.stdout.write(`${report}\n`);
				if (!cfg.fix || findings.length === 0) return;
				await ctx.waitForIdle();
				pi.sendUserMessage(buildFixMessage(findings, rulesById, reportPath));
				const fixStart = Date.now();
				while (ctx.isIdle() && Date.now() - fixStart < 15_000) {
					const tick = Promise.withResolvers<void>();
					setTimeout(tick.resolve, 100);
					await tick.promise;
				}
				await ctx.waitForIdle();
			} catch (error) {
				ctx.ui.notify(`lint-audit: ${error instanceof Error ? error.message : String(error)}`, "error");
				if (!ctx.hasUI) process.stdout.write(`lint-audit: ${error instanceof Error ? error.message : String(error)}\n`);
			} finally {
				progress?.clear();
			}
		},
	});
}
