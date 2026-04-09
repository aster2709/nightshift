import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import pc from 'picocolors'
import { configExists, readConfig, NIGHTSHIFT_DIR } from './config.js'

function exec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function isRunning(): boolean {
  try {
    const result = execSync('pgrep -f "run\\.sh"', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    return result.trim().length > 0
  } catch {
    return false
  }
}

interface NotesInfo {
  total: number
  committed: number
  failed: number
  lastEntry: string
  firstTime: string
  lastTime: string
}

function parseNotes(notesPath: string): NotesInfo {
  if (!fs.existsSync(notesPath)) {
    return { total: 0, committed: 0, failed: 0, lastEntry: '', firstTime: '', lastTime: '' }
  }

  const content = fs.readFileSync(notesPath, 'utf-8')
  const lines = content.split('\n').filter(Boolean)

  let total = 0
  let failed = 0
  let lastEntry = ''
  let firstTime = ''
  let lastTime = ''

  for (const line of lines) {
    if (line.startsWith('- **Iteration')) {
      total++
      if (line.includes('FAILED')) {
        failed++
      }
      const time = extractTimestamp(line)
      if (time && !firstTime) firstTime = time
      if (time) lastTime = time
      lastEntry = line
    }
  }

  const committed = total - failed

  return { total, committed, failed, lastEntry, firstTime, lastTime }
}

function extractLastMessage(entry: string): string {
  const colonMatch = entry.match(/\):\s*(.+)$/)
  if (colonMatch) return colonMatch[1].trim()
  return entry.slice(0, 60)
}

function extractTimestamp(entry: string): string {
  const timeMatch = entry.match(/\((\d{2}:\d{2})\)/)
  if (timeMatch) return timeMatch[1]
  return ''
}

function getTimingFromLogs(logsDir: string): { avgSeconds: number, totalMinutes: number, count: number } {
  if (!fs.existsSync(logsDir)) return { avgSeconds: 0, totalMinutes: 0, count: 0 }

  const files = fs.readdirSync(logsDir).filter(f => f.startsWith('iteration_') && f.endsWith('.log'))
  if (files.length === 0) return { avgSeconds: 0, totalMinutes: 0, count: 0 }

  // Get timing from file modification timestamps (start = previous file's mtime, end = this file's mtime)
  const stats = files
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || '0')
      const numB = parseInt(b.match(/\d+/)?.[0] || '0')
      return numA - numB
    })
    .map(f => fs.statSync(path.join(logsDir, f)).mtimeMs)

  if (stats.length < 2) {
    // Single log: estimate from file creation to modification
    return { avgSeconds: 0, totalMinutes: 0, count: files.length }
  }

  // Total time = last log mtime - first log mtime
  const totalMs = stats[stats.length - 1] - stats[0]
  const totalMinutes = Math.round(totalMs / 60000)
  const avgSeconds = Math.round(totalMs / (stats.length - 1) / 1000)

  return { avgSeconds, totalMinutes, count: files.length }
}

export async function status(): Promise<void> {
  const cwd = process.cwd()

  if (!configExists(cwd)) {
    console.error(pc.red('No nightshift config found. Run `nightshift init` first.'))
    process.exit(1)
  }

  const config = readConfig(cwd)
  const notesPath = path.join(cwd, NIGHTSHIFT_DIR, 'notes.md')
  const notes = parseNotes(notesPath)

  // Git info
  const currentBranch = exec('git branch --show-current', cwd) || 'unknown'

  let commitCount = ''
  let baseBranch = ''
  for (const base of ['main', 'master']) {
    const count = exec(`git rev-list --count ${base}..HEAD`, cwd)
    if (count) {
      commitCount = count
      baseBranch = base
      break
    }
  }
  if (!commitCount) {
    commitCount = exec('git rev-list --count HEAD', cwd) || '0'
  }

  // Timing
  const logsDir = path.join(cwd, NIGHTSHIFT_DIR, 'logs')
  const timing = getTimingFromLogs(logsDir)

  // Running status
  const running = isRunning()
  let statusText: string
  if (running) {
    statusText = pc.green(pc.bold('Running')) + pc.dim(` (iteration ${notes.total + 1})`)
  } else if (notes.total > 0) {
    statusText = pc.yellow('Stopped')
  } else {
    statusText = pc.dim('Not started')
  }

  // Last entry
  let lastText = pc.dim('none')
  if (notes.lastEntry) {
    const msg = extractLastMessage(notes.lastEntry)
    const time = extractTimestamp(notes.lastEntry)
    lastText = `"${msg}"` + (time ? pc.dim(` (${time})`) : '')
  }

  // Success rate
  const successRate = notes.total > 0
    ? `${Math.round((notes.committed / notes.total) * 100)}%`
    : '-'

  // Codebase overview
  const codebasePath = path.join(cwd, NIGHTSHIFT_DIR, 'codebase.md')
  const hasCodebase = fs.existsSync(codebasePath)

  // Display
  console.log()
  console.log(pc.bold(pc.cyan('nightshift')) + ' status')
  console.log()
  console.log(`  ${pc.dim('Branch:')}       ${pc.white(currentBranch)}`)
  console.log(`  ${pc.dim('Status:')}       ${statusText}`)
  console.log(`  ${pc.dim('Discovery:')}    ${hasCodebase ? pc.green('ready') : pc.yellow('pending')}`)
  console.log()
  console.log(`  ${pc.dim('Iterations:')}   ${pc.white(String(notes.total))} attempted, ${pc.green(String(notes.committed))} committed, ${pc.red(String(notes.failed))} failed`)
  console.log(`  ${pc.dim('Success rate:')} ${pc.white(successRate)}`)
  console.log(`  ${pc.dim('Commits:')}      ${pc.white(commitCount)} on branch`)

  if (timing.avgSeconds > 0) {
    console.log()
    console.log(`  ${pc.dim('Avg per run:')}  ${pc.white(formatDuration(timing.avgSeconds))}`)
    console.log(`  ${pc.dim('Total time:')}   ${pc.white(timing.totalMinutes + 'm')}`)
  }

  if (notes.firstTime && notes.lastTime && notes.firstTime !== notes.lastTime) {
    console.log(`  ${pc.dim('Session:')}      ${pc.white(notes.firstTime)} - ${pc.white(notes.lastTime)}`)
  }

  console.log()
  console.log(`  ${pc.dim('Last:')}         ${lastText}`)

  console.log()
  if (baseBranch) {
    console.log(pc.dim(`  Review: git log --oneline ${baseBranch}..${config.branch}`))
  }
  console.log(pc.dim(`  Logs:   nightshift logs --list`))
  console.log()
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}
