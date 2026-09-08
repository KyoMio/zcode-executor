<h1 align="center">zcode-executor</h1>

<p align="center"><a href="./README.zh-CN.md">中文</a> · English</p>

<p align="center"><strong>Claude plans. ZCode codes. Git verifies.</strong></p>

<p align="center">A plugin for Claude Code (and Codex) that hands a well-specified development task to the local <a href="https://zcode.z.ai">ZCode</a> agent (GLM), runs it in an isolated git worktree, guards every write with a hard-rule check plus a model-based review, and lets you verify the result with <code>git diff</code> and tests instead of trusting the agent's own report.</p>

<p align="center"><img src="https://img.shields.io/badge/version-v0.1.0-5B4CF0" alt="v0.1.0"> <a href="https://www.npmjs.com/package/zcode-executor"><img src="https://img.shields.io/npm/v/zcode-executor?label=npm" alt="npm"></a> <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"> <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node"> <img src="https://img.shields.io/badge/tests-303%20passing-brightgreen" alt="Tests"></p>

## Why

Claude Code is good at thinking a task through. ZCode grinds out the code at a fraction of the cost. Left alone, either one will happily go off-script. This plugin puts the two in their places:

- **The task file is the contract.** Claude writes `tasks/T-xxx.md`; the message to ZCode is just a doorbell.
- **The worktree is the sandbox.** ZCode works in `~/.zcode-executor/worktrees/<repo>`, never in your main checkout.
- **The gate decides who gets asked.** Every tool call ZCode wants to make passes three stages: hard rules (writes outside the worktree always stop), a model review (fast screen, then a slow judgment), and finally a human if the model can't decide. The model can only *allow* or *ask*; it never *denies* on your behalf.
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
- **Safety layer** — automatic handling of ZCode's permission requests. Its logic follows Claude Code's *auto mode*: a fixed table of hard rules that nothing can override, then a **two-stage model review** (a cheap fast screen that answers Y/N, and a slow judgment with reasons only when the screen is unsure), and finally a human for anything the model cannot pass. The reviewer can *allow* or *ask*; it can never *deny* on your behalf.

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

- macOS or Linux. The ZCode app bundle is looked up where each platform puts it (`/Applications/…`, `/opt/ZCode/…`, `/usr/share/zcode/…`); installed anywhere else, point `ZCODE_BIN` at `zcode.cjs`. Windows is not supported yet: the test suite runs there in CI, but the app lookup and the process-group cleanup still assume a Unix layout.
- Node ≥ 22 (ZCode's app-server needs `node:sqlite`).
- ZCode desktop app installed and logged in (the CLI reads `~/.zcode/v2/config.json` read-only to push the provider registry; nothing is ever written back).

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
| `doctor [--json]` | Zero-token self-check: finds `zcode.cjs` (≥ 0.14.8), confirms the config exists, does one real handshake, reports the model tiers |
| `models [--json]` | Lists available models with thought levels, disabled reasons and tier assignment |
| `new --cwd <abs> [--title T] [--tier fast\|strong] [--thought L] [--deny "Tool…"] [--provider id] [--json]` | Registers a session (returns a local id `x_…`); the ZCode session is created on first `send` |
| `send <id> <text\|-> [--task file] [--wait] [--timeout s] [--steer] [--stream] [--json]` | Queues a message; `--wait` follows until done or blocked; `--task` is the task file the review uses as your authorization |
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
| `preferredProvider` | coding-plan providers first | Which provider to pick when the same model exists under several |
| `tiers` | auto by name | Override which model is `fast` / `strong` |
| `review` | `{enabled, model, thought:"low", fastMaxTokens:300, slowMaxTokens:2000, timeoutMs:60000}` | Model review: on/off, model (default: the `fast` tier), thought level, token budgets, per-call timeout |
| `environment` / `sensitive` | `[]` | Extra facts and sensitive locations shown to the reviewing model |

## Safety model

- **Hard rules** are code constants, never configuration: any path-bearing tool writing outside the worktree stops for a human. The rule table follows the categories of Claude Code's auto mode (credentials, exfiltration, destructive git, deletion, supply chain, persistence, deploys, shared resources, external writes).
- **The reviewer never denies.** Its only outputs are *allow* and *ask*. A failed, timed-out or unparseable review falls back to *ask*.
- **Allow only when allowed.** Automatic approval and `approve` both require an `allow_once` option; there is no "always allow".
- **Secrets stay in the pipe.** The API key read from ZCode's config goes only into the app-server's stdin; it is scrubbed from every log and never written to disk by this tool.
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

**What if the reviewer is wrong?** It can only over-ask, never over-allow: anything it cannot confidently pass lands in your lap as exit code 5.

## License

Apache-2.0. Ported code keeps its original notices; see [NOTICE](NOTICE).
