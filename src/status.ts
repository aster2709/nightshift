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
}

function parseNotes(notesPath: string): NotesInfo {
  if (!fs.existsSync(notesPath)) {
    return { total: 0, committed: 0, failed: 0, lastEntry: '' }
  }

  const content = fs.readFileSync(notesPath, 'utf-8')
  const lines = content.split('\n').filter(Boolean)

  let total = 0
  let failed = 0
  let lastEntry = ''

  for (const line of lines) {
    if (line.startsWith('- **Iteration')) {
      total++
      if (line.includes('FAILED')) {
        failed++
      }
      lastEntry = line
    }
  }

  const committed = total - failed

  return { total, committed, failed, lastEntry }
}

function extractLastMessage(entry: string): string {
  // Try to pull a quoted commit message from the entry
  const quoteMatch = entry.match(/"([^"]+)"/)
  if (quoteMatch) return quoteMatch[1]

  // Try to pull text after the colon
  const colonMatch = entry.match(/:\s*(.+)$/)
  if (colonMatch) return colonMatch[1].trim()

  return entry.slice(0, 60)
}

function extractTimestamp(entry: string): string {
  // Look for a time pattern like (HH:MM) or [HH:MM]
  const timeMatch = entry.match(/\((\d{2}:\d{2})\)/)
  if (timeMatch) return timeMatch[1]

  const bracketMatch = entry.match(/\[(\d{2}:\d{2})\]/)
  if (bracketMatch) return bracketMatch[1]

  return ''
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

  // Count commits on branch vs base
  let commitCount = ''
  const baseBranches = ['main', 'master']
  for (const base of baseBranches) {
    const count = exec(`git rev-list --count ${base}..HEAD`, cwd)
    if (count) {
      commitCount = count
      break
    }
  }
  if (!commitCount) {
    commitCount = exec('git rev-list --count HEAD', cwd) || '0'
  }

  // Determine status
  const running = isRunning()
  let statusText: string
  if (running) {
    statusText = pc.green(pc.bold(`Running`)) + pc.dim(` (iteration ${notes.total + 1})`)
  } else if (notes.total > 0) {
    statusText = pc.yellow('Stopped')
  } else {
    statusText = pc.dim('Not started')
  }

  // Format last entry
  let lastText = pc.dim('none')
  if (notes.lastEntry) {
    const msg = extractLastMessage(notes.lastEntry)
    const time = extractTimestamp(notes.lastEntry)
    lastText = `"${msg}"` + (time ? pc.dim(` (${time})`) : '')
  }

  // Check codebase overview
  const codebasePath = path.join(cwd, NIGHTSHIFT_DIR, 'codebase.md')
  const hasCodebase = fs.existsSync(codebasePath)

  // Display
  console.log()
  console.log(pc.bold(pc.cyan('nightshift')) + ' status')
  console.log()
  console.log(`  ${pc.dim('Branch:')}       ${pc.white(currentBranch)}`)
  console.log(`  ${pc.dim('Status:')}       ${statusText}`)
  console.log(`  ${pc.dim('Discovery:')}    ${hasCodebase ? pc.green('codebase.md generated') : pc.yellow('pending (runs on first nightshift run)')}`)
  console.log(`  ${pc.dim('Iterations:')}   ${pc.white(String(notes.total))} attempted, ${pc.green(String(notes.committed))} committed, ${pc.red(String(notes.failed))} failed`)
  console.log(`  ${pc.dim('Commits:')}      ${pc.white(commitCount)} on branch`)
  console.log(`  ${pc.dim('Last:')}         ${lastText}`)
  console.log()
  console.log(pc.dim('  Review:'))
  console.log(pc.dim(`    git log --oneline main..${config.branch}`))
  console.log(pc.dim(`    cat ${NIGHTSHIFT_DIR}/notes.md`))
  console.log()
}
