<p align="center">
  <img src="assets/logo.png" alt="nightshift" width="200" />
</p>

<h1 align="center">nightshift</h1>

<p align="center">
  Autonomous overnight development loop for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>. Sleep while your codebase ships.
</p>

Nightshift runs Claude Code in a structured loop: **plan a task → execute it → verify quality → commit or reject**. Each iteration does one unit of work. Wake up to a branch with CI-green commits.

## Quick Start

```bash
npm i -g @aster2709/nightshift
cd your-project
nightshift init    # interactive setup
nightshift run     # start the loop
nightshift status  # check progress
```

**Only dependency:** Claude Code CLI installed and authenticated.

## How It Works

```
nightshift init
  ├── detect project (Node, Python, Rust, Go)
  ├── select mode (features / improve / both / custom)
  ├── decompose guidance into work queue
  ├── configure eval gate (tests, typecheck, lint)
  └── discovery pass → codebase.md

nightshift run
  ┌─────────────────────────────────────────┐
  │  for each iteration:                    │
  │                                         │
  │  1. PLAN    (Sonnet — pick one task)    │
  │     ↓       validate against mode,      │
  │             skip blocked/completed       │
  │                                         │
  │  2. EXECUTE (Opus — write code)         │
  │     ↓       single-task prompt,         │
  │             focused assignment           │
  │                                         │
  │  3. VERIFY  (evals + Sonnet review)     │
  │     ↓       shell evals first,          │
  │             then LLM evaluator gates    │
  │             mode match + quality         │
  │                                         │
  │  commit ← pass                          │
  │  reset  ← fail (retry or block task)    │
  └─────────────────────────────────────────┘
```

The orchestrator makes the decisions. The agent only executes.

## Modes

Strictly enforced through plan validation and LLM evaluator:

| Mode | Allowed | Not Allowed |
|---|---|---|
| **features** | New endpoints, modules, capabilities | Refactoring, bug fixes, test-only commits |
| **improve** | Bug fixes, optimization, refactoring, test coverage | New user-facing features or endpoints |
| **both** | Either — planner picks highest impact per iteration | |
| **custom** | Whatever your mission describes | |

## Work Queue

Provide steering guidance during init and nightshift decomposes it into discrete tasks:

```
? What should the agent work on?
> Build a REST API with auth and rate limiting

  1. Add user model and CRUD endpoints
  2. Add JWT auth middleware
  3. Add rate limiting middleware

? Accept this work queue? Yes
? After queue is done? Stop
```

The planner works through the queue in order, one task per iteration. When the queue is done:
- `stop` — run ends (default for queue runs)
- `autonomous` — planner explores the codebase and finds more work

No work queue? The planner operates fully autonomously from the start.

## Three-Phase Iteration

### Phase 1: Plan

A Sonnet call proposes one task. The orchestrator validates:
- Task matches the configured mode
- Task hasn't been completed or blocked
- Target files aren't in excluded directories

If validation fails, the planner retries (up to 3 attempts).

### Phase 2: Execute

Opus receives a **single-task assignment** — not "go explore and find work." The prompt includes the task, target files, codebase overview, constraints, and eval commands. The agent writes code and exits.

### Phase 3: Verify

1. **Shell evals** — your test/typecheck/lint commands run on the agent's changes
2. **LLM evaluator** — Sonnet reviews the diff against the task and mode, returns a verdict:
   - `commit` — ship it
   - `reject` — reset, planner retries with different approach
   - `block` — task is too large or impossible, skip permanently

## Circuit Breaker

Task-level, not counter-level:
- Same task fails 2x → blocked, planner skips it
- 3 different tasks fail consecutively → systemic issue, run stops
- Planner can't find work after 3 attempts → run stops
- All queue items done or blocked → run stops (or switches to autonomous)

## Eval Gate

An ordered array of shell commands that must all exit 0:

```json
{
  "eval": [
    "npm test",
    "npm run typecheck",
    "npm run lint"
  ]
}
```

First failure short-circuits. Error output is captured and fed to the planner for the next attempt.

Auto-detection supports: Node.js (npm/pnpm/yarn/bun), Python (pytest/mypy/ruff), Rust (cargo test/clippy), Go (go test/vet), and Makefile targets.

## Config

`.nightshift/config.json`:

| Field | Default | Description |
|---|---|---|
| `mode` | `features` | Agent mode: features, improve, both, custom |
| `eval` | `[]` | Shell commands for the quality gate |
| `branch` | `nightshift/dev` | Git branch to work on |
| `maxIterations` | `20` | Max iterations per run |
| `maxConsecutiveFailures` | `3` | Circuit breaker threshold |
| `timeout` | `900` | Seconds per iteration |
| `model` | `claude-opus-4-6` | Executor model |
| `plannerModel` | `claude-sonnet-4-6` | Planner model |
| `evaluatorModel` | `claude-sonnet-4-6` | Evaluator model |
| `workQueue` | `[]` | Structured task list |
| `afterQueue` | `autonomous` | What to do when queue is done |
| `constraints` | `""` | What the agent should not touch |
| `exclude` | `[]` | Directories to exclude |

CLI overrides: `nightshift run --iterations 50 --timeout 1800 --branch nightshift/feature-x`

## State

Structured iteration tracking in `.nightshift/state.json` (gitignored):

```json
{
  "iteration": 5,
  "completed": [
    { "iteration": 1, "task": "Add user CRUD endpoints", "files": ["src/api/users.ts"], "category": "feature" }
  ],
  "failed": [
    { "iteration": 2, "task": "Add WebSocket notifications", "evalFailed": "npm test", "attempts": 2 }
  ],
  "blocked": [
    { "task": "Add WebSocket notifications", "reason": "eval failed 2x same error", "since": 4 }
  ]
}
```

The planner reads this to avoid repeating work and to skip blocked tasks. `nightshift status` reads it for the progress display.

## Commands

| Command | What It Does |
|---|---|
| `nightshift init` | Interactive setup: mode, work queue, evals, discovery |
| `nightshift run` | Start the autonomous loop |
| `nightshift status` | Show progress, queue status, blocked tasks |
| `nightshift logs` | Show iteration logs |
| `nightshift diff` | Show changes on the nightshift branch vs base |

## Tips

- **Start with 3-5 iterations** to calibrate, then scale up.
- **Use work queues** for specific deliverables. Use autonomous mode for open-ended improvement.
- **Run in tmux/screen** so it survives terminal disconnects.
- **Check `nightshift status`** for blocked tasks — they may need manual intervention or a constraint change.

## License

MIT
