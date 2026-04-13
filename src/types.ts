// Shared types for the nightshift orchestrator

export interface TaskPlan {
  task: string
  targetFiles: string[]
  rationale: string
  category: 'feature' | 'improvement'
}

export interface IterationOutput {
  summary: string
  filesChanged: string[]
  confidence: number
}

export interface EvalResult {
  passed: boolean
  failedCommand?: string
  errorSnippet?: string
}

export interface Verdict {
  verdict: 'commit' | 'reject' | 'block'
  modeMatch: boolean
  taskMatch: boolean
  proportionality: 'ok' | 'trivial' | 'bloated'
  reason: string
}

export interface CompletedTask {
  iteration: number
  task: string
  files: string[]
  category: string
  summary: string
}

export interface FailedTask {
  iteration: number
  task: string
  evalFailed?: string
  errorSnippet?: string
  rejectReason?: string
  attempts: number
}

export interface BlockedTask {
  task: string
  reason: string
  since: number
}

export interface RunState {
  iteration: number
  completed: CompletedTask[]
  failed: FailedTask[]
  blocked: BlockedTask[]
  queueProgress: Record<number, 'done' | 'blocked'>
  evaluatorFailures: number
}

export type IterationOutcome =
  | { outcome: 'commit'; plan: TaskPlan; summary: string; filesChanged: string[] }
  | { outcome: 'reject'; plan: TaskPlan; reason: string; evalFailed?: string; errorSnippet?: string }
  | { outcome: 'block'; plan: TaskPlan; reason: string }
  | { outcome: 'no-op'; plan?: TaskPlan; reason: string }
  | { outcome: 'crash'; plan?: TaskPlan; exitCode: number }
  | { outcome: 'timeout'; plan?: TaskPlan }
  | { outcome: 'no-work'; reason: string }
