import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import pc from 'picocolors'
import { configExists, readConfig, isV2Config, NIGHTSHIFT_DIR } from './config.js'
import { loadState } from './state.js'

function exec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function isRunning(): boolean {
  try {
    // Check for running orchestrator or run.sh
    const result = execSync('pgrep -f "nightshift.*run"', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    return result.trim().length > 0
  } catch {
    return false
  }
}

function getTimingFromLogs(logsDir: string): { avgSeconds: number; totalMinutes: number; count: number } {
  if (!fs.existsSync(logsDir)) return { avgSeconds: 0, totalMinutes: 0, count: 0 }

  const files = fs.readdirSync(logsDir).filter(f => f.startsWith('iteration_') && f.endsWith('.log'))
  if (files.length < 2) return { avgSeconds: 0, totalMinutes: 0, count: files.length }

  const stats = files
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || '0')
      const numB = parseInt(b.match(/\d+/)?.[0] || '0')
      return numA - numB
    })
    .map(f => fs.statSync(path.join(logsDir, f)).mtimeMs)

  const totalMs = stats[stats.length - 1] - stats[0]
  const totalMinutes = Math.round(totalMs / 60000)
  const avgSeconds = Math.round(totalMs / (stats.length - 1) / 1000)

  return { avgSeconds, totalMinutes, count: files.length }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

export async function status(): Promise<void> {
  const cwd = process.cwd()

  if (!configExists(cwd)) {
    console.error(pc.red('No nightshift config found. Run `nightshift init` first.'))
    process.exit(1)
  }

  const config = readConfig(cwd)
  const v2 = isV2Config(config)

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

  // Running status
  const running = isRunning()

  // Display
  console.log()
  console.log(pc.bold(pc.cyan('nightshift')) + ' status')
  console.log()
  console.log(`  ${pc.dim('Branch:')}       ${pc.white(currentBranch)}`)

  if (v2) {
    const state = loadState(cwd)
    const total = state.completed.length + state.failed.length + state.blocked.length
    const successRate = total > 0
      ? `${Math.round((state.completed.length / (state.completed.length + state.failed.length || 1)) * 100)}%`
      : '-'

    // Status
    let statusText: string
    if (running) {
      statusText = pc.green(pc.bold('Running')) + pc.dim(` (iteration ${state.iteration + 1})`)
    } else if (state.iteration > 0) {
      statusText = pc.yellow('Stopped')
    } else {
      statusText = pc.dim('Not started')
    }

    console.log(`  ${pc.dim('Status:')}       ${statusText}`)
    console.log(`  ${pc.dim('Mode:')}         ${pc.white(config.mode)}`)
    console.log()

    // Iteration stats
    console.log(`  ${pc.dim('Iterations:')}   ${pc.white(String(state.iteration))} run`)
    console.log(`  ${pc.dim('Committed:')}    ${pc.green(String(state.completed.length))}`)
    console.log(`  ${pc.dim('Failed:')}       ${pc.red(String(state.failed.length))}`)
    console.log(`  ${pc.dim('Blocked:')}      ${pc.yellow(String(state.blocked.length))}`)
    console.log(`  ${pc.dim('Success rate:')} ${pc.white(successRate)}`)
    console.log(`  ${pc.dim('Commits:')}      ${pc.white(commitCount)} on branch`)

    // Work queue progress
    if (config.workQueue.length > 0) {
      const done = Object.values(state.queueProgress).filter(s => s === 'done').length
      const blocked = Object.values(state.queueProgress).filter(s => s === 'blocked').length
      const pending = config.workQueue.length - done - blocked

      console.log()
      console.log(`  ${pc.dim('Work queue:')}   ${pc.green(String(done))} done, ${pc.yellow(String(pending))} pending, ${pc.red(String(blocked))} blocked`)
      console.log(`  ${pc.dim('After queue:')}  ${config.afterQueue}`)
    }

    // Timing
    const logsDir = path.join(cwd, NIGHTSHIFT_DIR, 'logs')
    const timing = getTimingFromLogs(logsDir)
    if (timing.avgSeconds > 0) {
      console.log()
      console.log(`  ${pc.dim('Avg per run:')}  ${pc.white(formatDuration(timing.avgSeconds))}`)
      console.log(`  ${pc.dim('Total time:')}   ${pc.white(timing.totalMinutes + 'm')}`)
    }

    // Last completed task
    if (state.completed.length > 0) {
      const last = state.completed[state.completed.length - 1]
      console.log()
      console.log(`  ${pc.dim('Last commit:')}  "${last.summary}"`)
    }

    // Blocked tasks
    if (state.blocked.length > 0) {
      console.log()
      console.log(`  ${pc.dim('Blocked:')}`)
      for (const b of state.blocked) {
        console.log(`    ${pc.red('-')} ${b.task}: ${pc.dim(b.reason)}`)
      }
    }

  } else {
    // v0.1.0 fallback — parse notes.md
    console.log(`  ${pc.dim('Status:')}       ${pc.yellow('v0.1.0 config — run `nightshift init` to upgrade')}`)

    const notesPath = path.join(cwd, NIGHTSHIFT_DIR, 'notes.md')
    if (fs.existsSync(notesPath)) {
      const content = fs.readFileSync(notesPath, 'utf-8')
      const lines = content.split('\n').filter(l => l.startsWith('- **Iteration'))
      const total = lines.length
      const failed = lines.filter(l => l.includes('FAILED')).length
      console.log()
      console.log(`  ${pc.dim('Iterations:')}   ${pc.white(String(total))} attempted`)
      console.log(`  ${pc.dim('Committed:')}    ${pc.green(String(total - failed))}`)
      console.log(`  ${pc.dim('Failed:')}       ${pc.red(String(failed))}`)
    }
  }

  console.log()
  if (baseBranch) {
    console.log(pc.dim(`  Review: git log --oneline ${baseBranch}..${config.branch}`))
  }
  console.log(pc.dim('  Logs:   nightshift logs --list'))
  console.log()
}
