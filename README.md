<h1 align="center">zcode-executor</h1>

<p align="center"><a href="./README.zh-CN.md">中文</a> · English</p>

<p align="center"><strong>Claude plans. ZCode codes. Git verifies.</strong></p>

<p align="center">A plugin for Claude Code (and Codex) that hands a well-specified development task to the local <a href="https://zcode.z.ai">ZCode</a> agent (GLM), runs it in an isolated git worktree, guards every write with a hard-rule check plus a model-based review, and lets you verify the result with <code>git diff</code> and tests instead of trusting the agent's own report.</p>

<p align="center"><img src="https://img.shields.io/badge/version-v0.3.1-5B4CF0" alt="v0.3.1"> <a href="https://www.npmjs.com/package/zcode-executor"><img src="https://img.shields.io/npm/v/zcode-executor?label=npm" alt="npm"></a> <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"> <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node"> <img src="https://img.shields.io/badge/tests-303%20passing-brightgreen" alt="Tests"></p>

## Why

Claude Code is good at thinking a task through. ZCode grinds out the code at a fraction of the cost. Left alone, either one will happily go off-script. This plugin puts the two in their places:

- **The task file is the contract.** Claude writes `tasks/T-xxx.md`; the message to ZCode is just a doorbell.
- **The worktree is the sandbox.** ZCode works in `~/.zcode-executor/worktrees/<repo>`, never in your main checkout.
- **The gate decides who gets asked.** Every tool call ZCode wants to make passes hard rules, model review, and a human if needed. Optional Jev pre-screening can allow early; otherwise the original ZCode `fast` + `low` screen runs, followed by slow review only when needed. The models can only *allow* or *ask*; they never *deny* on your behalf.
- **Evidence beats narrative.** You accept with `git diff` and your test suite.

## Quick start

Paste this to your agent (Claude Code, Codex, or anything with a shell):

> `Read https://github.com/kyomio/zcode-executor/blob/main/README.md and install zcode-executor by following its Install section, then run zcode-executor doctor.`

## How to use

You don't drive the CLI yourself. You describe the task to your agent, and it runs the skill: writes a task file, adds a worktree, dispatches to ZCode, waits, then checks the result with `git diff` and your tests before telling you it's done. If ZCode asks for something the gate won't pass on its own, the agent stops and asks you.

Two ways to trigger it:

**Call the skill directly**

```
/zcode-executor add a --json flag to the status command, keep the tests green
```

(The full name is `/zcode-executor:zcode-executor`; the short form works unless another plugin claims it.)

**Or just say so in plain language**

```
Hand the lib/queue.mjs refactor off to zcode.
```

Either way, say what "done" looks like — which command should pass, which file should exist, what output you expect. The agent turns that into the acceptance criteria in the task file, and the task file is the contract; the message sent to ZCode is only a doorbell.

## Two layers

- **Workflow layer** — dispatch and acceptance: task file → isolated worktree → local session id → background runner → `git diff` and tests. This is what the CLI commands and the skill are about.
- **Safety layer** — automatic handling of ZCode's permission requests. Its logic follows Claude Code's *auto mode*: a fixed table of hard rules that nothing can override, then **optional Jev pre-screening → ZCode fast screen → slow review if needed**, then a human when review cannot pass. Jev adds an early-pass path; it does not replace the ZCode fast screen. The reviewers can *allow* or *ask*; they can never *deny* on your behalf.

## How it works

