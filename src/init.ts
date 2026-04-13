import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import * as p from '@clack/prompts'
import pc from 'picocolors'

import { writeConfig, DEFAULT_CONFIG, NIGHTSHIFT_DIR } from './config.js'
import type { NightshiftConfig, Mode, AfterQueue, WorkItem } from './config.js'
import { detectProject, detectEvalCommands } from './detect.js'
import { runClaude, parseJSON } from './claude.js'

function cancel(message = 'Init cancelled.'): never {
  p.cancel(message)
  process.exit(0)
}

export async function init(): Promise<void> {
  const cwd = process.cwd()

  p.intro(pc.bgCyan(pc.black(' nightshift v0.2.0 ')))

  // Check if already initialized
  const nightshiftDir = path.join(cwd, NIGHTSHIFT_DIR)
  if (fs.existsSync(path.join(nightshiftDir, 'config.json'))) {
    const overwrite = await p.confirm({
      message: 'nightshift is already initialized. Re-initialize?',
      initialValue: false,
    })
    if (p.isCancel(overwrite) || !overwrite) cancel('Keeping existing config.')
  }

  // ── Step 1: Detect project ─────────────────────────────────────────────
  const spin = p.spinner()
  spin.start('Detecting project...')
  const projectInfo = await detectProject(cwd)
  spin.stop('Project detected')

  p.note(
    [
      `${pc.bold('Name:')}     ${projectInfo.name}`,
      `${pc.bold('Type:')}     ${projectInfo.type}`,
      projectInfo.packageManager ? `${pc.bold('Pkg mgr:')}  ${projectInfo.packageManager}` : null,
      projectInfo.description ? `${pc.bold('Desc:')}     ${projectInfo.description.slice(0, 60)}` : null,
    ].filter(Boolean).join('\n'),
    'Detected project'
  )

  // ── Step 2: Mode ───────────────────────────────────────────────────────
  const mode = await p.select({
    message: 'What should the agent focus on?',
    options: [
      { value: 'features' as const, label: 'Add features', hint: 'build new functionality' },
      { value: 'improve' as const, label: 'Improve existing code', hint: 'fix bugs, harden, optimize' },
      { value: 'both' as const, label: 'Both', hint: 'alternate based on impact' },
      { value: 'custom' as const, label: 'Custom', hint: 'describe your own mission' },
    ],
  })
  if (p.isCancel(mode)) cancel()

  // ── Step 3: Custom mission (if custom mode) ────────────────────────────
  let customMission = ''
  if (mode === 'custom') {
    const mission = await p.text({
      message: 'Describe what the agent should do:',
      placeholder: 'e.g. Migrate all API routes from Express to Hono',
      validate: (v) => {
        if (!v.trim()) return 'Mission description is required for custom mode'
      },
    })
    if (p.isCancel(mission)) cancel()
    customMission = mission
  }

  // ── Step 4: Steering guidance → Work queue ─────────────────────────────
  const guidance = await p.text({
    message: 'What should the agent work on? (specific tasks or general direction)',
    placeholder: mode === 'features'
      ? 'e.g. Build a REST API with auth, rate limiting, and user profiles'
      : mode === 'improve'
        ? 'e.g. Add error handling and test coverage to the API layer'
        : 'e.g. Focus on the checkout flow',
    defaultValue: '',
  })
  if (p.isCancel(guidance)) cancel()

  let workQueue: WorkItem[] = []
  let afterQueue: AfterQueue = 'autonomous'

  if (guidance.trim()) {
    // Offer to decompose into work queue
    const decompose = await p.confirm({
      message: 'Decompose this into a structured work queue? (recommended)',
      initialValue: true,
    })
    if (p.isCancel(decompose)) cancel()

    if (decompose) {
      spin.start('Decomposing into tasks...')

      const decomposePrompt = [
        'Break this user request into discrete, independently-completable development tasks.',
        'Each task should be achievable in one iteration (one focused coding session).',
        '',
        `User request: ${guidance}`,
        `Mode: ${mode}`,
        `Project type: ${projectInfo.type}`,
        projectInfo.description ? `Project description: ${projectInfo.description}` : '',
        '',
        'Output ONLY a JSON array of task strings, ordered by dependency (do first → do last):',
        '["task 1 description", "task 2 description", ...]',
        '',
        'Rules:',
        '- Each task should be specific and actionable',
        '- 3-8 tasks is ideal. Too many = too granular. Too few = too broad.',
        '- Order matters: earlier tasks should not depend on later ones',
      ].join('\n')

      const result = await runClaude({
        prompt: decomposePrompt,
        model: DEFAULT_CONFIG.plannerModel,
        cwd,
        timeout: 60_000,
        skipPermissions: false,
      })

      spin.stop('Tasks generated')

      if (result.exitCode === 0 && result.output) {
        const tasks = parseJSON<string[]>(result.output)
        if (tasks && Array.isArray(tasks) && tasks.length > 0) {
          // Show tasks for confirmation
          const taskList = tasks.map((t, i) => `  ${pc.dim(`${i + 1}.`)} ${t}`).join('\n')
          p.note(taskList, 'Work queue')

          const accept = await p.select({
            message: 'Accept this work queue?',
            options: [
              { value: 'accept' as const, label: 'Accept', hint: 'use these tasks' },
              { value: 'autonomous' as const, label: 'Skip queue', hint: 'use guidance as a hint instead' },
            ],
          })
          if (p.isCancel(accept)) cancel()

          if (accept === 'accept') {
            workQueue = tasks.map(t => ({ task: t }))

            const after = await p.select({
              message: 'What should happen after the queue is done?',
              options: [
                { value: 'stop' as const, label: 'Stop', hint: 'end the run' },
                { value: 'autonomous' as const, label: 'Keep going', hint: 'agent finds more work autonomously' },
              ],
            })
            if (p.isCancel(after)) cancel()
            afterQueue = after
          }
        } else {
          p.log.warn('Could not parse tasks. Using guidance as a hint instead.')
        }
      } else {
        p.log.warn('Claude could not decompose tasks. Using guidance as a hint instead.')
      }
    }
  }

  // ── Step 5: Constraints ────────────────────────────────────────────────
  const constraints = await p.text({
    message: 'Any constraints? What should the agent NOT touch? (optional)',
    placeholder: 'e.g. migrations/, no new deps, backend only',
    defaultValue: '',
  })
  if (p.isCancel(constraints)) cancel()

  // ── Step 6: Detect eval commands ───────────────────────────────────────
  spin.start('Detecting eval commands...')
  let evalCommands = await detectEvalCommands(cwd, projectInfo)
  spin.stop(`Found ${evalCommands.length} eval command${evalCommands.length === 1 ? '' : 's'}`)

  if (evalCommands.length > 0) {
    p.note(
      evalCommands.map(c => `  ${pc.green('$')} ${c}`).join('\n'),
      'Detected eval commands'
    )
  } else {
    p.log.warn('No eval commands detected.')
  }

  const editEval = await p.confirm({
    message: evalCommands.length > 0
      ? 'Edit eval commands?'
      : 'Add eval commands? (strongly recommended)',
    initialValue: evalCommands.length === 0,
  })
  if (p.isCancel(editEval)) cancel()

  if (editEval) {
    const evalInput = await p.text({
      message: 'Eval commands (comma-separated):',
      placeholder: 'e.g. npm test, npm run lint, npm run typecheck',
      initialValue: evalCommands.join(', '),
      validate: (v) => {
        if (!v.trim()) return 'At least one eval command is recommended'
      },
    })
    if (p.isCancel(evalInput)) cancel()

    evalCommands = evalInput
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }

  // ── Step 7: Build config ───────────────────────────────────────────────
  let config: NightshiftConfig = {
    ...DEFAULT_CONFIG,
    mode,
    constraints: constraints || '',
    customMission,
    eval: evalCommands,
    workQueue,
    afterQueue: workQueue.length > 0 ? afterQueue : 'autonomous',
  }

  p.note(
    [
      `${pc.bold('Mode:')}        ${config.mode}`,
      `${pc.bold('Branch:')}      ${config.branch}`,
      `${pc.bold('Iterations:')}  ${config.maxIterations}`,
      `${pc.bold('Timeout:')}     ${config.timeout}s per iteration`,
      `${pc.bold('Model:')}       ${config.model}`,
      `${pc.bold('Planner:')}     ${config.plannerModel}`,
      `${pc.bold('Evaluator:')}   ${config.evaluatorModel}`,
      `${pc.bold('Eval:')}        ${config.eval.length > 0 ? config.eval.join(', ') : 'none'}`,
      `${pc.bold('Work queue:')}  ${config.workQueue.length > 0 ? `${config.workQueue.length} items` : 'autonomous'}`,
      config.workQueue.length > 0 ? `${pc.bold('After queue:')} ${config.afterQueue}` : null,
    ].filter(Boolean).join('\n'),
    'Configuration'
  )

  // ── Step 8: Advanced settings ──────────────────────────────────────────
  const advanced = await p.confirm({
    message: 'Customize advanced settings?',
    initialValue: false,
  })
  if (p.isCancel(advanced)) cancel()

  if (advanced) {
    const maxIter = await p.text({
      message: 'Max iterations per run:',
      initialValue: String(config.maxIterations),
      validate: (v) => {
        const n = parseInt(v, 10)
        if (isNaN(n) || n < 1) return 'Must be a positive number'
      },
    })
    if (p.isCancel(maxIter)) cancel()

    const timeout = await p.text({
      message: 'Timeout per iteration (seconds):',
      initialValue: String(config.timeout),
      validate: (v) => {
        const n = parseInt(v, 10)
        if (isNaN(n) || n < 60) return 'Must be at least 60 seconds'
      },
    })
    if (p.isCancel(timeout)) cancel()

    const branch = await p.text({
      message: 'Branch name:',
      initialValue: config.branch,
      validate: (v) => {
        if (!v.trim()) return 'Branch name is required'
        if (/\s/.test(v)) return 'Branch name cannot contain spaces'
      },
    })
    if (p.isCancel(branch)) cancel()

    const model = await p.select({
      message: 'Executor model:',
      options: [
        { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', hint: 'most capable, slower' },
        { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'fast, cost-effective' },
      ],
      initialValue: config.model,
    })
    if (p.isCancel(model)) cancel()

    config = {
      ...config,
      maxIterations: parseInt(maxIter, 10),
      timeout: parseInt(timeout, 10),
      branch,
      model,
    }
  }

  // ── Step 9: Write everything ───────────────────────────────────────────
  fs.mkdirSync(nightshiftDir, { recursive: true })

  // Config
  writeConfig(cwd, config)
  p.log.success('Wrote .nightshift/config.json')

  // Discovery pass - generate codebase.md
  const codebasePath = path.join(nightshiftDir, 'codebase.md')
  let claudeAvailable = true

  spin.start('Generating codebase overview...')
  try {
    const discoveryPrompt = loadDiscoveryPrompt(cwd)
    const result = await runClaude({
      prompt: discoveryPrompt,
      model: config.model,
      cwd,
      timeout: 180_000,
      skipPermissions: true,
    })

    // Agent may have written codebase.md directly via tools — prefer that over stdout
    if (fs.existsSync(codebasePath)) {
      const existing = fs.readFileSync(codebasePath, 'utf-8')
      if (existing.length > 500) {
        spin.stop(`Codebase overview generated (${(existing.length / 1024).toFixed(1)}KB)`)
      } else if (result.exitCode === 0 && result.output.length > 500) {
        fs.writeFileSync(codebasePath, result.output + '\n', 'utf-8')
        spin.stop(`Codebase overview generated (${(result.output.length / 1024).toFixed(1)}KB)`)
      } else {
        claudeAvailable = false
        spin.stop('Discovery will run automatically on first nightshift run')
      }
    } else if (result.exitCode === 0 && result.output.length > 500) {
      fs.writeFileSync(codebasePath, result.output + '\n', 'utf-8')
      spin.stop(`Codebase overview generated (${(result.output.length / 1024).toFixed(1)}KB)`)
    } else {
      claudeAvailable = false
      spin.stop('Discovery will run automatically on first nightshift run')
    }
  } catch {
    claudeAvailable = false
    spin.stop('Discovery will run automatically on first nightshift run')
  }

  // Clear previous run state (fresh start on re-init)
  const statePath = path.join(nightshiftDir, 'state.json')
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath)

  const logsPath = path.join(nightshiftDir, 'logs')
  if (fs.existsSync(logsPath)) {
    for (const f of fs.readdirSync(logsPath)) {
      fs.unlinkSync(path.join(logsPath, f))
    }
  }

  for (const artifact of ['iteration.json', 'summary.txt']) {
    const artifactPath = path.join(nightshiftDir, artifact)
    if (fs.existsSync(artifactPath)) fs.unlinkSync(artifactPath)
  }

  // Reset notes and ensure logs dir
  const notesPath = path.join(nightshiftDir, 'notes.md')
  fs.writeFileSync(notesPath, '# Nightshift Notes\n', 'utf-8')
  fs.mkdirSync(path.join(nightshiftDir, 'logs'), { recursive: true })

  // Update .gitignore
  const gitignorePath = path.join(cwd, '.gitignore')
  const desiredEntries = [
    '.nightshift/*',
    '!.nightshift/config.json',
  ]

  let gitignoreContent = ''
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8')
  }

  // Remove old nightshift gitignore entries and add new pattern
  const lines = gitignoreContent.split('\n')
  const filtered = lines.filter(l => {
    const trimmed = l.trim()
    if (trimmed === '# nightshift') return false
    if (trimmed.startsWith('.nightshift/')) return false
    if (trimmed === '.nightshift/*') return false
    if (trimmed === '!.nightshift/config.json') return false
    return true
  })

  // Add new entries
  const hasNightshiftBlock = filtered.some(l => l.includes('.nightshift'))
  if (!hasNightshiftBlock) {
    filtered.push('', '# nightshift', ...desiredEntries, '')
  }

  fs.writeFileSync(gitignorePath, filtered.join('\n'), 'utf-8')

  // Auto-commit init changes so `nightshift run` doesn't hit dirty-tree preflight
  try {
    execSync('git add .gitignore .nightshift/config.json', { cwd, stdio: 'pipe' })
    execSync('git commit -m "nightshift init" --no-verify', {
      cwd,
      stdio: 'pipe',
      env: process.env,
    })
    p.log.success('Committed nightshift config')
  } catch {
    // Not a git repo or nothing to commit — user can commit manually
  }

  // Done
  p.outro(
    `${pc.green('Ready.')} Run ${pc.cyan('nightshift run')} to start the loop.`
  )
}

function loadDiscoveryPrompt(cwd: string): string {
  const candidates = [
    path.resolve(new URL('../templates/discovery.prompt.md', import.meta.url).pathname),
    path.join(cwd, 'node_modules', '@aster2709', 'nightshift', 'templates', 'discovery.prompt.md'),
  ]

  let prompt = 'Explore this entire codebase and produce a structured markdown overview with these sections: ## Purpose, ## Architecture, ## Dependency Map, ## Key Patterns, ## Invariants, ## Style Guide, ## Danger Zones. Read actual files, do not guess. Output only the markdown.'

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        prompt = fs.readFileSync(candidate, 'utf-8')
        break
      }
    } catch { continue }
  }

  const claudeMdPath = path.join(cwd, 'CLAUDE.md')
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, 'utf-8')
    prompt += `\n\nThe project has a CLAUDE.md. Use it as input but do NOT duplicate it.\n\n<existing-claude-md>\n${content}\n</existing-claude-md>`
  }

  return prompt
}
