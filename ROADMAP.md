# Nightshift Roadmap

## v0.1.0 (current)

Core loop: init, run, status, logs, diff. Bash orchestrator with eval gates, discovery pass, notes carry-forward, circuit breaker.

## v0.2.0 — Architecture Reset

Separation of concerns: orchestrator plans, agent executes, verifier gates. Replaces the "dump markdown and hope Claude follows it" model with structured, deterministic control flow.

### 1. TypeScript Orchestrator (replace run.sh)

Rewrite the bash loop in TypeScript. Eliminates cross-platform hacks (perl timeout, node-based JSON parsing from bash, backup/restore dance). The loop, prompt building, state management, and git operations all move into TS.

- `src/orchestrator.ts` — main loop with plan/execute/verify phases
- `src/planner.ts` — task selection logic
- `src/executor.ts` — agent prompt builder + spawn
- `src/verifier.ts` — eval runner + LLM evaluator
- `src/git.ts` — commit, reset, diff helpers
- Kill `scripts/run.sh`

### 2. Structured State (replace notes.md as agent input)

`state.json` replaces notes.md for inter-iteration communication.

```json
{
  "iteration": 5,
  "completed": [
    { "iteration": 1, "task": "Add GET /api/users endpoint", "files": ["src/api/users.ts"], "category": "feature" }
  ],
  "failed": [
    { "iteration": 2, "task": "Add WebSocket notifications", "evalFailed": "npm test", "errorSnippet": "...", "attempts": 2 }
  ],
  "blocked": [
    { "task": "Add WebSocket notifications", "reason": "eval failed 2x same error", "since": 4 }
  ]
}
```

- Orchestrator writes it, planner reads it, agent never touches it
- notes.md stays as a human-readable log for `nightshift status` — no longer injected into prompts

### 3. Plan Phase (task selection before execution)

Sonnet/Haiku call before each iteration. Proposes ONE task:

```json
{
  "task": "Add pagination to GET /api/users",
  "targetFiles": ["src/api/users.ts"],
  "rationale": "Endpoint returns all rows, codebase uses cursor pattern in /api/posts",
  "category": "feature"
}
```

Orchestrator validates structurally before proceeding:
- Category matches mode (reject "feature" plan in improve mode)
- Task not in completed or blocked lists
- Target files not in excluded directories
- Not a near-duplicate of completed work

If validation fails → re-plan (up to 3 attempts). All 3 fail → fallback to autonomous mode for this iteration.

When a work queue exists, planner picks from the queue first. When queue is exhausted, behavior follows `afterQueue` config.

### 4. Single-Task Agent Prompt (kill program.md)

Agent receives a specific task assignment, not "go explore and find work":

```
TASK: [from planner]
CONTEXT: [codebase.md]
PATTERNS: [relevant files from planner's targetFiles]
CONSTRAINTS: [from config]
OUTPUT: .nightshift/iteration.json
```

One authority. No overlapping instructions from program.md + hardcoded RULES + notes.md.

Deletes: `program.md`, `program.template.md`, `build_prompt()`, meta-prompt in init.

### 5. Verify Phase (eval + LLM evaluator)

Three-step gate after agent finishes:

a) **Shell evals** — npm test, typecheck, lint. Fast, free. If fail → capture last 50 lines to state.json as failure context (planner reads this next iteration).

b) **LLM evaluator** (Sonnet) — reads diff + mode + task assignment. Outputs:
```json
{
  "verdict": "commit" | "reject" | "block",
  "modeMatch": true,
  "taskMatch": true,
  "reason": "..."
}
```

c) **Commit or reset** based on verdict. `"block"` = task added to blocked list, planner skips it.

Default-to-pass if evaluator fails to produce output. Warn loudly if evaluator fails 3+ consecutive times.

### 6. Work Queue in Init

Steering guidance decomposes into discrete tasks via Sonnet call during init:

```
? Steering guidance: Build a REST API with auth and rate limiting

  1. Add user model and CRUD endpoints
  2. Add JWT auth middleware
  3. Add rate limiting middleware

? Accept this work queue? (Y/n/edit)
```

Stored in config:
```json
{
  "workQueue": [
    { "task": "Add user model and CRUD endpoints", "status": "pending" },
    { "task": "Add JWT auth middleware", "status": "pending" }
  ],
  "afterQueue": "stop"
}
```

- `afterQueue: "stop"` (default for queue runs) — ends when queue done
- `afterQueue: "autonomous"` (default for no-queue runs) — planner explores freely
- New/empty repos: work queue is required, not optional

### 7. Task-Level Circuit Breaker

Replaces "3 consecutive failures = stop" with task-aware logic:
- Same task fails 2x → blocked, planner skips it
- 3 different tasks fail in a row → systemic issue, stop run
- All queue items completed or blocked → stop (or switch to autonomous)
- Planner can't find work after 3 attempts → stop

### Build Order

```
1 → 2 → 3 → 4 → 5 → 6 → 7
```

Each step is shippable. 1-2 are foundation. 3-4 are the core behavioral change. 5-7 are gates and polish.

## v0.3.0 (future)

### Multi-Agent
- Parallel agents working on different parts of the codebase
- Conflict detection and resolution
- Shared state.json with locking

### Remote Execution
- Run nightshift on a remote server / CI runner
- Push results to a branch, notify via webhook/Slack

### Pause/Resume with Notifications
- `afterQueue: "ask"` — run pauses, user gets notified
- Webhook/Slack integration for run completion
