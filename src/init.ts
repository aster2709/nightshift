import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, spawn } from 'node:child_process'
import * as p from '@clack/prompts'
import pc from 'picocolors'

// Node 18-20 compat: import.meta.dirname only exists in Node 21+
const __dirname = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))
import { writeConfig, DEFAULT_CONFIG, NIGHTSHIFT_DIR } from './config.js'
import type { NightshiftConfig } from './config.js'
import { detectProject, detectEvalCommands, detectExistingContext } from './detect.js'
import type { ProjectInfo } from './detect.js'

type MissionType = 'features' | 'improve' | 'both' | 'custom'

const GUIDANCE_PLACEHOLDERS: Record<MissionType, string> = {
  features: 'e.g. Focus on the API layer, or the user module (leave empty for fully autonomous)',
  improve: 'e.g. Focus on error handling, or the database layer (leave empty for fully autonomous)',
  both: 'e.g. Prioritize the checkout flow (leave empty for fully autonomous)',
  custom: 'Describe what the agent should do overnight',
}

function cancel(message = 'Init cancelled.'): never {
  p.cancel(message)
  process.exit(0)
}

function runClaudeAsync(prompt: string, cwd: string, timeout = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // Write prompt to temp file and use shell redirection to pipe it.
    // This avoids argument length limits and shell escaping issues.
    const tmpFile = path.join(cwd, NIGHTSHIFT_DIR, '.tmp_prompt.txt')
    fs.writeFileSync(tmpFile, prompt, 'utf-8')

    const child = spawn('bash', [
      '-c', `claude -p "$(cat '${tmpFile}')" --output-format text`,
    ], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Claude timed out'))
    }, timeout)

    child.on('close', (code) => {
      clearTimeout(timer)
      try { fs.unlinkSync(tmpFile) } catch {}
      if (code === 0 && stdout.trim().length > 100) {
        resolve(stdout.trim())
      } else {
        reject(new Error(stderr || `Claude exited with code ${code}`))
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      try { fs.unlinkSync(tmpFile) } catch {}
      reject(err)
    })
  })
}

function loadDiscoveryPrompt(cwd: string): string {
  // Find the discovery prompt template
  const candidates = [
    path.join(__dirname, '..', 'templates', 'discovery.prompt.md'),
    path.resolve(new URL('../../templates/discovery.prompt.md', import.meta.url).pathname),
  ]

  let prompt = ''
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        prompt = fs.readFileSync(candidate, 'utf-8')
        break
      }
    } catch { continue }
  }

  if (!prompt) {
    prompt = 'Explore this entire codebase and produce a structured markdown overview with these sections: ## Purpose, ## Architecture, ## Dependency Map (critical: what depends on what, "if you change X check Y"), ## Key Patterns, ## Invariants (things that must never break), ## Style Guide (observed conventions), ## Danger Zones (high blast-radius files and why). Read actual files, do not guess. Output only the markdown.'
  }

  // If CLAUDE.md exists, append it as context
  const claudeMdPath = path.join(cwd, 'CLAUDE.md')
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, 'utf-8')
    prompt += `\n\nThe project already has a CLAUDE.md. Use it as input but do NOT duplicate it. Your codebase.md focuses on UNDERSTANDING (architecture, dependencies, invariants) not INSTRUCTIONS.\n\n<existing-claude-md>\n${content}\n</existing-claude-md>`
  }

  return prompt
}

