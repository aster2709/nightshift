import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { Command } from 'commander'
import pc from 'picocolors'

const require = createRequire(import.meta.url)
const { version, description } = require('../package.json')

const WELCOME_FLAG = path.join(os.homedir(), '.nightshift_welcomed')

function showWelcome(): void {
  if (fs.existsSync(WELCOME_FLAG)) return

  console.log()
  console.log(pc.bold(pc.red('  nightshift')) + pc.dim(` v${version}`))
  console.log()
  console.log('  Autonomous overnight development loop for Claude Code.')
  console.log('  Point it at your codebase, define a quality bar, go to sleep.')
  console.log('  Wake up to a branch with CI-green commits.')
  console.log()
  console.log(pc.dim('  How it works:'))
  console.log(`    ${pc.cyan('nightshift init')}     Setup: mode, work queue, eval gates, discovery`)
  console.log(`    ${pc.cyan('nightshift run')}      Start the autonomous loop`)
  console.log(`    ${pc.cyan('nightshift status')}   Check progress`)
  console.log()
  console.log(pc.dim('  Each iteration: plan → execute → verify → commit/reject.'))
  console.log(pc.dim('  Planner picks a task, agent executes, evaluator gates quality.'))
  console.log()
  console.log(pc.dim(`  Docs: https://github.com/aster2709/nightshift`))
  console.log()

  try { fs.writeFileSync(WELCOME_FLAG, new Date().toISOString(), 'utf-8') } catch {}
}

const program = new Command()

program
  .name('nightshift')
  .description(description)
  .version(version)
  .hook('preAction', () => {
    showWelcome()
  })

program
  .command('init')
  .description('Initialize nightshift in the current project')
  .action(async () => {
    const { init } = await import('./init.js')
    await init()
  })

program
  .command('run')
  .description('Start an autonomous development loop')
  .option('-i, --iterations <n>', 'max iterations to run', parseInt)
  .option('-t, --timeout <seconds>', 'per-iteration timeout in seconds', parseInt)
  .option('-b, --branch <name>', 'branch name to work on')
  .action(async (opts) => {
    const { run } = await import('./run.js')
    await run(opts)
  })

program
  .command('status')
  .description('Show status of the current nightshift session')
  .action(async () => {
    const { status } = await import('./status.js')
    await status()
  })

program
  .command('logs [iteration]')
  .description('Show iteration logs')
  .option('-l, --list', 'list all available logs')
  .action(async (iteration, opts) => {
    const { logs } = await import('./logs.js')
    await logs(iteration ? parseInt(iteration, 10) : undefined, opts)
  })

program
  .command('diff')
  .description('Show changes on the nightshift branch vs base')
  .action(async () => {
    const { diff } = await import('./diff.js')
    await diff()
  })

program.parse()
