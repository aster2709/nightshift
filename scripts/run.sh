#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Nightshift — Autonomous overnight development loop for Claude Code
#
# Runs Claude Code in a headless loop with eval gates. Each iteration:
#   1. Claude picks a unit of work and completes it
#   2. Eval commands (tests, typecheck, lint, etc.) verify correctness
#   3. If eval passes: commit. If eval fails: reset and retry.
#
# Usage:
#   nightshift run [project-dir]
#   ./scripts/run.sh [project-dir]
#
# Config: .nightshift/config.json in the project directory
# Docs:   .nightshift/program.md (injected into each Claude prompt)
# State:  .nightshift/notes.md (accumulated context across iterations)
# ============================================================================

# ── Resolve project directory ───────────────────────────────────────────────
PROJECT_DIR="${1:-.}"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
NIGHTSHIFT_DIR="$PROJECT_DIR/.nightshift"
LOG_DIR="$NIGHTSHIFT_DIR/logs"
CONFIG_FILE="$NIGHTSHIFT_DIR/config.json"

cd "$PROJECT_DIR"

# ── Config reader ───────────────────────────────────────────────────────────
# Uses node (guaranteed available since nightshift is an npm package) to parse
# JSON config. Reads the file path from an env var to avoid shell injection.
read_config() {
  local field="$1"
  local default="$2"
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "$default"
    return
  fi
  local value
  value=$(NIGHTSHIFT_CONFIG="$CONFIG_FILE" NIGHTSHIFT_FIELD="$field" node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.env.NIGHTSHIFT_CONFIG, 'utf8'));
      const v = c[process.env.NIGHTSHIFT_FIELD];
      if (v === undefined || v === null) process.stdout.write('');
      else if (Array.isArray(v)) process.stdout.write(JSON.stringify(v));
      else process.stdout.write(String(v));
    } catch(e) { process.stdout.write(''); }
  " 2>/dev/null) || true
  if [ -z "$value" ]; then
    echo "$default"
  else
    echo "$value"
  fi
}

# ── Load config ─────────────────────────────────────────────────────────────
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: Config file not found at $CONFIG_FILE"
  echo "Run 'nightshift init' to create a config, or create .nightshift/config.json manually."
  exit 1
fi

MAX_ITERATIONS="${MAX_ITERATIONS:-$(read_config maxIterations 20)}"
MAX_CONSECUTIVE_FAILURES="${MAX_CONSECUTIVE_FAILURES:-$(read_config maxConsecutiveFailures 3)}"
TIMEOUT="${TIMEOUT:-$(read_config timeout 900)}"
MODEL="${MODEL:-$(read_config model "claude-sonnet-4-20250514")}"
BRANCH="${NIGHTSHIFT_BRANCH:-$(read_config branch "nightshift/dev")}"

# Parse eval commands from config JSON into a bash array.
# Each command is printed on its own line, then read into the array.
# Uses a while-read loop instead of mapfile for bash 3.x (macOS default) compatibility.
declare -a EVAL_COMMANDS
while IFS= read -r line; do
  [ -n "$line" ] && EVAL_COMMANDS+=("$line")
