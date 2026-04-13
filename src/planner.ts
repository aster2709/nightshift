import fs from 'node:fs'
import path from 'node:path'
import type { NightshiftConfig, Mode } from './config.js'
import { NIGHTSHIFT_DIR } from './config.js'
import type { RunState, TaskPlan } from './types.js'
import { runClaudeJSON } from './claude.js'
import {
  formatCompletedForPrompt,
  formatFailedForPrompt,
  formatBlockedForPrompt,
  isTaskBlocked,
  getTaskFailures,
  getLastFailureContext,
} from './state.js'

const MAX_PLAN_ATTEMPTS = 3
const MAX_TASK_FAILURES = 2

const MODE_DESCRIPTIONS: Record<Mode, string> = {
  features: 'Add NEW functionality only. New endpoints, modules, capabilities. Do NOT refactor, fix bugs, or improve existing code that already works.',
  improve: 'Improve EXISTING code only. Fix bugs, optimize, refactor, add test coverage, harden error handling. Do NOT add new user-facing features or endpoints.',
  both: 'Both features and improvements. Pick whichever is highest impact for this iteration.',
  custom: 'Custom mode. Follow the constraints below.',
}

function loadCodebase(cwd: string): string {
  const file = path.join(cwd, NIGHTSHIFT_DIR, 'codebase.md')
  if (!fs.existsSync(file)) return 'No codebase overview available.'
  return fs.readFileSync(file, 'utf-8')
}

function buildQueuePrompt(
  queueTask: string,
  config: NightshiftConfig,
  state: RunState,
  codebase: string,
  failureContext?: string,
): string {
  const parts = [
    'You are a task planner for Nightshift, an autonomous development system.',
    '',
    `The user has requested this specific task:`,
    `TASK: ${queueTask}`,
    '',
    `MODE: ${config.mode} — ${MODE_DESCRIPTIONS[config.mode]}`,
    '',
    '<codebase-overview>',
    codebase,
    '</codebase-overview>',
    '',
    'COMPLETED TASKS (for context):',
    formatCompletedForPrompt(state.completed),
  ]

  if (failureContext) {
    parts.push(
      '',
      'PREVIOUS ATTEMPT FAILED:',
      failureContext,
      '',
      'Adjust your plan to avoid the same failure. Suggest different target files or a different approach.',
    )
  }

  parts.push(
    '',
    'Break this task into a concrete execution plan. Identify which files to create or modify based on the codebase.',
    '',
    'Output ONLY this JSON (no markdown, no explanation):',
    '{',
    `  "task": "${queueTask}",`,
    '  "targetFiles": ["files to create or modify"],',
    '  "rationale": "how to implement this, what patterns to follow",',
    '  "category": "feature" or "improvement"',
    '}',
  )

  return parts.join('\n')
}

function buildAutonomousPrompt(
  config: NightshiftConfig,
  state: RunState,
  codebase: string,
): string {
  const modeDesc = config.mode === 'custom' && config.customMission
    ? config.customMission
    : MODE_DESCRIPTIONS[config.mode]

  const parts = [
    'You are a task planner for Nightshift, an autonomous development system.',
    '',
    'Your job: propose exactly ONE task for the next iteration.',
    '',
    `MODE: ${config.mode} — ${modeDesc}`,
    '',
    '<codebase-overview>',
    codebase,
    '</codebase-overview>',
    '',
    'COMPLETED TASKS:',
    formatCompletedForPrompt(state.completed),
    '',
    'FAILED TASKS:',
    formatFailedForPrompt(state.failed),
    '',
    'BLOCKED TASKS (do not re-propose these):',
    formatBlockedForPrompt(state.blocked),
  ]

  if (config.constraints) {
    parts.push('', `CONSTRAINTS: ${config.constraints}`)
  }
  if (config.exclude.length > 0) {
    parts.push('', `DO NOT TOUCH: ${config.exclude.join(', ')}`)
  }

  parts.push(
    '',
    'Propose a task that:',
    `- Matches the mode (${config.mode})`,
    '- Has not already been completed',
    '- Is not blocked',
    '- Can be completed in a single iteration',
    '- Follows existing codebase patterns and conventions',
    '',
    'Output ONLY this JSON (no markdown, no explanation):',
    '{',
    '  "task": "concise description of what to build or fix",',
    '  "targetFiles": ["files to create or modify"],',
    '  "rationale": "why this task, what existing patterns to follow",',
    '  "category": "feature" or "improvement"',
    '}',
  )

  return parts.join('\n')
}

