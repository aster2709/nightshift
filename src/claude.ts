import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { NIGHTSHIFT_DIR } from './config.js'

export interface ClaudeOptions {
  prompt: string
  model: string
  cwd: string
  timeout: number
  skipPermissions?: boolean
}

export interface ClaudeResult {
  output: string
  exitCode: number
  timedOut: boolean
}

export async function runClaude(opts: ClaudeOptions): Promise<ClaudeResult> {
  const { prompt, model, cwd, timeout, skipPermissions = false } = opts

  // Write prompt to temp file to avoid argument length limits
  const tmpDir = path.join(cwd, NIGHTSHIFT_DIR)
  fs.mkdirSync(tmpDir, { recursive: true })
  const tmpFile = path.join(tmpDir, `.tmp_prompt_${Date.now()}.txt`)
  fs.writeFileSync(tmpFile, prompt, 'utf-8')

  const flags = [
    `claude -p "$(cat '${tmpFile}')"`,
    `--model ${model}`,
    '--output-format text',
    ...(skipPermissions ? ['--dangerously-skip-permissions'] : []),
  ].join(' ')

  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', flags], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // Give it a moment to die, then force kill
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
      }, 5000)
    }, timeout)

    child.on('close', (code) => {
      clearTimeout(timer)
      try { fs.unlinkSync(tmpFile) } catch {}
      resolve({
        output: stdout.trim(),
        exitCode: timedOut ? 124 : (code ?? 1),
        timedOut,
      })
    })

    child.on('error', () => {
      clearTimeout(timer)
      try { fs.unlinkSync(tmpFile) } catch {}
      resolve({
        output: '',
        exitCode: 1,
        timedOut: false,
      })
    })
  })
}

/**
 * Run claude and parse JSON from the output.
 * Extracts the first valid JSON object from the response.
 */
export async function runClaudeJSON<T>(opts: ClaudeOptions): Promise<T | null> {
  const result = await runClaude(opts)
  if (result.exitCode !== 0) return null
  return parseJSON<T>(result.output)
}

export function parseJSON<T>(text: string): T | null {
  // Try direct parse first
  try {
    return JSON.parse(text) as T
  } catch {}

  // Extract JSON from markdown code blocks or mixed output
  // Match objects {} or arrays []
  const objectMatch = text.match(/\{[\s\S]*\}/)
  if (objectMatch) {
    try { return JSON.parse(objectMatch[0]) as T } catch {}
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]) as T } catch {}
  }

  return null
}
