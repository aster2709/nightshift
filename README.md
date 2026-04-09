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
npm i -g nightshift-dev
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
        A[Detect project type] --> B[Ask mission, constraints, eval]
        B --> C[Generate program.md<br/><i>agent instructions</i>]
        C --> D[Discovery pass<br/><i>generates codebase.md</i>]
    end

    subgraph RUN ["nightshift run"]
        E[Preflight checks<br/><i>clean git, eval green, claude CLI</i>] --> F[Create branch<br/><i>nightshift/dev</i>]
        F --> G[Claude reads<br/>codebase.md + program.md + notes.md]
        G --> H[ONE unit of work]
        H --> I{Eval gate}
        I -->|PASS| J[Commit + log to notes.md]
        I -->|FAIL| K[Hard reset + log failure]
        J --> L{More iterations?}
        K --> M{Circuit breaker?}
        M -->|< 3 consecutive fails| L
        M -->|3 consecutive fails| N[Stop]
        L -->|Yes| G
        L -->|No| N
    end

    D --> E

    style INIT fill:#1a1a2e,stroke:#e94560,color:#fff
    style RUN fill:#1a1a2e,stroke:#e94560,color:#fff
    style I fill:#0f3460,stroke:#e94560,color:#fff
    style J fill:#1b4332,stroke:#2d6a4f,color:#fff
    style K fill:#641220,stroke:#a4161a,color:#fff
    style N fill:#0f3460,stroke:#e94560,color:#fff
```

### The loop in detail

```mermaid
graph LR
    subgraph EACH ["Each iteration"]
        direction TB
        P[Read codebase.md<br/><i>architecture, dependencies,<br/>danger zones</i>] --> Q[Read notes.md<br/><i>what previous iterations did</i>]
        Q --> R[Pick ONE task]
        R --> S[Implement]
        S --> T[Run eval commands<br/><i>in order, short-circuit on fail</i>]
        T -->|All pass| U[Write summary.txt]
        T -->|Any fail| V[Reset all changes<br/><i>preserve .nightshift/ state</i>]
    end

    style EACH fill:#1a1a2e,stroke:#e94560,color:#fff
    style U fill:#1b4332,stroke:#2d6a4f,color:#fff
    style V fill:#641220,stroke:#a4161a,color:#fff
```

## Init

`nightshift init` walks you through:

1. **Project detection** - scans for package.json, Cargo.toml, pyproject.toml, go.mod
2. **Mission** - what should the agent work on? (features, improvements, both, or custom)
3. **Constraints** - what should it NOT touch?
4. **Eval gate** - auto-detects test/typecheck/lint commands, you confirm or edit
5. **program.md generation** - uses Claude to generate tailored agent instructions

Creates `.nightshift/` with:
- `config.json` - your eval commands, branch, limits
- `program.md` - the agent's instruction set (you own this, edit freely)
- `codebase.md` - auto-generated codebase overview (generated on first run)
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

During `nightshift init`, after generating program.md, a discovery pass generates `.nightshift/codebase.md`. This is a structured, CTO-level overview of your codebase:

| Section | What It Captures |
|---|---|
| **Purpose** | What the project does, who it serves |
| **Architecture** | System map, major modules, data flow |
| **Dependency Map** | "If you change X, check Y" for every major module |
| **Key Patterns** | Error handling, validation, naming conventions |
| **Invariants** | Things that must never break (API contracts, security, schemas) |
| **Style Guide** | Observed formatting, test patterns, import order |
| **Danger Zones** | High blast-radius files and why they're dangerous |

Every iteration reads this before touching code. This prevents the #1 agent failure mode: changing a file without realizing 12 other files import from it.

If your project already has a `CLAUDE.md`, nightshift reads it as input but generates its own file focused on *understanding* (architecture, dependencies) rather than *instructions* (what to do).

## Key Design Decisions

**Discovery before work.** The agent maps the entire codebase before writing a single line. Like a CTO onboarding a new engineer: understand the system first, then change it.

**Bash loop, not Node loop.** The core orchestrator is a shell script. Zero runtime deps for a process that runs 8+ hours unattended.

**One unit of work per iteration.** Small, atomic, eval-gated commits. This is what makes 30+ commits overnight possible.

**Notes carry-forward.** Each iteration reads what previous ones did via notes.md. No memory system needed.

**Reset on failure, not fix on failure.** If eval fails, hard reset and try fresh. Prevents the agent from spiraling into patch-on-patch loops.

**No daemon, no server.** `nightshift run` is a foreground process. Run it in tmux/screen. Ctrl+C to stop.

## Tips

- **Review program.md before your first run.** It's the single biggest lever for quality.
- **Start with 5-10 iterations** to calibrate, then scale up.
- **Tighten constraints after the first run.** If the agent did low-impact work, add "focus on X, not Y" to program.md.
- **Run in tmux/screen** so it survives terminal disconnects.

## License

MIT
