import { createRequire } from 'node:module'
import { Command } from 'commander'

const require = createRequire(import.meta.url)
const { version, description } = require('../package.json')

const program = new Command()

program
  .name('nightshift')
  .description(description)
  .version(version)

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