![How zcode-executor works: dispatch, permission gate, verify](https://raw.githubusercontent.com/kyomio/zcode-executor/main/assets/how-it-works.en.png)

_Sequence diagram rendered with [archify](https://github.com/tt-a1i/archify) from [`assets/how-it-works.en.json`](assets/how-it-works.en.json)._

One runner process per session, always in the background; the CLI only reads files under `~/.zcode-executor/runs/<id>/`. Nothing costs tokens except `send` and the review calls.

## Measured cost

The workload below is what it took to build this project: 35 task files, 4 executor sessions, 957M prompt tokens and 2.39M output tokens on the executor side. The same tokens priced three ways at public API list prices, with the cache-read rate fixed at 95% for both models:

![Execution cost for the same workload](https://raw.githubusercontent.com/kyomio/zcode-executor/main/assets/cost.en.png)

| Executor | New input | Cache read | Output | Total | vs Sonnet 5 |
| --- | --- | --- | --- | --- | --- |
| Claude Sonnet 5 | $119.6 | $181.9 | $23.9 | **$325** | 1× |
| GLM-5.3-Flash, list price | $7.2 | $27.3 | $1.2 | **$35.7** | 1/9.1, saves 89% |
| GLM-5.3-Flash via ZCode (67% of list) | $4.8 | $18.3 | $0.8 | **$23.9** | 1/13.6, saves 93% |

Prices used (USD per million tokens): Sonnet 5 $2.50 cache write / $0.20 cache read / $10 output; GLM-5.3-Flash $0.15 / $0.03 / $0.50. Sonnet's new input is billed at the cache-write rate because Claude Code writes every turn into the cache. Cache reads dominate: in an agent loop the whole context is re-read every turn, so the cache-read price is what decides the gap. The measured cache-read rate was actually 99.3%; at that rate the ratio is 7.5× and 11.2×. The planner's cost is the same in every scenario and is left out. Prices as of September 2026: [Claude](https://platform.claude.com/docs/en/about-claude/pricing), [Z.ai](https://docs.z.ai/guides/overview/pricing).

## Install

### Claude Code (plugin marketplace)

This repository is both the plugin and its own marketplace.

```bash
claude plugin marketplace add kyomio/zcode-executor      # or a local path
claude plugin install zcode-executor@zcode-executor --scope user
```

`bin/zcode-executor` is added to Bash's `PATH` while the plugin is enabled; the skill appears as `/zcode-executor:zcode-executor`. Saying "let zcode do it" triggers it.

### Codex

```bash
codex plugin marketplace add kyomio/zcode-executor        # or a local path
codex plugin add zcode-executor@zcode-executor
```

Two differences from Claude Code: Codex does not put a plugin's `bin/` on `PATH` (the skill tells the agent where the binary lives), and the default `workspace-write` sandbox blocks writes to `~/.zcode-executor` — add it to `[sandbox_workspace_write] writable_roots` in `~/.codex/config.toml` or approve when prompted.

### GitHub Copilot CLI

This repository doubles as a Copilot CLI plugin marketplace.

```bash
copilot plugin marketplace add kyomio/zcode-executor
copilot plugin install zcode-executor@zcode-executor
```

### Gemini CLI

A `gemini-extension.json` at the repo root makes it a Gemini CLI extension; the bundled `skills/` are discovered automatically.

```bash
gemini extensions install https://github.com/kyomio/zcode-executor
```

### Antigravity

Antigravity is Gemini CLI under its new name (`agy`) and reuses the same extension manifest.

```bash
agy plugin install https://github.com/kyomio/zcode-executor
```

### pi

pi reads the `pi` field in `package.json` and installs the package directly.

```bash
pi install npm:zcode-executor
```

### OpenClaw

No manifest needed — link the skill into its user skills directory:

```bash
ln -s "$(npm root -g)/zcode-executor/skills/zcode-executor" ~/.openclaw/skills/zcode-executor
```

### Hermes

The repo root ships a Hermes `plugin.yaml`; install, then enable:

```bash
hermes plugins install kyomio/zcode-executor
hermes plugins enable zcode-executor
```

### Grok Build

`.grok-plugin/` carries its marketplace manifests, and the skill itself is one symlink away (it also reads `~/.agents/skills/`):

```bash
ln -s "$(npm root -g)/zcode-executor/skills/zcode-executor" ~/.grok/skills/zcode-executor
```

None of the seven agents above puts the plugin's `bin/` on `PATH` the way Claude Code does — run `npm install -g zcode-executor` once, or let the skill fall back to `npx zcode-executor`; the SKILL.md covers both.

### npm (any agent, or no agent)

```bash
npm install -g zcode-executor   # zero dependencies, nothing to build
zcode-executor doctor           # zero-token self-check
```

Or run it without installing: `npx zcode-executor doctor`. The skill ships in the package at `$(npm root -g)/zcode-executor/skills/zcode-executor/`; copy or symlink it into your agent's skills directory. The CLI itself has no Claude-specific dependency.

```bash
SKILL=$(npm root -g)/zcode-executor/skills/zcode-executor
mkdir -p ~/.claude/skills && ln -s "$SKILL" ~/.claude/skills/zcode-executor
```

Swap in your own agent's directory from this table:

| Agent | User skills directory |
| --- | --- |
| Claude Code | `~/.claude/skills` |
| Codex | `~/.codex/skills` |
| Gemini CLI / Antigravity | `~/.gemini/skills` |
| Grok Build | `~/.grok/skills` |
| Hermes | `~/.hermes/skills` |
| OpenClaw | `~/.openclaw/skills` |
| opencode | `~/.config/opencode/skills` |
| Shared (several agents read it) | `~/.agents/skills` |

### From source

```bash
git clone https://github.com/kyomio/zcode-executor && cd zcode-executor
npm link && zcode-executor doctor
```

```bash
ln -s "$PWD/skills/zcode-executor" ~/.claude/skills/zcode-executor
```

Swap in your agent's directory from the table in the npm section above.

### Requirements

- macOS or Linux. **Windows is not supported yet.** The ZCode app bundle is looked up where each platform puts it (`/Applications/…`, `/opt/ZCode/…`, `/usr/share/zcode/…`); installed anywhere else, point `ZCODE_BIN` at `zcode.cjs`.
- Node ≥ 22 (ZCode's app-server needs `node:sqlite`).
- ZCode desktop app **≥ 3.12.2** installed and logged in (3.11 and earlier are not supported). Both login styles work: an account (OAuth) Coding Plan — the CLI decrypts the platform key the App stores in `~/.zcode/v2/credentials.json` (individual and team plans; only the four keys it needs are ever read) — or an API-key provider in `~/.zcode/v2/config.json`. Both files are read-only; nothing is ever written back.

## Recommended workflow

This is how zcode-executor itself was built:

1. **Plan with Claude Fable.** The strongest reasoning model does the grilling, writes the spec, and turns it into task files with machine-checkable acceptance criteria.
2. **Execute with ZCode.** Each task goes to a GLM session in its own worktree through `zcode-executor`; the permission gate handles the routine approvals.
3. **Fable does a coarse pass, Opus does the review.** Fable checks `git diff` and runs the tests; if they hold, it dispatches an Opus subagent for a line-by-line code review. Findings go back to the same ZCode session as a follow-up task file.
4. **Merge on evidence.** Nothing lands until the tests and the review both pass.

The split keeps the expensive model on judgment and the cheap one on typing.

## Commands

| Command | What it does |
| --- | --- |
| `doctor [--json]` | Zero-token self-check: finds `zcode.cjs` and the bundled `zcode-builtin.json` (ZCode App ≥ 3.12.2), confirms the config exists, does one real handshake, reports model tiers and the review pipeline for a newly started runner; it does not call Jev |
| `models [--json]` | Lists available models with thought levels and tier assignment |
| `new --cwd <abs> [--title T] [--tier fast\|strong] [--thought L] [--deny "Tool…"] [--provider id] [--json]` | Registers a session (returns a local id `x_…`); the ZCode session is created on first `send` |
| `send <id> <text\|-> [--task file] [--wait] [--timeout s] [--steer] [--stream] [--json]` | Queues a message; `--wait` follows until done or blocked; `--task` is the task file the review uses as your authorization; `--steer` injects into a running turn — it takes effect at the next tool boundary, or after the turn ends if there is none |
| `follow <id> [--timeout s] [--stream] [--json]` | Follows a background runner until a result or a pending request |
| `status <id> [--tools N] [--json]` | Read-only snapshot: phase, recent tools, queue, pending, last result |
| `list [--project kw] [--json]` | Registered sessions with phase, tier and last outcome |
| `cancel <id>` | Denies any pending request, stops the turn, clears the queue |
| `approve <id>` / `deny <id>` | Answers the pending permission request (allow is `allow_once` only) |
| `answer <id> [--] <values…>` | Answers the pending question by index, value or label; multi-select comma-separated |

Exit codes: `0` done · `1` usage / cannot start · `2` refused (whitelist, unknown session, bad tier) · `3` `--wait` timed out (turn cancelled) · `4` turn failed / cancelled · `5` **blocked, waiting for a human** (permission or question).

## Configuration

`~/.zcode-executor/config.json` (override the directory with `ZCODE_EXECUTOR_HOME`). Every field is optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `allowedRoots` | `["~/.zcode-executor/worktrees"]` | Directories `new --cwd` may point into (symlinks resolved) |
| `waitTimeoutSec` | `1800` | `send --wait` timeout; the turn is stopped when it fires |
| `preferredProvider` | account individual plan › account team plan › `config.json` coding plan | Which provider to pick when the same model exists under several, e.g. `account:bigmodel-team-coding-plan` |
| `tiers` | auto by name | Override which model is `fast` / `strong` |
| `review` | `{enabled, model, thought:"low", fastMaxTokens:300, slowMaxTokens:2000, timeoutMs:60000}` | Model review: on/off, ZCode model (default: the `fast` tier), thought level, token budgets, per-call timeout |
| `review.jev.apiKey` | absent | A non-blank key enables Jev pre-screening ahead of ZCode `fast` + `review.thought` (default `low`); absent or all-whitespace keeps the original ZCode chain |
| `environment` / `sensitive` | `[]` | Extra facts and sensitive locations shown to ZCode review calls (not sent to Jev) |

### Optional: enable Jev pre-screening

[Jev](https://docs.typesafe.ai/introduction) is TypeSafe's structured decision model: it returns probabilities rather than explanations. It **does not execute tasks or replace the original ZCode fast screen**. It only tries to pass actions early when the evidence is sufficient:

```text
After hard-rule and allow_once checks
  → Jev pre-screen: pass early, otherwise continue
  → ZCode fast screen (default fast + low): pass, otherwise continue
  → ZCode slow review: allow or ask a human
```

- Five risk checks cover task-boundary conflicts, writes outside the workspace, credential exposure or sensitive-data exfiltration, destructive/external side effects, and unrelated actions. The current model is pinned to `jev-1.13.0`; all five probabilities must be at most `0.20` for early approval. This is a screening threshold, not a safety guarantee.
- Write/Edit/MultiEdit bodies are not sent to Jev; these actions currently skip pre-screening locally. Missing intent, truncated required input, or credentials that cannot be reliably redacted also cause a local skip, with **no Jev HTTP request**. Command complexity alone is not a reason to skip.
- Jev flags, timeouts, network errors, and invalid responses go to the original ZCode fast screen—not directly to denial or mandatory slow review. A failed ZCode fast-screen call still asks a human.
- Early passes can save subsequent review calls; other requests add serial latency. Jev currently has a 10-second total budget, separate from ZCode's `review.timeoutMs`. Actual speed and cost benefits depend on the pass rate.

#### 1. Configure the API key

Obtain your own API key from [TypeSafe](https://typesafe.ai/) (see the [official quick start](https://docs.typesafe.ai/introduction/quickstart)). It is separate from your ZCode provider key; do not edit ZCode App's configuration for this.

Edit `~/.zcode-executor/config.json`. **Merge the `review.jev` field into your existing configuration; keep allowedRoots, provider settings, and other fields rather than replacing the whole file.** If you set `ZCODE_EXECUTOR_HOME`, edit `config.json` in that directory instead.

Never put a real key in a command argument, shell environment, checked-in example, issue, or log. The value below is only a placeholder; real keys need not use that prefix:

```json
{
  "review": {
    "jev": {
      "apiKey": "jev_REPLACE_WITH_YOUR_KEY"
    }
  }
}
```

#### 2. Protect the configuration file

The file must already exist. Restrict its permissions (adjust the path if you use a custom configuration directory):

```bash
chmod 600 ~/.zcode-executor/config.json
```

When `review.jev.apiKey` is set, `config.json` must be a regular, non-symlink file owned by the current UID and accessible only by that owner (`0600` or stricter). Otherwise zcode-executor refuses to load it. There is no environment-variable fallback and no Jev mode or shadow setting. Remove `apiKey` (or leave it all-whitespace) to use only the original ZCode review chain. Setting `review.enabled` to `false` disables **all** model review, including Jev; hard rules still apply and other permission requests wait for a human.

#### 3. Verify configuration and activation

```bash
zcode-executor doctor --json
```

With review enabled and a key configured, the output should include:

```json
"review": {
  "enabled": true,
  "fastScreen": "jev",
  "jevConfigured": true,
  "pipeline": ["jev", "zcode-fast", "zcode-slow"]
}
```

`doctor` does not call Jev. It confirms configuration and the selected chain, **not TypeSafe key validity, account credit, or network connectivity**. This excerpt is part of the full JSON response; `fastScreen` is a compatibility field, not an indication that ZCode's fast screen was replaced.

Newly started runners read the configuration; existing runners do not hot-reload it. Let the current runner exit before sending another turn to pick up changes. Actual approvals record `pass / flag / error / skip` and filtered diagnostics in `executor.gate.preScreen`, never the key or full Jev state.

**To disable only Jev:** remove `review.jev.apiKey`, keeping the original ZCode fast and slow review chain. Do not use `review.enabled:false` for this—it disables all model review.

## Safety model

- **Hard rules** are code constants, never configuration: any path-bearing tool writing outside the worktree stops for a human. The rule table follows the categories of Claude Code's auto mode (credentials, exfiltration, destructive git, deletion, supply chain, persistence, deploys, shared resources, external writes).
- **The reviewers never deny.** Their only final outputs are *allow* and *ask*. Jev flag/error/skip returns to the ZCode fast screen, then slow review if needed. A ZCode fast-call failure still asks a human.
- **Allow only when allowed.** Automatic approval and `approve` both require an `allow_once` option; there is no "always allow".
- **Secrets are tightly scoped.** ZCode's provider key still goes only to the app-server path. The optional Jev key is the one deliberate persistent secret: it lives only in owner-protected `config.json`, is sent only as Jev authorization, and is never copied to events, pending state, runner logs or the app-server process.
- **Answers are bound to requests.** Every `approve`/`deny`/`answer` carries the request id; stale answers are discarded.

## Development

```bash
npm test          # 303 cases against a scripted mock app-server, plus a doc-version drift check; no tokens spent
node --check lib/**/*.mjs
```

Releases are tag-driven: `npm version patch` bumps `package.json`, syncs the version into both READMEs and both plugin manifests, and commits and tags; `git push --follow-tags` triggers the workflow that runs the tests, publishes to npm (Trusted Publishing, no token) and creates the GitHub Release. Commit messages are the changelog.

Pure `.mjs`, zero runtime dependencies, no build step. Design documents live in `docs/`: [PRD](docs/PRD.md), [SPEC](docs/SPEC.md), [CONTEXT](docs/CONTEXT.md) (glossary), [RULES](docs/RULES.md) (coding rules), [decisions](docs/decisions.md), [verified](docs/verified.md) (facts measured against the real app-server). Agent-facing entry point: [AGENTS.md](AGENTS.md).

## FAQ

**Does it work with agents other than ZCode?** No, by design. The executor side is ZCode only; the planning side can be Claude Code, Codex or anything that runs a shell.

**Why not just let Claude edit the code?** Cost and isolation. ZCode's GLM coding plan is credit-based and far cheaper than frontier-model tokens (inside ZCode it is billed at a 67% discount, with a free off-peak quota on top), and the worktree keeps two agents from editing the same files.

**How much does a task cost?** Measured in tokens, a one-file change is roughly 30–65k input on ZCode's side (its system prompt is heavy); the review adds about 5k input and 2 seconds per fast screen. Billed against the coding plan's credits at ZCode's discounted rate, that is a small fraction of doing the same edit with a frontier model.

**What if Jev cannot decide?** Flag, timeout, error or invalid response returns to the original ZCode fast screen. A non-passing or unparseable fast result goes to slow review; a failed fast call asks you directly (exit code 5).

Jev is skipped locally, with no HTTP request, when action bodies are omitted, intent is missing, or required input is truncated. Command complexity alone is not a reason to skip or reject.

`doctor --json` reports `review.pipeline`: `['jev','zcode-fast','zcode-slow']` with a key, the last two without one, `[]` when disabled, and `null` on configuration failure. The legacy `fastScreen` field does not mean Jev replaces ZCode.

## License

Apache-2.0. Ported code keeps its original notices; see [NOTICE](NOTICE).
