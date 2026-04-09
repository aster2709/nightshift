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
  console.log(`    ${pc.cyan('nightshift init')}     Interactive setup: mission, eval gate, codebase discovery`)
  console.log(`    ${pc.cyan('nightshift run')}      Start the autonomous loop`)
  console.log(`    ${pc.cyan('nightshift status')}   Check progress`)
  console.log()
  console.log(pc.dim('  Each iteration: Claude does one unit of work, eval gate verifies'))
  console.log(pc.dim('  quality, pass = commit, fail = reset and retry.'))
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

program.parse()
