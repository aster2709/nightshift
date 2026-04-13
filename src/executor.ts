import fs from 'node:fs'
import path from 'node:path'
import type { NightshiftConfig } from './config.js'
import { NIGHTSHIFT_DIR } from './config.js'
import type { RunState, TaskPlan, IterationOutput } from './types.js'
import { runClaude, parseJSON } from './claude.js'
import { formatCompletedForPrompt } from './state.js'

function loadCodebase(cwd: string): string {
  const file = path.join(cwd, NIGHTSHIFT_DIR, 'codebase.md')
  if (!fs.existsSync(file)) return 'No codebase overview available.'
  return fs.readFileSync(file, 'utf-8')
}

function buildExecutorPrompt(
  plan: TaskPlan,
  config: NightshiftConfig,
  state: RunState,
): string {
  const codebase = loadCodebase(process.cwd())

  const parts = [
    'You are running inside Nightshift, an autonomous development loop. Execute the assigned task and exit.',
    '',
    `TASK: ${plan.task}`,
    '',
    `RATIONALE: ${plan.rationale}`,
    '',
    `Target files: ${plan.targetFiles.join(', ')}`,
    '',
    '<codebase-overview>',
    codebase,
    '</codebase-overview>',
  ]

  // Add previous work for context
  if (state.completed.length > 0) {
    parts.push(
      '',
      'PREVIOUS WORK (for context, do not repeat):',
      formatCompletedForPrompt(state.completed),
    )
  }

  // Constraints
  if (config.constraints) {
    parts.push('', `CONSTRAINTS: ${config.constraints}`)
  }
  if (config.exclude.length > 0) {
    parts.push('', `Do not modify files in: ${config.exclude.join(', ')}`)
  }

  // Eval commands
  if (config.eval.length > 0) {
    parts.push(
      '',
      'EVAL COMMANDS (run all before exiting — every one must pass):',
      ...config.eval.map(c => `- ${c}`),
    )
  }

  parts.push(
    '',
    'RULES:',
    '1. Complete the assigned task. Do not do unrelated work.',
    '2. You MUST produce code changes. Exiting without modifying files is a failure.',
    '3. Follow existing patterns, naming conventions, and style exactly.',
    '4. Read the <codebase-overview> before touching code. Check dependencies.',
    '5. Run all eval commands before exiting. Fix any failures.',
    '',
    'WHEN DONE:',
    'Write a JSON file to .nightshift/iteration.json (overwrite if exists):',
    '{',
    '  "summary": "one-line description of what you did",',
    '  "filesChanged": ["list", "of", "files", "you", "changed"],',
    '  "confidence": 85',
    '}',
    '',
    'Do NOT write to .nightshift/notes.md or .nightshift/state.json.',
  )

  return parts.join('\n')
}

export interface ExecuteResult {
  exitCode: number
  timedOut: boolean
  iterationOutput: IterationOutput | null
}

export async function executeTask(
  plan: TaskPlan,
  config: NightshiftConfig,
  state: RunState,
  cwd: string,
): Promise<ExecuteResult> {
  const prompt = buildExecutorPrompt(plan, config, state)

  const logDir = path.join(cwd, NIGHTSHIFT_DIR, 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  const logFile = path.join(logDir, `iteration_${state.iteration}.log`)

  const result = await runClaude({
    prompt,
    model: config.model,
    cwd,
    timeout: config.timeout * 1000, // convert seconds to ms
    skipPermissions: true,
  })

  // Write log
  fs.writeFileSync(logFile, result.output, 'utf-8')

  // Read iteration.json if agent wrote it
  const iterOutput = readIterationOutput(cwd)

  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    iterationOutput: iterOutput,
  }
}

function readIterationOutput(cwd: string): IterationOutput | null {
  const file = path.join(cwd, NIGHTSHIFT_DIR, 'iteration.json')
  if (!fs.existsSync(file)) return null

  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = parseJSON<IterationOutput>(raw)
    if (parsed && parsed.summary) return parsed
    return null
  } catch {
    return null
  }
}

export function cleanIterationArtifacts(cwd: string): void {
  const files = [
    path.join(cwd, NIGHTSHIFT_DIR, 'iteration.json'),
    path.join(cwd, NIGHTSHIFT_DIR, 'summary.txt'),
  ]
  for (const f of files) {
    try { fs.unlinkSync(f) } catch {}
  }
}