function buildMetaPrompt(opts: {
  projectInfo: ProjectInfo
  missionType: MissionType
  guidance: string
  constraints: string
  evalCommands: string[]
  existingContext: string
}): string {
  const { projectInfo, missionType, guidance, constraints, evalCommands, existingContext } = opts

  const modeRules = {
    features: `MODE: Add Features ONLY.
The agent must ONLY add new functionality. New endpoints, new modules, new capabilities.
It must NOT: refactor existing code, fix bugs, optimize performance, add comments, or "improve" anything that already works.
If the project has a test runner and existing tests, the agent should write tests for its new feature to prove it works and to pass the eval gate. But tests are a byproduct of the feature, not the goal. Writing tests for existing untested code is NOT allowed in this mode.
The agent is self-directed. It explores the codebase, identifies what's missing, and builds it. There is always a feature to add.`,
    improve: `MODE: Improve Codebase ONLY.
The agent must ONLY fix bugs, optimize performance, harden error handling, add test coverage, refactor messy code, and improve reliability.
It must NOT: add new user-facing features, new API endpoints, or new capabilities. The feature set stays the same. The quality goes up.
The agent is self-directed. It explores the codebase, finds real problems, and fixes them. There is always something to improve.`,
    both: `MODE: Features + Improvements (alternate).
The agent should alternate between adding new features and improving existing code.
Each iteration, pick whichever is highest impact right now. Use judgment.`,
    custom: `MODE: Custom (see guidance below).`,
  }[missionType]

  const guidanceSection = guidance
    ? `STEERING GUIDANCE (optional hint from the user, not a task list):\n${guidance}\n\nThis is a starting direction, not a boundary. The agent should use this as a hint for where to start, but must continue finding new work autonomously when this area is exhausted.`
    : 'No steering guidance provided. The agent is fully autonomous and decides what to work on based on its own exploration of the codebase.'

  return `You are generating a program.md file for an autonomous AI development agent called Nightshift.
The agent will run Claude Code in a loop overnight with no human supervision.
The program.md is the agent's only instructions file. It must be thorough, specific, and self-contained.

PROJECT INFO:
- Name: ${projectInfo.name}
- Type: ${projectInfo.type}
- Package manager: ${projectInfo.packageManager || 'unknown'}

${modeRules}

${guidanceSection}

${constraints ? `CONSTRAINTS (things NOT to touch):\n${constraints}` : 'No explicit constraints.'}

EVAL COMMANDS (must pass every iteration):
${evalCommands.map(c => `- ${c}`).join('\n')}

${existingContext ? `EXISTING PROJECT CONTEXT:\n${existingContext}` : ''}

Generate a complete program.md with these sections:

1. Identity: "You are an autonomous development agent. Each run, do ONE unit of work and exit."

2. Mode: Clearly state the mode rules. What the agent IS allowed to do and what it is NOT allowed to do.

3. How to find work: The agent must be self-directed. It reads the <codebase-overview> (architecture, patterns, dependency map, danger zones) and .nightshift/notes.md (what previous iterations did). It explores the codebase. It picks work it can execute CLEANLY in one iteration — something coherent with existing patterns and conventions. It does NOT always chase the "highest impact" item. A clean, small addition that fits the architecture beats an ambitious half-finished one.
   Before starting any work, the agent must understand HOW to build it: what patterns to follow, what conventions to match. Only start when the plan is clear.
   Include the steering guidance if provided, but frame it as a starting hint, not a boundary.

4. Constraints and boundaries.

5. Eval commands: list them, agent must run and pass all before exiting.

6. CRITICAL RULE: The agent must ALWAYS produce code changes. Exiting without modifying any source files is a failure. The feature space is INFINITE. If the obvious work is done, think bigger: new modules, integrations, utilities, data structures, API layers, parsers, CLI tools. A codebase can always grow. "Looks complete" is never true.

7. Before exiting: run evals, write a one-line summary to .nightshift/summary.txt (overwrite), then exit.
   Do NOT write to .nightshift/notes.md — the orchestrator manages that file.

The agent receives a <codebase-overview> in its prompt. The program.md should instruct the agent to read this before touching any code.

Be specific to THIS project. Reference actual file paths, frameworks, and patterns from the project info.
Do NOT include any preamble or explanation. Output ONLY the markdown content of program.md.`
}

