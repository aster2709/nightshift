import pc from 'picocolors'
import { configExists, readConfig, isV2Config, NIGHTSHIFT_DIR } from './config.js'
import { orchestrate } from './orchestrator.js'

export interface RunOptions {
  iterations?: number
  timeout?: number
  branch?: string
}

export async function run(options: RunOptions): Promise<void> {
  const cwd = process.cwd()

  // Check config exists
  if (!configExists(cwd)) {
    console.error(pc.red('No nightshift config found. Run `nightshift init` first.'))
    process.exit(1)
  }

  // Read config
  const config = readConfig(cwd)

  // Check for v0.2.0 config
  if (!isV2Config(config)) {
    console.error(pc.red('Config is from v0.1.0. Run `nightshift init` to upgrade to v0.2.0.'))
    process.exit(1)
  }

  // Apply CLI overrides
  if (options.iterations !== undefined) config.maxIterations = options.iterations
  if (options.timeout !== undefined) config.timeout = options.timeout
  if (options.branch !== undefined) config.branch = options.branch

  // Run the orchestrator
  await orchestrate(config, cwd)
}
