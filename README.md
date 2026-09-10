# lint-list

A corpus of 1002 code-smell rules (50 categories, JSON) plus an [omp](https://omp.sh) extension that audits a change set against them without paying for all 1002 every time: **route → evaluate → report → (opt-in) fix**.

```
rules/                        # 1002 rule JSONs, one directory per category
extension/                    # the omp extension (lint-audit)
  package.json                # omp plugin manifest
  index.ts                    # command, scope resolution, orchestration
  router.ts                   # change units, heuristics, router I/O validation, route → rule expansion
  report.ts                   # markdown report and the fix prompt
  routing-prompt.md           # system prompt of the routing stage
  routing-map.json            # route name → rule ids (62 routes; 2 baseline + 60 optional)
  router.test.ts              # bun test
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

The extension resolves the rules from `extension/rules/` or `../rules` next to it (symlinked installs included — the realpath is checked too), so both a bundled copy and this repo layout work. Requires an authenticated omp model (run `/login` inside omp once).

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

1. **Scope.** Default `auto`: the current PR diff — merge-base of `HEAD` and the base branch, diffed against the working tree (uncommitted and untracked files included, deleted files listed). Whole-tree auditing is expensive; it happens only when no diff is detectable or when forced with `scope=full`.
2. **Route.** The scope is split into change units (one per file). Three sources decide which rule batches ("routes") apply; they only ever add, never suppress:
   - *baseline* — `envy` and `comments` (65 rules) are scheduled for every scope;
   - *heuristics* — high-precision lexical and path triggers over the added/removed lines (`Mutex`, `.await`, `INSERT INTO`, `unsafe`, `tests/`, `Cargo.toml`, …); prose and data files are exempt;
   - *router* — one call per ~60 KB of units to a cheap model with `routing-prompt.md` as system prompt. It judges semantic applicability (a handler can be concurrent without containing `spawn`), and may answer `need` when context is missing; those routes are evaluated anyway and the missing context is listed in the report. Its JSON is validated against the closed vocabulary and the unit inventory; an invalid answer is retried once with the reason; a second failure schedules **every** route for that batch (correctness over savings) and is recorded in the report.
3. **Evaluate.** Selected routes expand to rule ids through `routing-map.json`; rules are ordered by route (so each batch is topically coherent), partitioned into groups of `group=`, and each group is reviewed by a headless read-only sub-session (`read`/`grep`/`glob`) that receives the routing evidence as focus hints. Rules absent from the map (custom rule dirs) are always evaluated.
4. **Report.** `report.md` in the run dir (or `out=`): findings grouped by file and ordered by severity, each with rule title, category, lines, evidence, suggestion, and the rule's rationale; then the routing table (route, rules evaluated, selected by, trigger evidence), unresolved router context, failed groups, and per-group tallies. The report is echoed into the chat as a display-only message and printed to stdout in print mode. **Nothing in the code is changed.**
5. **Fix** (only with `fix=true`): the findings are handed to the main session as a prompt to apply.

A selected route is a statement of applicability, not a predicted violation: correct-looking locking still gets the locking rules. How many of the 1002 rules run depends on the change; the report's summary line and `summary.json` record it. `router=all` restores the exhaustive run.

### Arguments

| Arg | Aliases | Default | Meaning |
|---|---|---|---|
| `router=MODE` | | `auto` | `auto` = baseline + heuristics + LLM router; `heuristic` = baseline + heuristics only (no router call); `all` = every rule |
| `router_model=SPEC` | `routermodel=` | `@smol` | Routing model; falls back to the evaluator model with a warning when unresolvable |
| `model=SPEC` | | current session model | Evaluation model: `provider/id`, fuzzy id, or role alias (`@smol`, `@slow`) |
| `group=N` | `groupsize=`, `n=` | `24` | Rules per evaluation group (bounds per-agent context) |
| `c=N` | `concurrency=` | `4` | Parallel sub-sessions, for routing batches and evaluation groups alike |
| `scope=MODE` | | `auto` | `auto` = PR diff when detectable, else full tree; `diff` = PR diff or fail; `full` = whole tree |
| `base=REF` | | auto-detect | Diff base (`origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`) |
| `fix=BOOL` | | `false` | `true` = after the report, ask the main session to apply the findings |
| `out=PATH` | | `<run dir>/report.md` | Where to write the report |
| `dir=PATH` | | bundled `rules/` | Alternate rules directory |
| `timeout=SEC` | | `600` | Per-group watchdog; timed-out groups are recorded as failed |
| `router_timeout=SEC` | | `300` | Per-router-call watchdog |

### Examples

```bash
# Audit the current PR, report only — typical pre-review check
/lint-audit

# Same, then apply the findings
/lint-audit fix=true

# Zero router tokens: baseline + heuristics decide the routes
/lint-audit router=heuristic

# Exhaustive: every rule, old behaviour
/lint-audit router=all

# Force diff scope against a specific base (fails loudly without a diff)
/lint-audit scope=diff base=origin/develop

# Full-tree audit on a cheap model, wide and fast
/lint-audit scope=full model=@smol group=32 c=8

# Curated rule subset (e.g. for CI), report to a fixed path
/lint-audit dir=./ci-rules out=lint-report.md
```

### Config file

Same keys in `<repo>/.omp/lint-audit.json` (project) or `extension/lint-audit.json` (shipped default); command args win:

```json
{
  "router": "auto",
  "routerModel": "@smol",
  "model": "",
  "groupSize": 24,
  "concurrency": 4,
  "scope": "auto",
  "base": "origin/main",
  "fix": false,
  "out": "",
  "rulesDir": "",
  "evalTimeoutSec": 600,
  "routerTimeoutSec": 300
}
```

### Results

Every run writes an intermediate store to `<cwd>/.omp/lint-audit/<timestamp>/`:

- `report.md` — the report (unless `out=` points elsewhere)
- `router-N.json` — per routing batch: its units and the validated router response, or the error and raw output
- `group-NN.json` — per-group verdict: rule ids, routes, findings (`rule_id`, `file`, `lines`, `severity`, `evidence`, `suggestion`), or an error with the raw model output
- `summary.json` — resolved config, scope, selected routes with sources/evidence, router notes, per-group tallies

While running, the TUI shows a live board below the editor — one line per in-flight routing batch or group with the sub-agent's current tool and intent — plus a status line.

## Routing map

`routing-map.json` is `{ version, always, routes: { <name>: { trigger, rule_ids } } }`. A rule may belong to several routes (an I/O call under a lock is reachable from `locks` and from `async_runtime`); expansion is a set union, so nothing is evaluated twice. Route names are a closed vocabulary shared with `routing-prompt.md` — `bun test` in `extension/` checks the two agree and that every bundled rule is reachable. Add a new rule to the map by appending its id to every route whose trigger covers it; a rule missing from the map is still evaluated on every run (as `unmapped`), so forgetting costs tokens, not coverage.

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

`title` is required; `category` falls back to the directory name. `counterexample` is fed to the auditor as an explicit do-not-flag instruction, `fix` guides the suggestion, `why_bad` is quoted in the report. Drop new `.json` files anywhere under `rules/` — they are picked up automatically.