function validatePlan(plan: TaskPlan, config: NightshiftConfig, state: RunState): string | null {
  // Category must match mode
  if (config.mode === 'features' && plan.category !== 'feature') {
    return `Plan category "${plan.category}" does not match features mode`
  }
  if (config.mode === 'improve' && plan.category !== 'improvement') {
    return `Plan category "${plan.category}" does not match improve mode`
  }

  // Task must not be blocked
  if (isTaskBlocked(state, plan.task)) {
    return `Task "${plan.task}" is blocked`
  }

  // Task must not have failed too many times
  if (getTaskFailures(state, plan.task) >= MAX_TASK_FAILURES) {
    return `Task "${plan.task}" has failed ${MAX_TASK_FAILURES} times`
  }

  // Target files must not be in excluded directories
  for (const file of plan.targetFiles) {
    for (const excluded of config.exclude) {
      if (file.startsWith(excluded)) {
        return `Target file "${file}" is in excluded directory "${excluded}"`
      }
    }
  }

  // Check for near-duplicate of completed tasks
  for (const completed of state.completed) {
    if (completed.task.toLowerCase() === plan.task.toLowerCase()) {
      return `Task "${plan.task}" was already completed in iteration ${completed.iteration}`
    }
  }

  return null // valid
}

export async function planTask(
  config: NightshiftConfig,
  state: RunState,
  cwd: string,
): Promise<TaskPlan | null> {
  const codebase = loadCodebase(cwd)

  // Check if we should pick from the work queue
  const queueTask = getNextQueueTask(config, state)

  for (let attempt = 0; attempt < MAX_PLAN_ATTEMPTS; attempt++) {
    let prompt: string

    if (queueTask) {
      const failureCtx = getLastFailureContext(state, queueTask)
      prompt = buildQueuePrompt(queueTask, config, state, codebase, failureCtx)
    } else {
      prompt = buildAutonomousPrompt(config, state, codebase)
    }

    const plan = await runClaudeJSON<TaskPlan>({
      prompt,
      model: config.plannerModel,
      cwd,
      timeout: 60_000, // 1 min for planning
      skipPermissions: true,
    })

    if (!plan) {
      continue // parse failure, retry
    }

    // Validate plan
    const error = validatePlan(plan, config, state)
    if (error) {
      // If it's a queue task that's been blocked by validation, block it
      if (queueTask && getTaskFailures(state, queueTask) >= MAX_TASK_FAILURES) {
        return null
      }
      continue // invalid plan, retry
    }

    return plan
  }

  return null // all attempts failed
}

function getNextQueueTask(config: NightshiftConfig, state: RunState): string | null {
  if (config.workQueue.length === 0) return null

  for (let i = 0; i < config.workQueue.length; i++) {
    const progress = state.queueProgress[i]
    if (progress === 'done' || progress === 'blocked') continue

    const task = config.workQueue[i].task
    if (isTaskBlocked(state, task)) {
      state.queueProgress[i] = 'blocked'
      continue
    }

    return task
  }

  return null // all items done or blocked
}

export function isQueueExhausted(config: NightshiftConfig, state: RunState): boolean {
  if (config.workQueue.length === 0) return true

  for (let i = 0; i < config.workQueue.length; i++) {
    const progress = state.queueProgress[i]
    if (progress !== 'done' && progress !== 'blocked') {
      const task = config.workQueue[i].task
      if (!isTaskBlocked(state, task)) return false
    }
  }

  return true
}

export function markQueueItemDone(config: NightshiftConfig, state: RunState, task: string): void {
  for (let i = 0; i < config.workQueue.length; i++) {
    if (config.workQueue[i].task === task) {
      state.queueProgress[i] = 'done'
      return
    }
  }
}

export function markQueueItemBlocked(config: NightshiftConfig, state: RunState, task: string): void {
  for (let i = 0; i < config.workQueue.length; i++) {
    if (config.workQueue[i].task === task) {
      state.queueProgress[i] = 'blocked'
      return
    }
  }
}
