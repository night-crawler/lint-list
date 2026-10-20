import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface AuditConfig {
	groupSize: number;
	concurrency: number;
	predictorModel: string;
	validatorModel: string;
	fix: boolean;
	rulesDir: string;
	evalTimeoutSec: number;
	predictorTimeoutSec: number;
	predictorThinkingTokens: number;
	validatorThinking: boolean;
	scope: "auto" | "diff" | "full";
	base: string;
	out: string;
}

const DEFAULTS: AuditConfig = {
	groupSize: 24,
	concurrency: 4,
	predictorModel: "@smol",
	validatorModel: "",
	fix: false,
	rulesDir: "",
	evalTimeoutSec: 600,
	predictorTimeoutSec: 120,
	predictorThinkingTokens: 512,
	validatorThinking: true,
	scope: "auto",
	base: "",
	out: "",
};

const isScopeMode = (value: unknown): value is AuditConfig["scope"] => value === "auto" || value === "diff" || value === "full";
const parseBool = (value: string): boolean => value !== "false" && value !== "0" && value !== "no";

function parseArgs(args: string): Partial<AuditConfig> {
	const out: Partial<AuditConfig> = {};
	for (const token of args.trim().split(/\s+/).filter(Boolean)) {
		const eq = token.indexOf("=");
		if (eq === -1) continue;
		const key = token.slice(0, eq).toLowerCase().replace(/[-_]/g, "");
		const value = token.slice(eq + 1);
		if (key === "group" || key === "groupsize" || key === "n") out.groupSize = Number(value);
		else if (key === "c" || key === "concurrency") out.concurrency = Number(value);
		else if (key === "predictormodel") out.predictorModel = value;
		else if (key === "validatormodel") out.validatorModel = value;
		else if (key === "model" || key === "router" || key === "routermodel" || key === "routertimeout")
			throw new Error("Routing/model options were replaced: use predictor_model= and validator_model=");
		else if (key === "fix") out.fix = parseBool(value);
		else if (key === "dir") out.rulesDir = value;
		else if (key === "timeout") out.evalTimeoutSec = Number(value);
		else if (key === "predictortimeout") out.predictorTimeoutSec = Number(value);
		else if (key === "predictorthinkingtokens") out.predictorThinkingTokens = value ? Number(value) : Number.NaN;
		else if (key === "validatorthinking") out.validatorThinking = parseBool(value);
		else if (key === "scope" && isScopeMode(value)) out.scope = value;
		else if (key === "base") out.base = value;
		else if (key === "out") out.out = value;
	}
	return out;
}

async function readConfigFile(path: string): Promise<Partial<AuditConfig>> {
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path}: expected a configuration object`);
	const record = parsed as Record<string, unknown>;
	if (["model", "router", "routerModel", "routerTimeoutSec"].some((key) => key in record)) {
		throw new Error(`${path}: replace model/router settings with predictorModel and validatorModel`);
	}
	const out: Partial<AuditConfig> = {};
	if (typeof record.groupSize === "number") out.groupSize = record.groupSize;
	if (typeof record.concurrency === "number") out.concurrency = record.concurrency;
	if (typeof record.predictorModel === "string") out.predictorModel = record.predictorModel;
	if (typeof record.validatorModel === "string") out.validatorModel = record.validatorModel;
	if (typeof record.fix === "boolean") out.fix = record.fix;
	if (typeof record.rulesDir === "string") out.rulesDir = record.rulesDir;
	if (typeof record.evalTimeoutSec === "number") out.evalTimeoutSec = record.evalTimeoutSec;
	if (typeof record.predictorTimeoutSec === "number") out.predictorTimeoutSec = record.predictorTimeoutSec;
	if (typeof record.predictorThinkingTokens === "number") out.predictorThinkingTokens = record.predictorThinkingTokens;
	if (typeof record.validatorThinking === "boolean") out.validatorThinking = record.validatorThinking;
	if (isScopeMode(record.scope)) out.scope = record.scope;
	if (typeof record.base === "string") out.base = record.base;
	if (typeof record.out === "string") out.out = record.out;
	return out;
}

// Symlinked installations may expose either the link directory or the real package directory.
function packagePath(...segments: string[]): string {
	let real = import.meta.dir;
	try {
		real = realpathSync(import.meta.dir);
	} catch {}
	return [join(import.meta.dir, ...segments), join(real, ...segments)].find((path) => existsSync(path)) ?? join(real, ...segments);
}

export function resolveRulesDir(configured: string, cwd: string): string | undefined {
	if (configured) return [join(cwd, configured), configured].find((path) => existsSync(path));
	return [packagePath("rules"), packagePath("..", "rules")].find((path) => existsSync(path));
}

/** Command arguments override project settings, package settings, then defaults. Invalid numeric limits throw. */
export async function loadConfig(args: string, cwd: string): Promise<AuditConfig> {
	const config: AuditConfig = {
		...DEFAULTS,
		...(await readConfigFile(packagePath("lint-audit.json"))),
		...(await readConfigFile(join(cwd, ".omp", "lint-audit.json"))),
		...parseArgs(args),
	};
	for (const key of ["groupSize", "concurrency"] as const) {
		if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer`);
	}
	for (const key of ["predictorTimeoutSec", "evalTimeoutSec"] as const) {
		if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`${key} must be finite and positive`);
	}
	if (!Number.isSafeInteger(config.predictorThinkingTokens) || config.predictorThinkingTokens < 0) {
		throw new Error("predictorThinkingTokens must be a non-negative integer (0 disables thinking)");
	}
	return config;
}
