import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pc from 'picocolors'
import { configExists, readConfig, NIGHTSHIFT_DIR } from './config.js'

export interface RunOptions {
  iterations?: number
  timeout?: number
  branch?: string
}

export async function run(options: RunOptions): Promise<void> {
  const cwd = process.cwd()

  // 1. Check config exists
  if (!configExists(cwd)) {
    console.error(pc.red('No nightshift config found. Run `nightshift init` first.'))
    process.exit(1)
  }

  // 2. Check program.md exists
  const programPath = path.join(cwd, NIGHTSHIFT_DIR, 'program.md')
  if (!fs.existsSync(programPath)) {
    console.error(pc.red(`Missing ${NIGHTSHIFT_DIR}/program.md. This file tells Claude what to build.`))
    process.exit(1)
  }

  // 3. Read config
  const config = readConfig(cwd)

  // 4. Apply CLI overrides
  if (options.iterations !== undefined) config.maxIterations = options.iterations
  if (options.timeout !== undefined) config.timeout = options.timeout
  if (options.branch !== undefined) config.branch = options.branch

  // 5. Show summary
  console.log()
  console.log(pc.bold(pc.cyan('nightshift')) + ' starting autonomous loop')
  console.log()
  console.log(`  ${pc.dim('Branch:')}          ${pc.white(config.branch)}`)
  console.log(`  ${pc.dim('Max iterations:')}  ${pc.white(String(config.maxIterations))}`)
  console.log(`  ${pc.dim('Timeout:')}         ${pc.white(config.timeout + 's per iteration')}`)
  console.log(`  ${pc.dim('Model:')}           ${pc.white(config.model)}`)

  if (config.eval.length > 0) {
    console.log(`  ${pc.dim('Eval gates:')}`)
    for (const cmd of config.eval) {
      console.log(`    ${pc.yellow('$')} ${cmd}`)
    }
  } else {
    console.log(`  ${pc.dim('Eval gates:')}      ${pc.dim('none (commits will not be verified)')}`)
  }

  console.log()

  // 6. Resolve path to run.sh
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'run.sh')

  if (!fs.existsSync(scriptPath)) {
    console.error(pc.red(`Could not find run.sh at ${scriptPath}`))
    process.exit(1)
  }

  // 7. Spawn run.sh
  const child = spawn('bash', [scriptPath, cwd], {
    stdio: 'inherit',
    env: {
      ...process.env,
      MAX_ITERATIONS: String(config.maxIterations),
      MAX_CONSECUTIVE_FAILURES: String(config.maxConsecutiveFailures),
      TIMEOUT: String(config.timeout),
      MODEL: config.model,
      NIGHTSHIFT_BRANCH: config.branch,
    },
  })

  // 8. Handle exit
  child.on('error', (err) => {
    console.error(pc.red(`Failed to start run.sh: ${err.message}`))
    process.exit(1)
  })

  child.on('close', (code) => {
    console.log()
    if (code === 0) {
      console.log(pc.green(pc.bold('nightshift completed successfully.')))
      console.log(pc.dim(`Review changes: git log --oneline main..${config.branch}`))
    } else {
      console.error(pc.red(`nightshift exited with code ${code}`))
    }
    process.exit(code ?? 1)
  })
}
