# Nightshift Roadmap

## v0.1.0 (current)

Core loop: init, run, status, logs, diff. Bash orchestrator with eval gates, discovery pass, notes carry-forward, circuit breaker.

## v0.2.0 (next)

### Observability Dashboard
- `nightshift report` opens a local HTML dashboard
- Per-run detail: what changed, diff view, duration, pass/fail
- Sorting, search, filtering controls
- Timeline view of all iterations
- File change heatmap (which files were touched most)

### Review Gate (Supervisor LLM)
- Second `claude -p` call after eval passes, before commit
- Reads the diff + codebase.md, scores the work 0-100
- Score < threshold = reject (treat as failure, reset)
- Uses a cheaper/faster model (Sonnet) to minimize cost
- Configurable: `reviewGate: { enabled: true, threshold: 70, model: "claude-sonnet-4-6" }`

### Structured Agent Output
- Agent outputs a JSON plan before executing (what it will do, which files, estimated scope)
- Orchestrator validates the plan against the mode (features vs improve)
- Rejects plans that violate mode boundaries before any code is written

### State Machine
- Replace bash loop with a proper state machine: PLAN -> EXECUTE -> EVAL -> REVIEW -> COMMIT/REJECT
- Each state has clear inputs, outputs, and transition rules
- Enables retry at specific states instead of full reset

### Diff Analysis
- Heuristic check on the git diff before committing
- Detect: did the agent actually add a feature, or just move code around?
- Flag suspicious patterns: only whitespace changes, only comments added, only imports shuffled

## v0.3.0 (future)

### Multi-agent
- Parallel agents working on different parts of the codebase
- Conflict detection and resolution
- Shared notes.md with locking

### Remote Execution
- Run nightshift on a remote server / CI runner
- Push results to a branch, notify via webhook/Slack

### Analytics
- Historical run data across multiple sessions
- Trend analysis: is the agent getting better or worse over time?
- Cost tracking (token usage per iteration)
