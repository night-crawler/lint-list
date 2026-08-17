# lint-list

A corpus of 965 code-smell rules (49 categories, JSON) plus an [omp](https://omp.sh) extension that audits a codebase against **all** of them: seeded shuffle → fixed-size groups → parallel read-only sub-agent evaluations → findings applied to the code by the main session.

```
rules/               # 965 rule JSONs, one directory per category
extension/           # the omp extension (lint-audit)
  package.json       # omp plugin manifest
  index.ts
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

# headless / CI (--auto-approve lets the apply turn edit files)
omp -p --auto-approve -e /path/to/lints-list/extension "/lint-audit"
```

`/lint-audit` runs every rule exactly once: the full rule array is shuffled with a fixed seed (stable across runs), partitioned into groups, and each group is evaluated by a headless read-only sub-agent (`read`/`grep`/`glob` only) against the audit scope. Clean groups report success and never enter the model context; positive detections are aggregated into one message that the main session applies to the code.

By default the audit scope is the **current PR diff**: merge-base of `HEAD` and the base branch, diffed against the working tree (uncommitted changes included). Auditing the whole tree is expensive; it happens only when no diff is detectable or when forced with `scope=full`.

### Arguments

| Arg | Aliases | Default | Meaning |
|---|---|---|---|
| `group=N` | `groupsize=`, `n=` | `24` | Rules per evaluation group (bounds per-agent context) |
| `c=N` | `concurrency=` | `4` | Parallel evaluations (bounds wall-clock time) |
| `seed=N` | | `1337` | Shuffle seed; same seed ⇒ identical grouping |
| `model=SPEC` | | current session model | Evaluation model: `provider/id`, fuzzy id, or role alias (`@smol`, `@slow`) |
| `scope=MODE` | | `auto` | `auto` = PR diff when detectable, else full tree; `diff` = PR diff or fail; `full` = whole tree |
| `base=REF` | | auto-detect | Diff base (`origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`) |
| `apply=BOOL` | | `true` | `false` = report only, nothing sent to the main session |
| `dir=PATH` | | bundled `rules/` | Alternate rules directory |
| `timeout=SEC` | | `600` | Per-group watchdog; timed-out groups recorded as errors |

### Examples

```bash
# Audit the current PR, report only — typical pre-review check
/lint-audit apply=false

# Force diff scope against a specific base (fails loudly without a diff)
/lint-audit scope=diff base=origin/develop

# Full-tree audit on a cheap model, wide and fast
/lint-audit scope=full model=@smol group=32 c=8

# Second opinion: different shuffle regroups the rules
/lint-audit seed=42

# Curated rule subset (e.g. for CI)
/lint-audit dir=./ci-rules apply=false
```

### Config file

Same keys in `<repo>/.omp/lint-audit.json` (project) or `extension/lint-audit.json` (shipped default); command args win:

```json
{
  "groupSize": 24,
  "concurrency": 4,
  "seed": 1337,
  "model": "@smol",
  "scope": "auto",
  "base": "origin/main",
  "apply": false,
  "rulesDir": "",
  "evalTimeoutSec": 600
}
```

### Results

Every run writes an intermediate store to `<cwd>/.omp/lint-audit/<timestamp>-seed<S>-g<G>/`:

- `group-NN.json` — per-group verdict: rule ids, findings (`rule_id`, `file`, `lines`, `evidence`, `suggestion`), or an error with the raw model output
- `summary.json` — resolved scope, model, and per-group tallies

While running, the TUI shows a live board below the editor — one line per in-flight group with the sub-agent's current tool and intent — plus a `done/total | findings` status line.

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

`title` is required; `category` falls back to the directory name. `counterexample` is fed to the auditor as an explicit do-not-flag instruction, `fix` guides the suggestion. Drop new `.json` files anywhere under `rules/` — they are picked up automatically.
