import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import pc from 'picocolors'
import * as p from '@clack/prompts'
import { configExists, readConfig, isV2Config, NIGHTSHIFT_DIR } from './config.js'

function exec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function cancel(message = 'Reset cancelled.'): never {
  p.cancel(message)
  process.exit(0)
}

export async function reset(): Promise<void> {
  const cwd = process.cwd()

  if (!configExists(cwd)) {
    console.error(pc.red('No nightshift config found. Run `nightshift init` first.'))
    process.exit(1)
  }

  const config = readConfig(cwd)

  if (!isV2Config(config)) {
    console.error(pc.red('Reset requires v0.2.0 config. Run `nightshift init` to upgrade.'))
    process.exit(1)
  }

  p.intro(pc.bgCyan(pc.black(' nightshift reset ')))

  // ── Show current state ─────────────────────────────────────────────────
  const statePath = path.join(cwd, NIGHTSHIFT_DIR, 'state.json')
  const logsDir = path.join(cwd, NIGHTSHIFT_DIR, 'logs')
  const codebasePath = path.join(cwd, NIGHTSHIFT_DIR, 'codebase.md')

  const hasState = fs.existsSync(statePath)
  let logCount = 0
  if (fs.existsSync(logsDir)) {
    logCount = fs.readdirSync(logsDir).filter(f => f.endsWith('.log')).length
  }

  if (hasState) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
    p.note(
      [
        `${pc.bold('Iterations:')}  ${state.iteration}`,
        `${pc.bold('Committed:')}   ${state.completed?.length ?? 0}`,
        `${pc.bold('Failed:')}      ${state.failed?.length ?? 0}`,
        `${pc.bold('Blocked:')}     ${state.blocked?.length ?? 0}`,
        `${pc.bold('Log files:')}   ${logCount}`,
      ].join('\n'),
      'Previous run'
    )
  } else {
    p.log.info('No previous run state found.')
  }

  // ── Confirm reset ──────────────────────────────────────────────────────
  const confirm = await p.confirm({
    message: 'Clear state, logs, and notes? Config and work queue are preserved.',
    initialValue: true,
  })
  if (p.isCancel(confirm) || !confirm) cancel()

  // Clear state.json
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath)

  // Clear logs
  if (fs.existsSync(logsDir)) {
    for (const f of fs.readdirSync(logsDir)) {
      fs.unlinkSync(path.join(logsDir, f))
    }
  }

  // Reset notes
  const notesPath = path.join(cwd, NIGHTSHIFT_DIR, 'notes.md')
  fs.writeFileSync(notesPath, '# Nightshift Notes\n', 'utf-8')

  // Clear iteration artifacts
  for (const artifact of ['iteration.json', 'summary.txt']) {
    const p2 = path.join(cwd, NIGHTSHIFT_DIR, artifact)
    if (fs.existsSync(p2)) fs.unlinkSync(p2)
  }

  p.log.success('Cleared state, logs, and notes.')

  // ── Branch handling ────────────────────────────────────────────────────
  const currentBranch = exec('git branch --show-current', cwd)
  const branchExists = exec(`git rev-parse --verify ${config.branch}`, cwd) !== ''

  if (branchExists) {
    let baseBranch = ''
    for (const base of ['main', 'master']) {
      const exists = exec(`git rev-parse --verify ${base}`, cwd)
      if (exists) { baseBranch = base; break }
    }

    if (baseBranch) {
      let merged = false
      try {
        execSync(`git merge-base --is-ancestor ${config.branch} ${baseBranch}`, { cwd, stdio: 'pipe' })
        merged = true
      } catch {
        merged = false
      }

      if (merged) {
        p.log.info(`Branch ${pc.cyan(config.branch)} was already merged into ${baseBranch}.`)
        const deleteBranch = await p.confirm({
          message: `Delete ${config.branch}? (nightshift run will create a fresh one)`,
          initialValue: true,
        })
        if (p.isCancel(deleteBranch)) cancel()

        if (deleteBranch) {
          if (currentBranch === config.branch) {
            execSync(`git checkout ${baseBranch}`, { cwd, stdio: 'pipe' })
          }
          execSync(`git branch -d ${config.branch}`, { cwd, stdio: 'pipe' })
          p.log.success(`Deleted branch ${config.branch}`)
        }
      } else {
        p.log.warn(`Branch ${pc.cyan(config.branch)} exists but hasn't been merged.`)
        const action = await p.select({
          message: 'What should we do with the unmerged branch?',
          options: [
            { value: 'keep', label: 'Keep it', hint: 'next run resumes on this branch' },
            { value: 'delete', label: 'Delete it', hint: 'WARNING: unmerged commits will be lost' },
          ],
        })
        if (p.isCancel(action)) cancel()

        if (action === 'delete') {
          if (currentBranch === config.branch) {
            const base = baseBranch || 'main'
            execSync(`git checkout ${base}`, { cwd, stdio: 'pipe' })
          }
          execSync(`git branch -D ${config.branch}`, { cwd, stdio: 'pipe' })
          p.log.success(`Deleted branch ${config.branch}`)
        }
      }
    }
  }

  // ── Refresh codebase.md ────────────────────────────────────────────────
  if (fs.existsSync(codebasePath)) {
    const refresh = await p.confirm({
      message: 'Refresh codebase overview? (recommended if code changed)',
      initialValue: true,
    })
    if (p.isCancel(refresh)) cancel()

    if (refresh) {
      fs.unlinkSync(codebasePath)
      p.log.success('Cleared codebase.md — will regenerate on next run.')
    }
  }

  // ── Done ───────────────────────────────────────────────────────────────
  console.log()
  p.note(
    [
      `${pc.dim('Same work queue?')}  Run ${pc.cyan('nightshift run')}`,
      `${pc.dim('New direction?')}    Run ${pc.cyan('nightshift init')} to reconfigure`,
    ].join('\n'),
    'Next steps'
  )

  p.outro(pc.green('Reset complete.'))
}