function buildFallbackProgram(opts: {
  template: string
  projectName: string
  missionType: MissionType
  guidance: string
  constraints: string
  evalCommands: string[]
  excludeDirs: string[]
}): string {
  const { template, projectName, missionType, guidance, constraints, evalCommands, excludeDirs } = opts

  const guidanceNote = guidance
    ? `\n\n**Steering guidance:** ${guidance}\nThis is a starting direction, not a boundary. Continue finding new work when this area is exhausted.`
    : ''

  const missionLines = {
    features: `### Mode: Add Features ONLY\nExplore the codebase and build new functionality. New endpoints, new modules, new capabilities.\n\n**You must NOT:** refactor existing code, fix bugs, write tests for existing code, optimize, or "improve" what already works. Tests are only allowed as part of a new feature.${guidanceNote}`,
    improve: `### Mode: Improve Codebase ONLY\nFix bugs, optimize performance, harden error handling, add test coverage, refactor.\n\n**You must NOT:** add new user-facing features, new API endpoints, or new capabilities. The feature set stays the same, the quality goes up.${guidanceNote}`,
    both: `### Mode: Features + Improvements\nAlternate between adding new features and improving existing code. Each iteration, pick whichever is highest impact.${guidanceNote}`,
    custom: `### Mode: Custom\n${guidance || 'No guidance provided. Use your judgment.'}`,
  }[missionType]

  const evalFormatted = evalCommands.length > 0
    ? evalCommands.map(c => `- \`${c}\``).join('\n')
    : '- No eval commands configured. Verify your changes manually.'

  const constraintText = constraints || 'No explicit constraints. Use good judgment.'
  const excludeText = excludeDirs.length > 0
    ? excludeDirs.map(d => `- \`${d}\``).join('\n')
    : '- None specified'

  return template
    .replace(/\{\{projectName\}\}/g, projectName)
    .replace(/\{\{missionSection\}\}/g, missionLines)
    .replace(/\{\{constraints\}\}/g, constraintText)
    .replace(/\{\{evalCommands\}\}/g, evalFormatted)
    .replace(/\{\{excludeDirs\}\}/g, excludeText)
}

function loadTemplate(): string {
  const candidates = [
    path.join(__dirname, '..', 'templates', 'program.template.md'),
    path.join(process.cwd(), 'templates', 'program.template.md'),
    path.resolve(new URL('../../templates/program.template.md', import.meta.url).pathname),
  ]

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf-8')
      }
    } catch {
      continue
    }
  }

  // Inline fallback if template file not found
  return `# Nightshift Agent - {{projectName}}

You are an autonomous development agent. No human is watching. Be self-directed and thorough.
Each iteration, do ONE unit of work, verify it passes all eval gates, and exit.

## Mission
{{missionSection}}

## Finding Work
You are self-directed. Explore the codebase, read the <codebase-overview> and notes.md, find the highest-impact work within your mode. There is ALWAYS work to do. Exiting without code changes is a failure.

## Constraints
{{constraints}}

## Eval Commands
{{evalCommands}}

## Before Exiting
1. Verify you actually changed source files. If not, go find work.
2. Run all eval commands one final time
3. Write a one-line summary to .nightshift/summary.txt (overwrite)
4. Do NOT write to .nightshift/notes.md (the orchestrator manages it)
5. Exit cleanly
`
}

