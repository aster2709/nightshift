import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import * as p from '@clack/prompts'
import pc from 'picocolors'
import { writeConfig, DEFAULT_CONFIG, NIGHTSHIFT_DIR } from './config.js'
import type { NightshiftConfig } from './config.js'
import { detectProject, detectEvalCommands, detectExistingContext } from './detect.js'
import type { ProjectInfo } from './detect.js'

type MissionType = 'features' | 'improve' | 'both' | 'custom'

const MISSION_PLACEHOLDERS: Record<MissionType, string> = {
  features: 'e.g. Add user authentication, build API endpoints for orders',
  improve: 'e.g. Fix flaky tests, add error boundaries, optimize DB queries',
  both: 'e.g. Add search feature, then harden existing auth flow',
  custom: 'Describe what the agent should do overnight',
}

function cancel(message = 'Init cancelled.'): never {
  p.cancel(message)
  process.exit(0)
}

function buildMetaPrompt(opts: {
  projectInfo: ProjectInfo
  missionType: MissionType
  missionScope: string
  constraints: string
  evalCommands: string[]
  existingContext: string
}): string {
  const { projectInfo, missionType, missionScope, constraints, evalCommands, existingContext } = opts

  const missionLabel = {
    features: 'Add features: explore the codebase, build what is missing',
    improve: 'Improve existing code: fix bugs, harden, optimize',
    both: 'Alternate between adding features and improving existing code',
    custom: 'Custom mission',
  }[missionType]

  return `You are generating a program.md file for an autonomous AI development agent called Nightshift.
The agent will run Claude Code in a loop overnight with no human supervision.
The program.md is the agent's only instructions file. It must be thorough, specific, and self-contained.

PROJECT INFO:
- Name: ${projectInfo.name}
- Type: ${projectInfo.type}
- Package manager: ${projectInfo.packageManager || 'unknown'}

MISSION TYPE: ${missionLabel}

MISSION SCOPE:
${missionScope}

${constraints ? `CONSTRAINTS (things NOT to touch):\n${constraints}` : 'No explicit constraints.'}

EVAL COMMANDS (must pass every iteration):
${evalCommands.map(c => `- ${c}`).join('\n')}

${existingContext ? `EXISTING PROJECT CONTEXT:\n${existingContext}` : ''}

Generate a complete program.md with these sections:
1. Identity: "You are an autonomous development agent. Each run, do ONE unit of work and exit."
2. Mission with specific, actionable tasks derived from the scope
3. Constraints and boundaries
4. Eval commands the agent must run and pass
5. Workflow: orient (read notes.md), plan, implement, verify evals, exit
6. Before exiting: run evals, write a one-line summary to .nightshift/summary.txt (overwrite), then exit

IMPORTANT: The agent must NOT write to .nightshift/notes.md. The orchestrator script manages that file.
The agent must ONLY write to .nightshift/summary.txt (one line, overwrite).

Be specific to THIS project. Reference actual file paths, frameworks, and patterns from the project info.
Do NOT include any preamble or explanation. Output ONLY the markdown content of program.md.`
}