done < <(NIGHTSHIFT_CONFIG="$CONFIG_FILE" node -e "
  try {
    const c = JSON.parse(require('fs').readFileSync(process.env.NIGHTSHIFT_CONFIG, 'utf8'));
    const cmds = c.eval || [];
    cmds.forEach(cmd => console.log(cmd));
  } catch(e) { /* empty output = no commands */ }
" 2>/dev/null)

if [ "${#EVAL_COMMANDS[@]}" -eq 0 ]; then
  echo "Error: No eval commands configured in $CONFIG_FILE"
  echo "Add an \"eval\" array with at least one command, e.g.:"
  echo '  { "eval": ["npm test", "npm run typecheck"] }'
  exit 1
fi

# ── State ──────────────────────────────────────────────────────────────────
iteration=0
successful_commits=0
consecutive_failures=0
start_time=$(date +%s)
source_branch=""

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# ── Helpers ────────────────────────────────────────────────────────────────
timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

elapsed_minutes() {
  local now
  now=$(date +%s)
  echo $(( (now - start_time) / 60 ))
}

log() {
  echo "[$(timestamp)] $*"
}

# Cross-platform timeout. macOS doesn't ship GNU timeout, so fall back to a
# perl one-liner that does the same thing (perl is always available on macOS).
if command -v timeout &>/dev/null; then
  run_with_timeout() { timeout "$@"; }
else
  run_with_timeout() {
    local secs="$1"; shift
    perl -e "
      alarm $secs;
      \$SIG{ALRM} = sub { kill 'TERM', \$pid; exit 124 };
      \$pid = fork();
      if (\$pid == 0) { exec @ARGV; die \"exec: \$!\" }
      waitpid(\$pid, 0);
      exit (\$? >> 8);
    " -- "$@"
  }
fi

# ── Reset helper ───────────────────────────────────────────────────────────
# Resets all working tree changes EXCEPT the .nightshift/ directory.
# Strategy: backup .nightshift/ -> hard reset -> restore .nightshift/
reset_changes() {
  local backup_dir="/tmp/nightshift_backup_$$"

  # Backup .nightshift state (notes, logs, config, program)
  rm -rf "$backup_dir"
  cp -r "$NIGHTSHIFT_DIR" "$backup_dir" 2>/dev/null || true

  # Reset working tree to last commit
  git checkout -- . 2>/dev/null || true
  git clean -fd 2>/dev/null || true

  # Restore .nightshift from backup
  if [ -d "$backup_dir" ]; then
    mkdir -p "$NIGHTSHIFT_DIR"
    cp -r "$backup_dir"/* "$NIGHTSHIFT_DIR/" 2>/dev/null || true
    rm -rf "$backup_dir"
  fi
}

# ── Run eval commands ──────────────────────────────────────────────────────
# Runs all eval commands in order, short-circuiting on first failure.
# Returns 0 if all pass, 1 on first failure.
# Sets FAILED_EVAL to the command that failed.
FAILED_EVAL=""

run_eval() {
  FAILED_EVAL=""
  local eval_log="$LOG_DIR/eval_tmp.log"
  for cmd in "${EVAL_COMMANDS[@]}"; do
    log "  eval: $cmd"
    if ! eval "$cmd" > "$eval_log" 2>&1; then
      FAILED_EVAL="$cmd"
      return 1
    fi
  done
  return 0
}

# ── Preflight checks ──────────────────────────────────────────────────────
log "Preflight checks..."

# 1. Clean git state (uncommitted changes to tracked files, untracked is fine)
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "FAIL: Git working tree has uncommitted changes to tracked files."
  log "Commit or stash your changes before running nightshift."
  exit 1
fi
log "  git state: clean"

# 2. Verify claude CLI exists
if ! command -v claude &>/dev/null; then
  log "FAIL: 'claude' CLI not found in PATH."
  log "Install Claude Code: https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi
log "  claude CLI: found"

# 3. Verify program.md exists
if [ ! -f "$NIGHTSHIFT_DIR/program.md" ]; then
  log "FAIL: $NIGHTSHIFT_DIR/program.md not found."
  log "Create a program.md with instructions for Claude (what to build, constraints, etc.)"
  exit 1
fi
log "  program.md: found"

# 4. Run all eval commands to verify they pass on current state
log "  running eval on current state..."
if ! run_eval; then
  log "FAIL: Eval command failed on current state: $FAILED_EVAL"
  log "Fix your project before running nightshift. Last 20 lines of output:"
  tail -20 "$LOG_DIR/eval_tmp.log" 2>/dev/null || true
  exit 1
fi
log "  eval: all passing"

# 5. Create or resume the configured branch
source_branch=$(git branch --show-current)

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  log "  branch $BRANCH exists, resuming..."
  git checkout "$BRANCH"
else
  git checkout -b "$BRANCH"
  log "  created branch: $BRANCH (from $source_branch)"
fi

# ── Print run config ──────────────────────────────────────────────────────
echo ""
echo "================================================================"
echo "  Nightshift starting"
echo "  Project:       $PROJECT_DIR"
echo "  Branch:        $BRANCH (from ${source_branch})"
echo "  Model:         $MODEL"
echo "  Max iters:     $MAX_ITERATIONS"
echo "  Circuit break: $MAX_CONSECUTIVE_FAILURES consecutive failures"
echo "  Timeout:       ${TIMEOUT}s per iteration"
echo "  Eval commands: ${#EVAL_COMMANDS[@]}"
for cmd in "${EVAL_COMMANDS[@]}"; do
  echo "    - $cmd"
done
echo "================================================================"
echo ""

# ── Discovery pass (iteration 0) ──────────────────────────────────────────
# Generates .nightshift/codebase.md if it doesn't exist. This gives every
# future iteration a CTO-level understanding of the codebase: architecture,
# dependency map, invariants, danger zones. Without this, agents change files
# without realizing what depends on them.
CODEBASE_FILE="$NIGHTSHIFT_DIR/codebase.md"

run_discovery() {
  log "Running discovery pass (iteration 0)..."
  echo "  Generating codebase overview so future iterations understand the system."
  echo ""

  # Build discovery prompt. If CLAUDE.md exists, feed it as input context.
  local discovery_prompt=""
  local claude_md_content=""

  # Find the discovery prompt template (shipped with the npm package)
  local script_dir
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  local template_path="$script_dir/../templates/discovery.prompt.md"

  if [ -f "$template_path" ]; then
    discovery_prompt=$(cat "$template_path")
  else
    # Inline fallback if template not found
    discovery_prompt="Explore this entire codebase and produce a structured markdown overview with these sections: ## Purpose, ## Architecture, ## Dependency Map (critical: what depends on what), ## Key Patterns, ## Invariants (things that must never break), ## Style Guide (observed conventions), ## Danger Zones (high blast-radius files). Read actual files, do not guess. Output only the markdown."
  fi

  if [ -f "$PROJECT_DIR/CLAUDE.md" ]; then
    claude_md_content=$(cat "$PROJECT_DIR/CLAUDE.md")
    discovery_prompt="$discovery_prompt

The project already has a CLAUDE.md with instructions/context. Use it as input but do NOT duplicate it.
Your codebase.md should focus on UNDERSTANDING (architecture, dependencies, invariants) not INSTRUCTIONS.

<existing-claude-md>
$claude_md_content
</existing-claude-md>"
  fi

  # Run Claude for discovery
  local discovery_log="$LOG_DIR/iteration_0_discovery.log"

  if run_with_timeout "$TIMEOUT" claude -p "$discovery_prompt" \
    --model "$MODEL" \
    --dangerously-skip-permissions \
    --output-format text \
    > "$discovery_log" 2>&1; then

    # Validate output is substantial
    local output_size
    output_size=$(wc -c < "$discovery_log" | tr -d ' ')

    if [ "$output_size" -gt 500 ]; then
      cp "$discovery_log" "$CODEBASE_FILE"
      log "  Discovery complete. Wrote codebase.md (${output_size} bytes)"
    else
      log "  WARNING: Discovery output too short (${output_size} bytes). Skipping codebase.md."
      log "  The agent will run without a codebase overview."
    fi
  else
    log "  WARNING: Discovery pass failed. The agent will run without a codebase overview."
  fi

  echo ""
}

if [ ! -f "$CODEBASE_FILE" ]; then
  run_discovery
else
  log "Codebase overview exists, skipping discovery."
fi

# ── Prompt builder ─────────────────────────────────────────────────────────
build_prompt() {
  local program_content=""
  local notes_content=""
  local codebase_content=""

  if [ -f "$NIGHTSHIFT_DIR/program.md" ]; then
    program_content=$(cat "$NIGHTSHIFT_DIR/program.md")
  fi

  if [ -f "$NIGHTSHIFT_DIR/notes.md" ]; then
    notes_content=$(cat "$NIGHTSHIFT_DIR/notes.md")
  fi

  if [ -f "$CODEBASE_FILE" ]; then
    codebase_content=$(cat "$CODEBASE_FILE")
  fi

  cat <<PROMPT
You are running inside Nightshift, an autonomous development loop. Complete ONE unit of work and exit.

<codebase-overview>
$codebase_content
</codebase-overview>

<program>
$program_content
</program>

<previous-iterations>
$notes_content
</previous-iterations>

This is iteration $((iteration + 1)) of $MAX_ITERATIONS. Pick ONE task, complete it fully, then exit.

IMPORTANT: Read the <codebase-overview> carefully before making changes. It maps which modules
depend on which. If you change a shared file, check all its dependents. Do not break what is working.

When done, write a single-line summary of what you did to .nightshift/summary.txt (overwrite the file).
Do NOT write to .nightshift/notes.md, the orchestrator manages that file.
PROMPT
}

# ── Main loop ──────────────────────────────────────────────────────────────
log "Starting loop (max $MAX_ITERATIONS iterations, Ctrl+C to stop)"
echo ""

while [ "$iteration" -lt "$MAX_ITERATIONS" ]; do
  iteration=$((iteration + 1))
  iter_start=$(date +%s)

  echo "----------------------------------------------------------------"
  echo "  Iteration $iteration / $MAX_ITERATIONS"
  echo "  Elapsed: $(elapsed_minutes)m | Commits: $successful_commits | Consecutive fails: $consecutive_failures"
  echo "----------------------------------------------------------------"

  # Clear stale summary from previous iteration
  rm -f "$NIGHTSHIFT_DIR/summary.txt"

  # Build the prompt
  prompt=$(build_prompt)

  # Run Claude in headless mode with timeout
  log "Running Claude ($MODEL)..."
  iter_log="$LOG_DIR/iteration_${iteration}.log"

  if run_with_timeout "$TIMEOUT" claude -p "$prompt" \
    --model "$MODEL" \
    --dangerously-skip-permissions \
    --output-format text \
    > "$iter_log" 2>&1; then
    agent_exit=0
  else
    agent_exit=$?
  fi

  iter_end=$(date +%s)
  iter_duration=$(( iter_end - iter_start ))
  log "Claude finished in ${iter_duration}s (exit code: $agent_exit)"

  # ── Handle agent crash or timeout ──────────────────────────────────────
  if [ "$agent_exit" -ne 0 ]; then
    if [ "$agent_exit" -eq 124 ]; then
      log "  TIMEOUT: Claude exceeded ${TIMEOUT}s limit"
    else
      log "  CRASH: Claude exited with code $agent_exit"
    fi

    reset_changes
    consecutive_failures=$((consecutive_failures + 1))

    if [ "$agent_exit" -eq 124 ]; then
      echo "- **Iteration $iteration** ($(date '+%H:%M')): FAILED, agent timed out after ${TIMEOUT}s" >> "$NIGHTSHIFT_DIR/notes.md"
    else
      echo "- **Iteration $iteration** ($(date '+%H:%M')): FAILED, agent crashed (exit $agent_exit)" >> "$NIGHTSHIFT_DIR/notes.md"
    fi

    if [ "$consecutive_failures" -ge "$MAX_CONSECUTIVE_FAILURES" ]; then
      log "CIRCUIT BREAKER: $MAX_CONSECUTIVE_FAILURES consecutive failures. Stopping."
      break
    fi

    log "  Retrying... ($consecutive_failures/$MAX_CONSECUTIVE_FAILURES failures)"
    echo ""
    continue
  fi

  # ── Eval gate ──────────────────────────────────────────────────────────
  log "Running eval gate..."

  if run_eval; then
    # ── SUCCESS: commit ────────────────────────────────────────────────
    summary="no summary provided"
    if [ -f "$NIGHTSHIFT_DIR/summary.txt" ]; then
      summary=$(head -1 "$NIGHTSHIFT_DIR/summary.txt")
    fi

    # Check if there are actually any code changes to commit
    git add -A
    git reset -- "$LOG_DIR"/*.log > /dev/null 2>&1 || true

    if git diff --cached --quiet; then
      # No changes — agent failed to produce work. Treat as failure.
      log "  NO CHANGES: agent produced no code changes. Treating as failure."
      echo "- **Iteration $iteration** ($(date '+%H:%M')): FAILED, no code changes produced" >> "$NIGHTSHIFT_DIR/notes.md"
      consecutive_failures=$((consecutive_failures + 1))

      if [ "$consecutive_failures" -ge "$MAX_CONSECUTIVE_FAILURES" ]; then
        log "CIRCUIT BREAKER: $MAX_CONSECUTIVE_FAILURES consecutive failures. Stopping."
        break
      fi
    else
      # Append to notes BEFORE commit so notes are included in the commit
      echo "- **Iteration $iteration** ($(date '+%H:%M')): $summary" >> "$NIGHTSHIFT_DIR/notes.md"
      git add "$NIGHTSHIFT_DIR/notes.md"
      git commit -m "nightshift($iteration): $summary" --no-verify 2>/dev/null || true

      consecutive_failures=0
      successful_commits=$((successful_commits + 1))
      log "  COMMITTED: $summary"
    fi

  else
    # ── FAILURE: reset ─────────────────────────────────────────────────
    log "  EVAL FAILED: $FAILED_EVAL"

    # Preserve eval failure details in the iteration log before reset nukes it.
    # Copy to a temp location outside the working tree first.
    local_eval_log="/tmp/nightshift_eval_$$_${iteration}.log"
    local_iter_log="/tmp/nightshift_iter_$$_${iteration}.log"

    cp "$iter_log" "$local_iter_log" 2>/dev/null || true
    if [ -f "$LOG_DIR/eval_tmp.log" ]; then
      {
        echo ""
        echo "=== EVAL FAILURE: $FAILED_EVAL ==="
        cat "$LOG_DIR/eval_tmp.log"
      } >> "$local_iter_log" 2>/dev/null || true
    fi

    reset_changes
    consecutive_failures=$((consecutive_failures + 1))

    # Restore the iteration log with eval output appended
    mkdir -p "$LOG_DIR"
    mv "$local_iter_log" "$iter_log" 2>/dev/null || true
    rm -f "$local_eval_log" 2>/dev/null || true

    echo "- **Iteration $iteration** ($(date '+%H:%M')): FAILED eval (\`$FAILED_EVAL\`), reset" >> "$NIGHTSHIFT_DIR/notes.md"

    if [ "$consecutive_failures" -ge "$MAX_CONSECUTIVE_FAILURES" ]; then
      log "CIRCUIT BREAKER: $MAX_CONSECUTIVE_FAILURES consecutive failures. Stopping."
      break
    fi

    log "  Retrying... ($consecutive_failures/$MAX_CONSECUTIVE_FAILURES failures)"
  fi

  echo ""
done

# ── Clean up temp files ────────────────────────────────────────────────────
rm -f "$LOG_DIR/eval_tmp.log"
rm -f /tmp/nightshift_eval_$$_*.log /tmp/nightshift_iter_$$_*.log 2>/dev/null || true

# ── End summary ────────────────────────────────────────────────────────────
end_time=$(date +%s)
total_duration=$(( (end_time - start_time) / 60 ))
total_hours=$(( total_duration / 60 ))
total_mins=$(( total_duration % 60 ))

echo ""
echo "================================================================"
echo "  Nightshift complete"
echo ""
echo "  Iterations:  $iteration"
echo "  Commits:     $successful_commits"
echo "  Duration:    ${total_hours}h ${total_mins}m"
echo "  Branch:      $BRANCH"
echo ""
echo "  Review your changes:"
echo "    git log --oneline ${source_branch}..${BRANCH}"
echo "    cat .nightshift/notes.md"
echo ""
echo "  Merge when ready:"
echo "    git checkout ${source_branch} && git merge ${BRANCH}"
echo "================================================================"