export async function init(): Promise<void> {
  const cwd = process.cwd()

  p.intro(pc.bgCyan(pc.black(' nightshift ')))

  // Check if already initialized
  const nightshiftDir = path.join(cwd, NIGHTSHIFT_DIR)
  if (fs.existsSync(path.join(nightshiftDir, 'config.json'))) {
    const overwrite = await p.confirm({
      message: 'nightshift is already initialized in this project. Re-initialize?',
      initialValue: false,
    })
    if (p.isCancel(overwrite) || !overwrite) cancel('Keeping existing config.')
  }

  // Step 1: Detect project
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

  // Step 2: Mission type
  const missionType = await p.select({
    message: 'What should the agent focus on?',
    options: [
      { value: 'features' as const, label: 'Add features', hint: 'explore codebase, build what\'s missing' },
      { value: 'improve' as const, label: 'Improve existing code', hint: 'fix bugs, harden, optimize' },
      { value: 'both' as const, label: 'Both', hint: 'alternate between features and improvements' },
      { value: 'custom' as const, label: 'Custom', hint: 'describe your own mission' },
    ],
  })
  if (p.isCancel(missionType)) cancel()

  // Step 3: Steering guidance (optional)
  const guidance = await p.text({
    message: 'Any steering guidance? Where should the agent start? (optional)',
    placeholder: GUIDANCE_PLACEHOLDERS[missionType],
    defaultValue: '',
  })
  if (p.isCancel(guidance)) cancel()

  // Step 4: Constraints
  const constraints = await p.text({
    message: 'Any constraints? What should the agent NOT touch? (optional)',
    placeholder: 'e.g. migrations/, no new deps, backend only',
    defaultValue: '',
  })
  if (p.isCancel(constraints)) cancel()

  // Step 5: Detect eval commands
  spin.start('Detecting eval commands...')
  let evalCommands = await detectEvalCommands(cwd, projectInfo)
  spin.stop(`Found ${evalCommands.length} eval command${evalCommands.length === 1 ? '' : 's'}`)

  if (evalCommands.length > 0) {
    p.note(
      evalCommands.map(c => `  ${pc.green('$')} ${c}`).join('\n'),
      'Detected eval commands'
    )
  } else {
    p.log.warn('No eval commands detected. The agent will run without quality gates.')
  }

  // Step 6: Edit eval commands
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

  // Step 7: Config summary
  let config: NightshiftConfig = {
    ...DEFAULT_CONFIG,
    eval: evalCommands,
  }

  p.note(
    [
      `${pc.bold('Branch:')}      ${config.branch}`,
      `${pc.bold('Iterations:')}  ${config.maxIterations}`,
      `${pc.bold('Timeout:')}     ${config.timeout}s per iteration`,
      `${pc.bold('Model:')}       ${config.model}`,
      `${pc.bold('Eval:')}        ${config.eval.length > 0 ? config.eval.join(', ') : 'none'}`,
    ].join('\n'),
    'Configuration'
  )

  // Step 8: Advanced settings
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
      message: 'Model:',
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

  // Step 9: Create .nightshift directory
  fs.mkdirSync(nightshiftDir, { recursive: true })

  // Step 10: Write config
  writeConfig(cwd, config)
  p.log.success('Wrote .nightshift/config.json')

  // Step 11: Generate program.md
  let programContent: string | null = null
  let claudeAvailable = true

  spin.start('Generating program.md with Claude...')
  const existingContext = await detectExistingContext(cwd)

  const metaPrompt = buildMetaPrompt({
    projectInfo,
    missionType,
    guidance: guidance || '',
    constraints: constraints || '',
    evalCommands,
    existingContext,
  })

  try {
    programContent = await runClaudeAsync(metaPrompt, cwd, 120_000)
    spin.stop('Generated program.md')
  } catch (err) {
    claudeAvailable = false
    const reason = err instanceof Error ? err.message : 'unknown error'
    spin.stop(`Could not run claude -p (${reason}), using template`)

    const template = loadTemplate()
    programContent = buildFallbackProgram({
      template,
      projectName: projectInfo.name,
      missionType,
      guidance: guidance || '',
      constraints: constraints || '',
      evalCommands,
      excludeDirs: config.exclude,
    })

    p.log.warn('Edit .nightshift/program.md to customize the agent instructions.')
  }

  fs.writeFileSync(path.join(nightshiftDir, 'program.md'), programContent + '\n', 'utf-8')

  // Step 12: Discovery pass - generate codebase.md
  const codebasePath = path.join(nightshiftDir, 'codebase.md')

  if (claudeAvailable) {
    spin.start('Generating codebase overview...')

    try {
      const discoveryPrompt = loadDiscoveryPrompt(cwd)
      const codebaseContent = await runClaudeAsync(discoveryPrompt, cwd, 180_000)

      fs.writeFileSync(codebasePath, codebaseContent + '\n', 'utf-8')
      spin.stop(`Codebase overview generated (${(codebaseContent.length / 1024).toFixed(1)}KB)`)
    } catch {
      spin.stop('Discovery will run automatically on first nightshift run')
    }
  } else {
    p.log.info('Codebase discovery will run automatically on first nightshift run')
  }

  // Step 13: Create notes, logs, update .gitignore (silently)
  const notesPath = path.join(nightshiftDir, 'notes.md')
  if (!fs.existsSync(notesPath)) {
    fs.writeFileSync(notesPath, '# Nightshift Notes\n', 'utf-8')
  }

  const logsDir = path.join(nightshiftDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })

  const gitignorePath = path.join(cwd, '.gitignore')
  const gitignoreEntries = [
    '.nightshift/logs/',
    '.nightshift/summary.txt',
    '.nightshift/notes.md',
    '.nightshift/codebase.md',
  ]

  let gitignoreContent = ''
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8')
  }

  const missingEntries = gitignoreEntries.filter(entry => {
    const lines = gitignoreContent.split('\n').map(l => l.trim())
    return !lines.includes(entry)
  })

  if (missingEntries.length > 0) {
    const block = '\n# nightshift\n' + missingEntries.join('\n') + '\n'
    fs.appendFileSync(gitignorePath, block, 'utf-8')
  }

  // Done
  p.outro(
    `${pc.green('Ready.')} Run ${pc.cyan('nightshift run')} to start the loop.`
  )
}
