import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import pc from 'picocolors'
import type { NightshiftConfig } from './config.js'
import { NIGHTSHIFT_DIR, isV2Config } from './config.js'
import type { RunState, TaskPlan, IterationOutcome } from './types.js'
import { loadState, saveState, createState, applyOutcome } from './state.js'
import { planTask, isQueueExhausted, markQueueItemDone, markQueueItemBlocked } from './planner.js'
import { executeTask, cleanIterationArtifacts } from './executor.js'
import { runEvals, evaluateChanges } from './verifier.js'
import * as git from './git.js'
import { runClaude } from './claude.js'

// ── Logging ──────────────────────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false })
}

function log(msg: string): void {
  console.log(`[${timestamp()}] ${msg}`)
}

// ── Notes (human-readable log, not used by agents) ──────────────────────────

function appendNotes(cwd: string, iteration: number, result: IterationOutcome): void {
  const notesPath = path.join(cwd, NIGHTSHIFT_DIR, 'notes.md')
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })

  let line: string
  switch (result.outcome) {
    case 'commit':
      line = `- **Iteration ${iteration}** (${time}): ${result.summary}`
      break
    case 'reject':
      line = `- **Iteration ${iteration}** (${time}): FAILED — ${result.reason}`
      break
    case 'block':
      line = `- **Iteration ${iteration}** (${time}): BLOCKED — ${result.plan.task}: ${result.reason}`
      break
    case 'no-op':
      line = `- **Iteration ${iteration}** (${time}): NO-OP — ${result.reason}`
      break
    case 'crash':
      line = `- **Iteration ${iteration}** (${time}): CRASH — exit code ${result.exitCode}`
      break
    case 'timeout':
      line = `- **Iteration ${iteration}** (${time}): TIMEOUT`
      break
    case 'no-work':
      line = `- **Iteration ${iteration}** (${time}): NO WORK — ${result.reason}`
      break
  }

  fs.appendFileSync(notesPath, line + '\n', 'utf-8')
}

// ── Discovery ────────────────────────────────────────────────────────────────

async function ensureDiscovery(config: NightshiftConfig, cwd: string): Promise<void> {
  const codebasePath = path.join(cwd, NIGHTSHIFT_DIR, 'codebase.md')
  if (fs.existsSync(codebasePath)) {
    log('Codebase overview exists, skipping discovery.')
    return
  }

  log('Running discovery pass...')

  // Load discovery prompt template
  const templateCandidates = [
    path.join(cwd, 'node_modules', '@aster2709', 'nightshift', 'templates', 'discovery.prompt.md'),
    path.resolve(new URL('../templates/discovery.prompt.md', import.meta.url).pathname),
  ]

  let discoveryPrompt = 'Explore this entire codebase and produce a structured markdown overview with these sections: ## Purpose, ## Architecture, ## Dependency Map, ## Key Patterns, ## Invariants, ## Style Guide, ## Danger Zones. Read actual files, do not guess. Output only the markdown.'

  for (const candidate of templateCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        discoveryPrompt = fs.readFileSync(candidate, 'utf-8')
        break
      }
    } catch { continue }
  }

  // Append CLAUDE.md context if it exists
  const claudeMdPath = path.join(cwd, 'CLAUDE.md')
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, 'utf-8')
    discoveryPrompt += `\n\nThe project has a CLAUDE.md. Use it as input but do NOT duplicate it.\n\n<existing-claude-md>\n${content}\n</existing-claude-md>`
  }

  const result = await runClaude({
    prompt: discoveryPrompt,
    model: config.model,
    cwd,
    timeout: 180_000,
    skipPermissions: true,
  })

  // The agent may have written codebase.md directly via tools.
  // If so, prefer that over stdout (which is often just a summary message).
  if (fs.existsSync(codebasePath)) {
    const existing = fs.readFileSync(codebasePath, 'utf-8')
    if (existing.length > 500) {
      log(`  Discovery complete (${(existing.length / 1024).toFixed(1)}KB)`)
      return
    }
  }

  // Fallback: use stdout if the agent didn't write the file itself
  if (result.exitCode === 0 && result.output.length > 500) {
    fs.writeFileSync(codebasePath, result.output + '\n', 'utf-8')
    log(`  Discovery complete (${(result.output.length / 1024).toFixed(1)}KB)`)
  } else {
    log('  Discovery failed. Agent will run without codebase overview.')
  }
}

// ── Preflight ────────────────────────────────────────────────────────────────

