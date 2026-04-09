import { execSync } from 'node:child_process'
import pc from 'picocolors'
import { configExists, readConfig } from './config.js'

function exec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function branchExists(branch: string, cwd: string): boolean {
  return exec(`git rev-parse --verify ${branch}`, cwd) !== ''
}

function findBaseBranch(cwd: string): string | null {
  if (branchExists('main', cwd)) return 'main'
  if (branchExists('master', cwd)) return 'master'
  return null
}

export async function diff(): Promise<void> {
  const cwd = process.cwd()

  if (!configExists(cwd)) {
    console.error(pc.red('No nightshift config found. Run `nightshift init` first.'))
    process.exit(1)
  }

  const config = readConfig(cwd)
  const currentBranch = exec('git branch --show-current', cwd)

  if (currentBranch !== config.branch) {
    console.log()
    console.log(pc.yellow(`Note: you are on \`${currentBranch}\`, not \`${config.branch}\`.`))
    console.log(pc.dim(`  Run \`git checkout ${config.branch}\` to switch.`))
    console.log()
  }

  const base = findBaseBranch(cwd)

  console.log()
  console.log(pc.bold(pc.cyan('nightshift')) + ' diff')
  console.log()

  if (base) {
    const range = `${base}..HEAD`

    console.log(pc.dim(`  Comparing ${pc.white(range)}`))
    console.log()

    // Commit log
    console.log(pc.bold('  Commits:'))
    console.log()
    try {
      execSync(`git log --oneline ${range}`, { cwd, stdio: 'inherit' })
    } catch {
      console.log(pc.dim('  No commits found.'))
    }

    console.log()
    console.log(pc.bold('  Files changed:'))
    console.log()
    try {
      execSync(`git diff --stat ${range}`, { cwd, stdio: 'inherit' })
    } catch {
      console.log(pc.dim('  No changes.'))
    }
  } else {
    // No base branch found, show absolute log
    console.log(pc.dim('  No main/master branch found. Showing full log.'))
    console.log()

    console.log(pc.bold('  Commits:'))
    console.log()
    try {
      execSync('git log --oneline -20', { cwd, stdio: 'inherit' })
    } catch {
      console.log(pc.dim('  No commits found.'))
    }
  }

  console.log()
}
