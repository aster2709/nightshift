import fs from 'node:fs'
import path from 'node:path'
import { NIGHTSHIFT_DIR } from './config.js'
import type { RunState, CompletedTask, FailedTask, BlockedTask, IterationOutcome } from './types.js'

const STATE_FILE = 'state.json'

function statePath(cwd: string): string {
  return path.join(cwd, NIGHTSHIFT_DIR, STATE_FILE)
}

export function createState(): RunState {
  return {
    iteration: 0,
    completed: [],
    failed: [],
    blocked: [],
    queueProgress: {},
    evaluatorFailures: 0,
  }
}

export function loadState(cwd: string): RunState {
  const file = statePath(cwd)
  if (!fs.existsSync(file)) return createState()

  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<RunState>
    return {
      ...createState(),
      ...parsed,
    }
  } catch {
    return createState()
  }
}

export function saveState(cwd: string, state: RunState): void {
  const dir = path.join(cwd, NIGHTSHIFT_DIR)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(statePath(cwd), JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

export function applyOutcome(state: RunState, result: IterationOutcome): void {
  switch (result.outcome) {
    case 'commit':
      state.completed.push({
        iteration: state.iteration,
        task: result.plan.task,
        files: result.filesChanged,
        category: result.plan.category,
        summary: result.summary,
      })
      state.evaluatorFailures = 0
      break

    case 'reject': {
      const existing = state.failed.find(f => f.task === result.plan.task)
      if (existing) {
        existing.attempts++
        existing.iteration = state.iteration
        existing.evalFailed = result.evalFailed
        existing.errorSnippet = result.errorSnippet
        existing.rejectReason = result.reason
      } else {
        state.failed.push({
          iteration: state.iteration,
          task: result.plan.task,
          evalFailed: result.evalFailed,
          errorSnippet: result.errorSnippet,
          rejectReason: result.reason,
          attempts: 1,
        })
      }
      break
    }

    case 'block':
      state.blocked.push({
        task: result.plan.task,
        reason: result.reason,
        since: state.iteration,
      })
      // Remove from failed list if it was there
      state.failed = state.failed.filter(f => f.task !== result.plan.task)
      break

    case 'no-op':
    case 'crash':
    case 'timeout':
      if (result.plan) {
        const existing = state.failed.find(f => f.task === result.plan!.task)
        if (existing) {
          existing.attempts++
          existing.iteration = state.iteration
        } else {
          state.failed.push({
            iteration: state.iteration,
            task: result.plan.task,
            rejectReason: result.outcome === 'timeout' ? 'timed out' : result.outcome,
            attempts: 1,
          })
        }
      }
      break
  }
}

export function isTaskBlocked(state: RunState, task: string): boolean {
  return state.blocked.some(b => b.task === task)
}

export function getTaskFailures(state: RunState, task: string): number {
  const f = state.failed.find(f => f.task === task)
  return f?.attempts ?? 0
}

export function getLastFailureContext(state: RunState, task: string): string | undefined {
  const f = state.failed.find(f => f.task === task)
  if (!f) return undefined

  const parts: string[] = []
  if (f.evalFailed) parts.push(`Eval failed: ${f.evalFailed}`)
  if (f.errorSnippet) parts.push(`Error: ${f.errorSnippet}`)
  if (f.rejectReason) parts.push(`Reason: ${f.rejectReason}`)
  return parts.join('\n') || undefined
}

export function formatCompletedForPrompt(completed: CompletedTask[]): string {
  if (completed.length === 0) return 'None yet.'
  return completed
    .map(t => `- [${t.category}] ${t.summary} (files: ${t.files.join(', ')})`)
    .join('\n')
}

export function formatFailedForPrompt(failed: FailedTask[]): string {
  if (failed.length === 0) return 'None.'
  return failed
    .map(t => {
      let line = `- ${t.task} (${t.attempts} attempt${t.attempts > 1 ? 's' : ''})`
      if (t.evalFailed) line += ` — eval failed: ${t.evalFailed}`
      if (t.errorSnippet) line += `\n  Error: ${t.errorSnippet.slice(0, 200)}`
      return line
    })
    .join('\n')
}

export function formatBlockedForPrompt(blocked: BlockedTask[]): string {
  if (blocked.length === 0) return 'None.'
  return blocked
    .map(t => `- ${t.task} — ${t.reason}`)
    .join('\n')
}