function preflight(config: NightshiftConfig, cwd: string): void {
  log('Preflight checks...')

  // v0.2.0 config required
  if (!isV2Config(config)) {
    console.error(pc.red('Config is from v0.1.0. Run `nightshift init` to upgrade.'))
    process.exit(1)
  }

  // Clean git state
  if (!git.isClean(cwd)) {
    console.error(pc.red('Git working tree has uncommitted changes. Commit or stash first.'))
    process.exit(1)
  }
  log('  git state: clean')

  // Claude CLI exists
  try {
    execSync('command -v claude', { stdio: 'pipe' })
  } catch {
    console.error(pc.red("'claude' CLI not found in PATH."))
    process.exit(1)
  }
  log('  claude CLI: found')

  // Eval commands pass on current state
  if (config.eval.length > 0) {
    log('  running eval on current state...')
    for (const cmd of config.eval) {
      try {
        execSync(cmd, { cwd, stdio: 'pipe', timeout: 120_000 })
      } catch {
        console.error(pc.red(`Eval command failed on current state: ${cmd}`))
        console.error('Fix your project before running nightshift.')
        process.exit(1)
      }
    }
    log('  eval: all passing')
  }
}

// ── Single Iteration ─────────────────────────────────────────────────────────

async function runIteration(
  config: NightshiftConfig,
  state: RunState,
  cwd: string,
): Promise<IterationOutcome> {

  // Clean up artifacts from previous iteration
  cleanIterationArtifacts(cwd)

  // ── Phase 1: Plan ──────────────────────────────────────────────────────
  log('Phase 1: Planning...')
  const plan = await planTask(config, state, cwd)

  if (!plan) {
    return { outcome: 'no-work', reason: 'planner could not find a viable task' }
  }

  log(`  Task: ${plan.task}`)
  log(`  Category: ${plan.category}`)
  log(`  Target: ${plan.targetFiles.join(', ')}`)

  // ── Phase 2: Execute ───────────────────────────────────────────────────
  log('Phase 2: Executing...')
  const execResult = await executeTask(plan, config, state, cwd)

  if (execResult.timedOut) {
    git.resetAll(cwd)
    return { outcome: 'timeout', plan }
  }

  if (execResult.exitCode !== 0) {
    git.resetAll(cwd)
    return { outcome: 'crash', plan, exitCode: execResult.exitCode }
  }

  // Check for actual changes
  if (!git.hasChanges(cwd)) {
    return { outcome: 'no-op', plan, reason: 'agent produced no code changes' }
  }

  // ── Phase 3: Verify ────────────────────────────────────────────────────
  log('Phase 3: Verifying...')

  // 3a: Shell evals
  if (config.eval.length > 0) {
    log('  Running eval commands...')
    const evalResult = await runEvals(config.eval, cwd)

    if (!evalResult.passed) {
      log(`  Eval FAILED: ${evalResult.failedCommand}`)
      const errorSnippet = evalResult.errorSnippet?.slice(0, 500)
      git.resetAll(cwd)
      return {
        outcome: 'reject',
        plan,
        reason: `eval failed: ${evalResult.failedCommand}`,
        evalFailed: evalResult.failedCommand,
        errorSnippet,
      }
    }
    log('  Evals passed')
  }

  // Stage changes for diff
  git.stageAll(cwd, ['.nightshift/logs/*', '.nightshift/state.json', '.nightshift/iteration.json'])

  if (!git.hasStagedChanges(cwd)) {
    return { outcome: 'no-op', plan, reason: 'no staged changes after filtering' }
  }

  const diff = git.getStagedDiff(cwd)
  const changedFiles = git.getStagedFiles(cwd)

  // 3b: LLM evaluator
  log('  Running LLM evaluator...')
  const verdict = await evaluateChanges(plan, diff, config, cwd)
  log(`  Verdict: ${verdict.verdict} — ${verdict.reason}`)

  if (verdict.verdict === 'commit') {
    // Commit
    const summary = execResult.iterationOutput?.summary ?? plan.task
    const files = execResult.iterationOutput?.filesChanged ?? changedFiles

    // Append to notes before commit so it's included
    const noteResult: IterationOutcome = { outcome: 'commit', plan, summary, filesChanged: files }
    appendNotes(cwd, state.iteration, noteResult)

    // Stage notes
    const notesPath = path.join(cwd, NIGHTSHIFT_DIR, 'notes.md')
    try { execSync(`git add "${notesPath}"`, { cwd, stdio: 'pipe' }) } catch {}

    git.commit(`nightshift(${state.iteration}): ${summary}`, cwd)
    log(`  COMMITTED: ${summary}`)

    return { outcome: 'commit', plan, summary, filesChanged: files }
  }

  // Reject or block — reset
  git.resetAll(cwd)

  if (verdict.verdict === 'block') {
    return { outcome: 'block', plan, reason: verdict.reason }
  }

  return { outcome: 'reject', plan, reason: verdict.reason }
}

// ── Main Loop ────────────────────────────────────────────────────────────────

