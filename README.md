# lint-list

A corpus of 1002 code-smell rules (50 categories, JSON) plus an [omp](https://omp.sh) extension:
**capture one snapshot → predict each lint → validate positive groups → report → (opt-in) fix**.

```
rules/                        # 1002 rule JSONs, one directory per category
classify_lint.py               # standalone configurable OpenAI-compatible classifier
examples/feature-envy-*.diff   # violating and clean single-rule examples
extension/                    # the omp extension (lint-audit)
  package.json                # omp plugin manifest
  index.ts                    # command, scope resolution, orchestration
  predictor.ts                # independent binary predictions with a shared cached prefix
  probabilities.ts            # raw and conditional label-token scoring
  scope.ts                    # single-pass git diff and full-tree snapshots
  report.ts                   # markdown report and confirmed-findings fix prompt
  types.ts                    # rules, predictions, findings and scope
  *.test.ts                   # bun regression tests
```

## Install

Any one of:

```bash
# 1. Per-invocation flag
omp -e /path/to/lints-list/extension

# 2. Per-project: auto-load for a repo
mkdir -p <repo>/.omp/extensions
ln -s /path/to/lints-list/extension <repo>/.omp/extensions/lint-audit

# 3. Global: auto-load everywhere
mkdir -p ~/.omp/agent/extensions
ln -s /path/to/lints-list/extension ~/.omp/agent/extensions/lint-audit
```

The extension resolves the rules from `extension/rules/` or `../rules` next to it (symlinked installs included — the
realpath is checked too), so both a bundled copy and this repo layout work. Requires an authenticated omp model (run
`/login` inside omp once).

## Use

```bash
# interactive
omp -e /path/to/lints-list/extension
> /lint-audit

# headless / CI: report only, printed to stdout
omp -p -e /path/to/lints-list/extension "/lint-audit"

# headless and apply the findings (--auto-approve lets the fix turn edit files)
omp -p --auto-approve -e /path/to/lints-list/extension "/lint-audit fix=true"
```

### Pipeline

1. **Capture once.** Default `auto`: the tracked working-tree diff against the selected base branch's **tip**,
   preferring local `main`. This matches `git diff main` when `main` is selected: committed, staged and unstaged
   changes are included, but untracked files are not. There is no merge-base substitution. One
   `git diff --patch-with-raw` invocation captures both the file inventory and patch. The base commit SHA is
   pinned and recorded. Before any model request, the command prints the byte/KiB size, line count, file count
   and selected base. An empty diff stops without model calls. `scope=full`, or `auto` when no base is resolvable,
   creates an all-additions snapshot of the working tree instead, including untracked text files.
2. **Predict every rule.** The configured `predictorModel` receives one independent, tool-free binary request per
   loaded rule. There is no routing or heuristic prefilter. Request order is:

   ```
   fixed system instructions
   complete diff snapshot (shared system block, explicitly untrusted data)
   complete lint criterion (including counterexample and fix)
   options:
   a: violates
   b: doesn't violate
   ```

   The system/diff prefix is built once and remains identical across requests; no previous criteria or answers
   accumulate as conversation history. The SDK receives `cacheRetention: "short"` and a shared per-run
   `promptCacheKey`. The separate diff system block supplies a cache boundary on providers with explicit
   system-block caching. The first request finishes before the remaining requests run with concurrency `c=`,
   allowing the prefix cache to warm. Actual cache hits depend on provider support, minimum prefix size and retention.

   The system prompt states that the diff contains a violation somewhere and tells the predictor to inspect
   every file and hunk. One qualifying occurrence is enough; unrelated clean additions cannot cancel it.
   That premise does not force every criterion to be positive: the known violation may concern another lint.

   Each completed rule immediately updates the below-editor widget with its ID/title, `a`/`b`, raw
   `P(a)`/`P(b)`, and probabilities normalized over the two labels (`P(a|a/b)`/`P(b|a/b)`).
   OpenAI Chat Completions and Responses predictors request the
   top 20 token logprobs. These are token scores, not calibrated violation probabilities. Missing alternatives
   print as `unknown`, never zero; if either is missing, normalized probabilities are also unknown. Other API
   types, missing logprobs or malformed scores produce an explicit probability-unavailable reason without
   changing a valid binary verdict. Providers that reject the logprobs request fail visibly.
3. **Validate positives.** Only `a` predictions enter validation. They are sorted by category and source path,
   partitioned into groups of at most `group=`, and independently checked by `validatorModel` in read-only
   sub-sessions (`read`/`grep`/`glob`). Each group gets the same complete snapshot and its candidate criteria.
   A prediction is not evidence: the validator must supply a file, location and concrete suggestion for confirmed
   violations. If all predictions are `b`, no validation sessions are started.
4. **Report.** Confirmed findings are grouped by file and severity. Prediction negatives, prediction failures and
   failed validation groups are counted separately. Invalid, truncated or timed-out predictions are **unknown**,
   never clean; they are excluded from validation and listed as incomplete coverage. The report is written to disk,
   echoed into chat and printed in print mode. Auditing does not change reviewed code.
5. **Fix** (only with `fix=true`): hand only validator-confirmed findings to the main session to apply.

The snapshot is never truncated or recomputed for individual rules or groups. If it exceeds a model's context
window, that request fails visibly; use a model with a sufficient context window or narrow the audited change set.
Predictor negatives are not validator-confirmed clean results: this two-stage design trades possible predictor
false negatives for less validation work.

### Arguments

| Arg | Aliases | Default | Meaning |
|---|---|---|---|
| `predictor_model=SPEC` | `predictorModel=` | `@smol` | Per-lint binary predictor: `provider/id`, fuzzy id or role alias |
| `validator_model=SPEC` | `validatorModel=` | current session model | Independent grouped-validation model |
| `group=N` | `groupsize=`, `n=` | `24` | Maximum positive rules per validation group |
| `c=N` | `concurrency=` | `4` | Concurrent predictions after cache warmup, then concurrent validation groups |
| `scope=MODE` | | `auto` | `auto` = tracked base-tip diff when a base resolves, otherwise full tree; `diff` = require a base; `full` = whole tree |
| `base=REF` | | auto-detect | Diff against the ref's tip (`main` → `master` → `origin/HEAD` → `origin/main` → `origin/master`) |
| `fix=BOOL` | | `false` | Ask the main session to apply confirmed findings |
| `out=PATH` | | `<run dir>/report.md` | Report destination |
| `dir=PATH` | | bundled `rules/` | Alternate rules directory; every loaded rule is predicted |
| `timeout=SEC` | | `600` | Per-validation-group watchdog |
| `predictor_timeout=SEC` | | `120` | Per-prediction watchdog |

Both model selections use omp's model registry and authentication, including configured custom providers. An
unresolvable model stops the command rather than silently substituting the other model.

### Examples

```bash
# Audit the current PR using the configured models
/lint-audit

# Cheap binary screening, stronger independent validation
/lint-audit predictor_model=@smol validator_model=@slow

# Apply only the validator-confirmed findings
/lint-audit predictor_model=@smol validator_model=@slow fix=true

# Force diff scope against a specific base (fails without a diff)
/lint-audit scope=diff base=origin/develop

# Full-tree snapshot; both models must fit the complete snapshot
/lint-audit scope=full predictor_model=@smol validator_model=@slow group=32 c=8

# Curated corpus and fixed report path
/lint-audit dir=./ci-rules out=lint-report.md
```

### Config file

Defaults in `extension/lint-audit.json` are overridden by `<repo>/.omp/lint-audit.json`, then by command arguments:

```json
{
  "predictorModel": "@smol",
  "validatorModel": "",
  "groupSize": 24,
  "concurrency": 4,
  "scope": "auto",
  "base": "origin/main",
  "fix": false,
  "out": "",
  "rulesDir": "",
  "evalTimeoutSec": 600,
  "predictorTimeoutSec": 120
}
```

An empty model spec selects the current session model. The predictor defaults to `@smol`; the validator defaults
to the current model. Select different models explicitly when desired.

**Migration:** replace `model` with `validatorModel` and `routerModel` with `predictorModel`; remove `router` and
replace `routerTimeoutSec` with `predictorTimeoutSec`. Old routing settings are rejected, not silently ignored.
The routing map, routing prompt, baseline rules and lexical routing stage have been removed.

### Results

Every nonempty audit writes `<cwd>/.omp/lint-audit/<timestamp>-<unique-id>/`:

- `snapshot.diff` — the exact immutable diff used by both stages
- `predictions.json` — one result per loaded rule: `ruleId`, `answer` (`a`/`b`), available raw/conditional token
  probabilities and missing labels, or errors and available raw output
- `group-N.json` — candidate IDs, confirmed findings, clean/error status and raw output on malformed validation
- `report.md` — report, unless overridden by `out=`
- `summary.json` — both resolved provider/model names, config, scope (including the exact base commit), snapshot
  byte/line counts, predicted positive IDs, failure counts and validation group tallies

The below-editor live board shows in-flight work and at most the three most recent completed verdicts
and scores. Per-rule results do not enter the TUI transcript; the full results are stored in `predictions.json`.
Print mode streams each result to stdout as rules finish, before the final report.

## Single-rule classifier

`classify_lint.py` uses Python 3.10+ and the standard library. It sends one saved diff and one complete rule JSON
to an OpenAI-compatible `/chat/completions` endpoint. It does not run the corpus or modify reviewed code.

```bash
# Explicit model; API key comes from OPENAI_API_KEY
python3 classify_lint.py --model gpt-4.1-mini

# Environment configuration is also supported
export OPENAI_MODEL=gpt-4.1-mini
export OPENAI_BASE_URL=https://api.openai.com/v1
python3 classify_lint.py --diff examples/feature-envy-no.diff

# Local/custom OpenAI-compatible server; use its advertised model ID
python3 classify_lint.py --model my-model --base-url http://localhost:8000/v1 \
  --rule rules/feature-envy/007-service-entity-calculation-envy-pay-calculation.json
```

`--model` defaults to `OPENAI_MODEL` and is required if that is unset. `--base-url` defaults to `OPENAI_BASE_URL`,
otherwise `https://api.openai.com/v1`. `--api-key` overrides `OPENAI_API_KEY`; authentication may be omitted for
local servers. No private address, Qwen chat template or llama-server-only endpoint is assumed.

The fixed system prompt and shared diff precede the varying complete criterion and `a`/`b` options. The diff is
read once; its byte/line count is printed to stderr before the request. Stdout remains JSON with `model`, `answer`
(`a` = violates, `b` = doesn't violate), `violates`, and rule metadata.
Uppercase single-letter responses are accepted and normalized. Non-binary replies, refusals, truncation and API
errors fail explicitly. A modest output budget permits reasoning before the answer; provider-specific unsupported
parameters are reported as API errors rather than retried with silently different semantics.

Probability scoring is optional: `--n-probs N` requests `logprobs`/`top_logprobs` from endpoints that support them
(default `0`, disabled). Output then includes `token_probabilities`, `probabilities_given_a_or_b`, and
`missing_labels`. Whitespace/case variants of the labels in the returned alternatives are combined; missing labels
are unknown (`null`), not zero, and conditional probabilities require both labels. These are model token scores,
not calibrated probabilities of a code smell.

Successful classification exits zero for either answer; request or classification errors exit nonzero.

## Development

For tests outside the omp host, install the SDK peer dependencies first:

```bash
cd extension
bun install
bun test
```

The regression suite covers single-pass base-tip diff capture (including diverged branches, renames and unusual
paths), immutable/full-tree snapshots, strict binary labels, missing/underflowing/invalid probabilities, bounded
candidate groups, malformed validation output and finding order.

## Rule format

Each rule is one JSON file:

```json
{
  "id": 118,
  "title": "Redundant Boolean Identity Comparisons",
  "category": "Dispensables",
  "pattern": "…",
  "detection": "…",
  "why_bad": "…",
  "counterexample": "…",
  "fix": "…"
}
```

`title` is required; `category` falls back to the directory name. `counterexample` is fed to the auditor as an explicit
do-not-flag instruction, `fix` guides the suggestion, `why_bad` is quoted in the report. Drop new `.json` files anywhere
under `rules/` — they are picked up automatically.