function buildFallbackProgram(opts: {
  template: string
  projectName: string
  missionType: MissionType
  missionScope: string
  constraints: string
  evalCommands: string[]
  excludeDirs: string[]
}): string {
  const { template, projectName, missionType, missionScope, constraints, evalCommands, excludeDirs } = opts

  const missionLines = {
    features: `### Mode: Add Features\nExplore the codebase and build what is missing.\n\n${missionScope}`,
    improve: `### Mode: Improve Existing Code\nFix bugs, harden edge cases, and optimize performance.\n\n${missionScope}`,
    both: `### Mode: Features + Improvements\nAlternate between adding new features and improving existing code.\n\n${missionScope}`,
    custom: `### Mode: Custom\n${missionScope}`,
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
    path.join(import.meta.dirname ?? '', '..', 'templates', 'program.template.md'),
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

You are an autonomous development agent running in a loop overnight with no human supervision.
Each iteration, do ONE unit of work, verify it passes all eval gates, and exit.

**You are fully autonomous. Never ask for permission, confirmation, or clarification.**

## Mission
{{missionSection}}

## Constraints
{{constraints}}

## Directories to Exclude
{{excludeDirs}}

## Eval Commands
Run ALL of these before finishing each iteration. Every command must pass.

{{evalCommands}}

## Workflow (each iteration)
1. Read .nightshift/notes.md for context from previous iterations
2. Identify the highest-impact task within your mission scope
3. Implement the change in small, testable increments
4. Run eval commands after each meaningful change
5. If evals fail, fix the issue before moving on

## Before Exiting
1. Run all eval commands one final time
2. Write a one-line summary to .nightshift/summary.txt (overwrite)
3. Do NOT write to .nightshift/notes.md (the orchestrator manages it)
4. Exit cleanly
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

  // Step 3: Mission scope
  const missionScope = await p.text({
    message: 'Describe the mission scope. What should the agent work on?',
    placeholder: MISSION_PLACEHOLDERS[missionType],
    validate: (v) => {
      if (!v.trim()) return 'Mission scope is required'
    },
  })
  if (p.isCancel(missionScope)) cancel()

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

  spin.start('Generating program.md with Claude...')
  const existingContext = await detectExistingContext(cwd)

  const metaPrompt = buildMetaPrompt({
    projectInfo,
    missionType,
    missionScope,
    constraints: constraints || '',
    evalCommands,
    existingContext,
  })

  try {
    // Write prompt to temp file to avoid shell escaping issues
    const tmpPrompt = path.join(NIGHTSHIFT_DIR, '.tmp_prompt.txt')
    fs.writeFileSync(path.join(cwd, tmpPrompt), metaPrompt, 'utf-8')

    programContent = execSync(
      `claude -p "$(cat ${tmpPrompt})" --output-format text`,
      {
        cwd,
        encoding: 'utf-8',
        timeout: 120_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ).trim()

    // Clean up temp file
    fs.unlinkSync(path.join(cwd, tmpPrompt))

    // Sanity check: if output is too short or looks like an error
    if (!programContent || programContent.length < 100) {
      throw new Error('Output too short, likely an error')
    }

    spin.stop('Generated program.md with Claude')
  } catch {
    spin.stop('Claude CLI not available, using template')

    const template = loadTemplate()
    programContent = buildFallbackProgram({
      template,
      projectName: projectInfo.name,
      missionType,
      missionScope,
      constraints: constraints || '',
      evalCommands,
      excludeDirs: config.exclude,
    })

    p.log.warn('Used template fallback. Edit .nightshift/program.md to customize.')
  }

  fs.writeFileSync(path.join(nightshiftDir, 'program.md'), programContent + '\n', 'utf-8')
  p.log.success('Wrote .nightshift/program.md')

  // Step 12: Create empty notes.md
  const notesPath = path.join(nightshiftDir, 'notes.md')
  if (!fs.existsSync(notesPath)) {
    fs.writeFileSync(notesPath, '# Nightshift Notes\n\nThis file is shared between iterations. The agent appends notes here.\n', 'utf-8')
  }
  p.log.success('Created .nightshift/notes.md')

  // Step 13: Create logs directory
  const logsDir = path.join(nightshiftDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  p.log.success('Created .nightshift/logs/')

  // Step 14: Update .gitignore
  const gitignorePath = path.join(cwd, '.gitignore')
  const gitignoreEntries = [
    '.nightshift/logs/',
    '.nightshift/summary.txt',
    '.nightshift/notes.md',
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
    p.log.success('Updated .gitignore')
  }

  // Done
  p.outro(
    `${pc.green('Ready.')} Review ${pc.bold('.nightshift/program.md')}, then run: ${pc.cyan('nightshift run')}`
  )
}