export async function orchestrate(config: NightshiftConfig, cwd: string): Promise<void> {
  // Preflight
  preflight(config, cwd)

  // Setup branch
  const sourceBranch = git.currentBranch(cwd)
  if (git.branchExists(config.branch, cwd)) {
    log(`Branch ${config.branch} exists, resuming...`)
    git.checkoutBranch(config.branch, cwd)
  } else {
    git.createBranch(config.branch, cwd)
    log(`Created branch: ${config.branch} (from ${sourceBranch})`)
  }

  // Ensure discovery
  await ensureDiscovery(config, cwd)

  // Load or create state
  let state = loadState(cwd)

  // Initialize notes if needed
  const notesPath = path.join(cwd, NIGHTSHIFT_DIR, 'notes.md')
  if (!fs.existsSync(notesPath)) {
    fs.writeFileSync(notesPath, '# Nightshift Notes\n', 'utf-8')
  }

  // Print run config
  const hasQueue = config.workQueue.length > 0
  console.log()
  console.log('================================================================')
  console.log('  Nightshift v0.2.0 starting')
  console.log()
  console.log(`  Branch:        ${config.branch} (from ${sourceBranch})`)
  console.log(`  Mode:          ${config.mode}`)
  console.log(`  Model:         ${config.model}`)
  console.log(`  Planner:       ${config.plannerModel}`)
  console.log(`  Evaluator:     ${config.evaluatorModel}`)
  console.log(`  Max iters:     ${config.maxIterations}`)
  console.log(`  Timeout:       ${config.timeout}s per iteration`)
  if (hasQueue) {
    console.log(`  Work queue:    ${config.workQueue.length} items`)
    console.log(`  After queue:   ${config.afterQueue}`)
  } else {
    console.log(`  Work queue:    none (autonomous)`)
  }
  console.log(`  Eval commands: ${config.eval.length}`)
  for (const cmd of config.eval) {
    console.log(`    - ${cmd}`)
  }
  console.log('================================================================')
  console.log()

  // Main loop
  const startTime = Date.now()
  let consecutiveFailures = 0
  let noWorkAttempts = 0

  while (state.iteration < config.maxIterations) {
    state.iteration++
    const iterStart = Date.now()

    console.log('----------------------------------------------------------------')
    console.log(`  Iteration ${state.iteration} / ${config.maxIterations}`)
    console.log(`  Commits: ${state.completed.length} | Failed: ${state.failed.length} | Blocked: ${state.blocked.length}`)
    console.log('----------------------------------------------------------------')

    // Check if work queue is exhausted
    if (hasQueue && isQueueExhausted(config, state)) {
      if (config.afterQueue === 'stop') {
        log('Work queue completed. Stopping.')
        break
      }
      log('Work queue completed. Switching to autonomous mode.')
    }

    // Run iteration
    const result = await runIteration(config, state, cwd)
    const iterDuration = Math.round((Date.now() - iterStart) / 1000)

    // Apply result to state
    applyOutcome(state, result)

    // Handle queue progress
    if (result.outcome === 'commit' && result.plan) {
      markQueueItemDone(config, state, result.plan.task)
      consecutiveFailures = 0
      noWorkAttempts = 0
    } else if (result.outcome === 'block' && result.plan) {
      markQueueItemBlocked(config, state, result.plan.task)
      consecutiveFailures = 0 // blocking is decisive, not a system failure
      noWorkAttempts = 0
    } else if (result.outcome === 'no-work') {
      noWorkAttempts++
      if (noWorkAttempts >= 3) {
        log('Planner could not find work after 3 attempts. Stopping.')
        appendNotes(cwd, state.iteration, result)
        saveState(cwd, state)
        break
      }
    } else {
      // reject, no-op, crash, timeout
      consecutiveFailures++
    }

    // Append notes (skip if commit already appended)
    if (result.outcome !== 'commit') {
      appendNotes(cwd, state.iteration, result)
    }

    // Save state
    saveState(cwd, state)

    log(`Iteration ${state.iteration} done in ${iterDuration}s — ${result.outcome}`)

    // Circuit breaker: 3 consecutive non-productive iterations
    if (consecutiveFailures >= config.maxConsecutiveFailures) {
      log(`CIRCUIT BREAKER: ${config.maxConsecutiveFailures} consecutive failures. Stopping.`)
      break
    }

    console.log()
  }

  // ── End summary ────────────────────────────────────────────────────────
  const totalMinutes = Math.round((Date.now() - startTime) / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60

  console.log()
  console.log('================================================================')
  console.log('  Nightshift complete')
  console.log()
  console.log(`  Iterations:  ${state.iteration}`)
  console.log(`  Commits:     ${state.completed.length}`)
  console.log(`  Failed:      ${state.failed.length}`)
  console.log(`  Blocked:     ${state.blocked.length}`)
  console.log(`  Duration:    ${hours}h ${mins}m`)
  console.log(`  Branch:      ${config.branch}`)

  if (state.blocked.length > 0) {
    console.log()
    console.log('  Blocked tasks:')
    for (const b of state.blocked) {
      console.log(`    - ${b.task}: ${b.reason}`)
    }
  }

  console.log()
  console.log('  Review your changes:')
  console.log(`    git log --oneline ${sourceBranch}..${config.branch}`)
  console.log('    nightshift status')
  console.log()
  console.log('  Merge when ready:')
  console.log(`    git checkout ${sourceBranch} && git merge ${config.branch}`)
  console.log('================================================================')
}
