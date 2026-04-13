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

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function getTimingFromLogs(logsDir: string): { totalMinutes: number; firstTime: Date | null; lastTime: Date | null } {
  if (!fs.existsSync(logsDir)) return { totalMinutes: 0, firstTime: null, lastTime: null }

  const files = fs.readdirSync(logsDir)
    .filter(f => f.startsWith('iteration_') && f.endsWith('.log'))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || '0')
      const numB = parseInt(b.match(/\d+/)?.[0] || '0')
      return numA - numB
    })

  if (files.length < 1) return { totalMinutes: 0, firstTime: null, lastTime: null }

  const stats = files.map(f => fs.statSync(path.join(logsDir, f)).mtime)
  const firstTime = stats[0]
  const lastTime = stats[stats.length - 1]
  const totalMs = lastTime.getTime() - firstTime.getTime()
  const totalMinutes = Math.round(totalMs / 60000)

  return { totalMinutes, firstTime, lastTime }
}

export async function summary(): Promise<void> {
  const cwd = process.cwd()

  if (!configExists(cwd)) {
    console.error(pc.red('No nightshift config found. Run `nightshift init` first.'))
    process.exit(1)
  }

  const config = readConfig(cwd)

  if (!isV2Config(config)) {
    console.error(pc.red('Summary requires v0.2.0 config. Run `nightshift init` to upgrade.'))
    process.exit(1)
  }

  const state = loadState(cwd)

  if (state.iteration === 0) {
    console.log()
    console.log(pc.yellow('No runs yet.') + ' Run `nightshift run` first.')
    console.log()
    return
  }

  // Timing
  const logsDir = path.join(cwd, NIGHTSHIFT_DIR, 'logs')
  const timing = getTimingFromLogs(logsDir)

  // Git stats
  let baseBranch = ''
  let filesChanged = ''
  let insertions = ''
  let deletions = ''
  for (const base of ['main', 'master']) {
    const stat = exec(`git diff --shortstat ${base}..${config.branch}`, cwd)
    if (stat) {
      baseBranch = base
      const filesMatch = stat.match(/(\d+) file/)
      const insMatch = stat.match(/(\d+) insertion/)
      const delMatch = stat.match(/(\d+) deletion/)
      filesChanged = filesMatch?.[1] ?? '0'
      insertions = insMatch?.[1] ?? '0'
      deletions = delMatch?.[1] ?? '0'
      break
    }
  }

  // Header
  console.log()
  console.log(pc.bold(pc.cyan('nightshift')) + ' summary')
  console.log()

  // Time range
  if (timing.firstTime && timing.lastTime) {
    const timeOpts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false }
    const dateOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
    const startDate = timing.firstTime.toLocaleDateString('en-US', dateOpts)
    const startTime = timing.firstTime.toLocaleTimeString('en-US', timeOpts)
    const endTime = timing.lastTime.toLocaleTimeString('en-US', timeOpts)
    console.log(`  ${pc.dim('Run:')}         ${startDate}, ${startTime} — ${endTime} (${formatDuration(timing.totalMinutes)})`)
  }

  console.log(`  ${pc.dim('Mode:')}        ${config.mode}`)
  console.log(`  ${pc.dim('Branch:')}      ${config.branch}`)
  console.log(`  ${pc.dim('Iterations:')}  ${state.iteration} run`)
  console.log()

  // Scoreboard
  const total = state.completed.length + state.failed.length
  const rate = total > 0 ? Math.round((state.completed.length / total) * 100) : 0
  console.log(`  ${pc.green(String(state.completed.length))} committed   ${pc.red(String(state.failed.length))} failed   ${pc.yellow(String(state.blocked.length))} blocked   ${pc.dim(`(${rate}% success)`)}`)

  // Diff stats
  if (filesChanged) {
    console.log(`  ${pc.dim(`${filesChanged} files changed, +${insertions} -${deletions} lines`)}`)
  }

  // Completed tasks
  if (state.completed.length > 0) {
    console.log()
    console.log(pc.bold('  Completed:'))
    for (const task of state.completed) {
      const cat = task.category
        ? pc.dim(` [${task.category}]`)
        : ''
      console.log(`    ${pc.green('✓')} ${task.summary}${cat}`)
      if (task.files && task.files.length > 0) {
        console.log(`      ${pc.dim(task.files.join(', '))}`)
      }
    }
  }

  // Failed tasks
  if (state.failed.length > 0) {
    console.log()
    console.log(pc.bold('  Failed:'))
    for (const task of state.failed) {
      const reason = task.evalFailed
        ? `eval: ${task.evalFailed}`
        : task.rejectReason ?? 'rejected'
      console.log(`    ${pc.red('✗')} ${task.task} ${pc.dim(`(${reason}, ${task.attempts}x)`)}`)
    }
  }

  // Blocked tasks
  if (state.blocked.length > 0) {
    console.log()
    console.log(pc.bold('  Blocked:'))
    for (const b of state.blocked) {
      console.log(`    ${pc.yellow('⊘')} ${b.task}`)
      console.log(`      ${pc.dim(b.reason)}`)
    }
  }

  // Work queue progress
  if (config.workQueue.length > 0) {
    const done = Object.values(state.queueProgress).filter(s => s === 'done').length
    const blocked = Object.values(state.queueProgress).filter(s => s === 'blocked').length
    const pending = config.workQueue.length - done - blocked
    console.log()
    console.log(`  ${pc.dim('Queue:')} ${pc.green(String(done))}/${config.workQueue.length} done` +
      (blocked > 0 ? `, ${pc.yellow(String(blocked))} blocked` : '') +
      (pending > 0 ? `, ${pc.dim(String(pending))} pending` : ''))
  }

  // Footer
  console.log()
  if (baseBranch) {
    console.log(pc.dim(`  Review:  git log --oneline ${baseBranch}..${config.branch}`))
    console.log(pc.dim(`  Diff:    nightshift diff`))
    console.log(pc.dim(`  Merge:   git checkout ${baseBranch} && git merge ${config.branch}`))
  }
  console.log()
}
