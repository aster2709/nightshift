import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { NightshiftConfig, Mode } from './config.js'
import { NIGHTSHIFT_DIR } from './config.js'
import type { TaskPlan, EvalResult, Verdict } from './types.js'
import { runClaudeJSON } from './claude.js'

const MODE_EVAL_DESCRIPTIONS: Record<Mode, string> = {
  features: '"features" mode: changes should add NEW functionality (new endpoints, modules, capabilities). Code reorganization that serves the new feature is acceptable.',
  improve: '"improve" mode: changes should improve EXISTING code (bug fixes, optimization, refactoring, test coverage). File splitting and reorganization is acceptable if it improves code quality.',
  both: '"both" mode: either features or improvements are acceptable.',
  custom: '"custom" mode: evaluate based on task match only.',
}

// ── Shell Eval Gate ──────────────────────────────────────────────────────────

export async function runEvals(evalCommands: string[], cwd: string): Promise<EvalResult> {
  const evalLog = path.join(cwd, NIGHTSHIFT_DIR, 'logs', 'eval_tmp.log')

  for (const cmd of evalCommands) {
    try {
      execSync(cmd, {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000, // 2 min per eval command
      })
    } catch (err) {
      // Capture error output
      let errorSnippet = ''
      if (err && typeof err === 'object') {
        const e = err as { stdout?: string; stderr?: string }
        const output = [e.stdout ?? '', e.stderr ?? ''].join('\n').trim()
        // Last 50 lines
        const lines = output.split('\n')
        errorSnippet = lines.slice(-50).join('\n')
        // Write full output to log
        try { fs.writeFileSync(evalLog, output, 'utf-8') } catch {}
      }

      return {
        passed: false,
        failedCommand: cmd,
        errorSnippet,
      }
    }
  }

  return { passed: true }
}

// ── LLM Evaluator Gate ───────────────────────────────────────────────────────

const DEFAULT_VERDICT: Verdict = {
  verdict: 'commit',
  modeMatch: true,
  taskMatch: true,
  proportionality: 'ok',
  reason: 'evaluator default pass',
}

function buildEvaluatorPrompt(plan: TaskPlan, diff: string, config: NightshiftConfig): string {
  // Truncate diff if too large to keep evaluator fast
  const maxDiffLength = 50_000
  const truncatedDiff = diff.length > maxDiffLength
    ? diff.slice(0, maxDiffLength) + '\n\n... [diff truncated] ...'
    : diff

  return [
    'You are a code reviewer for Nightshift, an autonomous development system.',
    '',
    'The agent was assigned this task:',
    `TASK: ${plan.task}`,
    `CATEGORY: ${plan.category}`,
    `MODE: ${config.mode} — ${MODE_EVAL_DESCRIPTIONS[config.mode]}`,
    '',
    'Here is the diff:',
    '```diff',
    truncatedDiff,
    '```',
    '',
    'Evaluate:',
    '1. Does the diff accomplish the assigned task?',
    '2. Does the diff match the mode?',
    '3. Is the change proportional? (not trivially small like only comments/whitespace, not bloated with unrelated changes)',
    '',
    'Output ONLY this JSON (no markdown, no explanation):',
    '{',
    '  "verdict": "commit" or "reject" or "block",',
    '  "modeMatch": true or false,',
    '  "taskMatch": true or false,',
    '  "proportionality": "ok" or "trivial" or "bloated",',
    '  "reason": "one sentence"',
    '}',
    '',
    'Rules:',
    '- "commit" = work is good, ship it',
    '- "reject" = work has issues, can be retried with a different approach',
    '- "block" = task is fundamentally too large or impossible in one iteration, skip it permanently',
    '- Default to "commit" if the work is reasonable. Do not be overly strict.',
    '- File creation during refactoring (splitting files, extracting modules) is valid in improve mode.',
  ].join('\n')
}

export async function evaluateChanges(
  plan: TaskPlan,
  diff: string,
  config: NightshiftConfig,
  cwd: string,
): Promise<Verdict> {
  if (!diff || diff.trim().length === 0) {
    return {
      verdict: 'reject',
      modeMatch: false,
      taskMatch: false,
      proportionality: 'trivial',
      reason: 'no diff to evaluate',
    }
  }

  const prompt = buildEvaluatorPrompt(plan, diff, config)

  const verdict = await runClaudeJSON<Verdict>({
    prompt,
    model: config.evaluatorModel,
    cwd,
    timeout: 30_000, // 30s for evaluation
    skipPermissions: false, // evaluator doesn't need file access
  })

  if (!verdict || !verdict.verdict) {
    // Evaluator failed to produce output — default to pass
    return DEFAULT_VERDICT
  }

  // Validate verdict shape
  if (!['commit', 'reject', 'block'].includes(verdict.verdict)) {
    return DEFAULT_VERDICT
  }

  return verdict
}
