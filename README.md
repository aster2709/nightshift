<p align="center">
  <img src="assets/logo.png" alt="nightshift" width="200" />
</p>

<h1 align="center">nightshift</h1>

<p align="center">
  Autonomous overnight development loop for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>. Sleep while your codebase ships.
</p>

Nightshift runs Claude in a headless loop. Each iteration: Claude picks one unit of work, completes it, and an eval gate (your tests, typecheck, lint) verifies quality. Pass = commit. Fail = reset and retry. Wake up to a branch with N CI-green commits.

## Quick Start

```bash
npm i -g nightshift
cd your-project
nightshift init    # interactive setup
nightshift run     # start the loop
nightshift status  # check progress
```

**Only dependency:** Claude Code CLI installed and authenticated.

## How It Works

```mermaid
graph TD
    subgraph INIT ["nightshift init"]
        A[Detect project type] --> B[Select mode + steering guidance]
        B --> C[Configure eval gate + constraints]
        C --> D[Generate program.md<br/><i>agent instructions</i>]
        D --> E[Discovery pass<br/><i>generates codebase.md</i>]
    end

    subgraph RUN ["nightshift run"]
        F[Preflight checks<br/><i>clean git, eval green, claude CLI</i>] --> G[Create branch<br/><i>nightshift/dev</i>]
        G --> H[Claude reads<br/>codebase.md + program.md + notes.md]
        H --> I[ONE unit of work]
        I --> J{Eval gate}
        J -->|PASS| K{Code changes?}
        K -->|Yes| L[Commit + log to notes.md]
        K -->|No| M[Failure: no-op]
        J -->|FAIL| N[Hard reset + log failure]
        L --> O{More iterations?}
        M --> P{Circuit breaker?}
        N --> P
        P -->|< 3 consecutive fails| O
        P -->|3 consecutive fails| Q[Stop]
        O -->|Yes| H
        O -->|No| Q
    end

    E --> F

    style INIT fill:#1a1a2e,stroke:#e94560,color:#fff
    style RUN fill:#1a1a2e,stroke:#e94560,color:#fff
    style J fill:#0f3460,stroke:#e94560,color:#fff
    style K fill:#0f3460,stroke:#e94560,color:#fff
    style L fill:#1b4332,stroke:#2d6a4f,color:#fff
    style M fill:#641220,stroke:#a4161a,color:#fff
    style N fill:#641220,stroke:#a4161a,color:#fff
    style Q fill:#0f3460,stroke:#e94560,color:#fff
```

## Modes

The agent operates in one of three modes, strictly enforced:

| Mode | What It Does | What It Does NOT Do |
|---|---|---|
| **Add Features** | New endpoints, modules, capabilities. Explores the codebase, finds what's missing, builds it. | No refactoring, no bug fixes, no test-only commits, no "improvements" |
| **Improve Codebase** | Fix bugs, optimize, harden error handling, add test coverage, refactor. | No new user-facing features or API endpoints |
| **Both** | Alternates. Each iteration picks whichever is higher impact. | |

The agent is **self-directed**. It reads the codebase, understands the architecture, and decides what to work on. There is no task list. You can optionally provide **steering guidance** ("focus on the API layer") as a starting direction, but the agent continues finding work autonomously when that area is covered.

## Init

`nightshift init` walks you through:

1. **Project detection** - scans for package.json, Cargo.toml, pyproject.toml, go.mod
2. **Mode** - add features, improve codebase, both, or custom
3. **Steering guidance** - optional hint for where to start (not a boundary)
4. **Constraints** - what should it NOT touch?
5. **Eval gate** - auto-detects test/typecheck/lint commands, you confirm or edit
6. **program.md generation** - uses Claude to generate tailored agent instructions
7. **Discovery pass** - Claude explores the entire codebase, generates `codebase.md`

Creates `.nightshift/` with:
- `config.json` - eval commands, branch, limits
- `program.md` - agent instruction set (you own this, edit freely)
- `codebase.md` - auto-generated codebase overview with architecture, dependency map, danger zones
- `notes.md` - cross-iteration context (managed by nightshift)
- `logs/` - per-iteration Claude output

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

Commands run in order. First failure short-circuits. The failing command is logged so the next iteration knows what went wrong.

Auto-detection supports: Node.js (npm/pnpm/yarn/bun), Python (pytest/mypy/ruff), Rust (cargo test/clippy), Go (go test/vet), and Makefile targets.

## Config

`.nightshift/config.json`:

| Field | Default | Description |
|---|---|---|
| `eval` | `[]` | Shell commands for the quality gate |
| `branch` | `nightshift/dev` | Git branch to work on |
| `maxIterations` | `20` | Max iterations per run |
| `maxConsecutiveFailures` | `3` | Circuit breaker threshold |
| `timeout` | `900` | Seconds per iteration (15 min) |
| `model` | `claude-opus-4-6` | Claude model to use |
| `exclude` | `[]` | Directories to exclude |

CLI overrides: `nightshift run --iterations 50 --timeout 1800 --branch nightshift/feature-x`

## Discovery Pass

During `nightshift init`, a discovery pass generates `.nightshift/codebase.md`. This is a structured, CTO-level overview of your codebase:

| Section | What It Captures |
|---|---|
| **Purpose** | What the project does, who it serves |
| **Architecture** | System map, major modules, data flow |
| **Dependency Map** | "If you change X, check Y" for every major module |
| **Key Patterns** | Error handling, validation, naming conventions |
| **Invariants** | Things that must never break (API contracts, security, schemas) |
| **Style Guide** | Observed formatting, test patterns, import order |
| **Danger Zones** | High blast-radius files and why they're dangerous |

Every iteration reads this before touching code. This prevents the #1 agent failure mode: changing a file without realizing other files depend on it.

If your project already has a `CLAUDE.md`, nightshift reads it as input but generates its own file focused on *understanding* (architecture, dependencies) rather than *instructions* (what to do).

## Key Design Decisions

**Self-directed agent.** The agent decides what to work on by exploring the codebase. No task list needed. Steering guidance is optional and treated as a starting hint, not a boundary.

**Strict mode enforcement.** "Add features" means only features. "Improve" means only fixes and optimizations. The modes don't bleed into each other.

**Discovery before work.** The agent maps the entire codebase before writing a single line. Like onboarding a new engineer: understand the system first, then change it.

**No-op is failure.** If the agent exits without code changes, it counts toward the circuit breaker. There is always work to do.

**Reset on failure, not fix on failure.** If eval fails, hard reset and try fresh. Prevents the agent from spiraling into patch-on-patch loops.

**Notes carry-forward.** Each iteration reads what previous ones did via notes.md. The agent builds on the trajectory, not from scratch.

**No daemon, no server.** `nightshift run` is a foreground process. Run it in tmux/screen. Ctrl+C to stop.

## Tips

- **Review program.md before your first run.** It's the single biggest lever for quality.
- **Start with 5-10 iterations** to calibrate, then scale up.
- **Tighten program.md after the first run.** If the agent did low-value work, add steering guidance.
- **Run in tmux/screen** so it survives terminal disconnects.

## License

MIT
