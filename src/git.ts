import { execSync } from 'node:child_process'

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

function execSafe(cmd: string, cwd: string): string {
  try {
    return exec(cmd, cwd)
  } catch {
    return ''
  }
}

export function isClean(cwd: string): boolean {
  try {
    exec('git diff --quiet', cwd)
    exec('git diff --cached --quiet', cwd)
    return true
  } catch {
    return false
  }
}

export function currentBranch(cwd: string): string {
  return execSafe('git branch --show-current', cwd) || 'unknown'
}

export function branchExists(branch: string, cwd: string): boolean {
  return execSafe(`git show-ref --verify refs/heads/${branch}`, cwd) !== ''
}

export function createBranch(branch: string, cwd: string): void {
  exec(`git checkout -b ${branch}`, cwd)
}

export function checkoutBranch(branch: string, cwd: string): void {
  exec(`git checkout ${branch}`, cwd)
}

export function hasChanges(cwd: string): boolean {
  return execSafe('git status --porcelain', cwd).length > 0
}

export function hasStagedChanges(cwd: string): boolean {
  try {
    exec('git diff --cached --quiet', cwd)
    return false
  } catch {
    return true
  }
}

export function stageAll(cwd: string, unstagePatterns: string[] = []): void {
  exec('git add -A', cwd)
  for (const pattern of unstagePatterns) {
    try { exec(`git reset -- ${pattern}`, cwd) } catch {}
  }
}

export function commit(message: string, cwd: string): boolean {
  try {
    // Use env var to pass message safely, avoiding shell escaping issues
    execSync('git commit -m "$NIGHTSHIFT_MSG" --no-verify', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NIGHTSHIFT_MSG: message },
    })
    return true
  } catch {
    return false
  }
}

export function getStagedDiff(cwd: string): string {
  return execSafe('git diff --cached', cwd)
}

export function getStagedFiles(cwd: string): string[] {
  const output = execSafe('git diff --cached --name-only', cwd)
  return output ? output.split('\n').filter(Boolean) : []
}

export function getChangedFiles(cwd: string): string[] {
  const output = execSafe('git diff --name-only', cwd)
  const untracked = execSafe('git ls-files --others --exclude-standard', cwd)
  const all = [output, untracked].filter(Boolean).join('\n')
  return all ? all.split('\n').filter(Boolean) : []
}

export function resetAll(cwd: string): void {
  // Unstage everything
  try { execSync('git reset HEAD .', { cwd, stdio: 'pipe' }) } catch {}
  // Reset tracked files to last commit
  try { execSync('git checkout -- .', { cwd, stdio: 'pipe' }) } catch {}
  // Remove untracked files (gitignored files like .nightshift/state.json survive)
  try { execSync('git clean -fd', { cwd, stdio: 'pipe' }) } catch {}
}

export function findBaseBranch(cwd: string): string | null {
  if (branchExists('main', cwd)) return 'main'
  if (branchExists('master', cwd)) return 'master'
  return null
}

export function isBranchBehind(branch: string, base: string, cwd: string): boolean {
  // Check if base has commits that branch doesn't
  const behind = execSafe(`git rev-list --count ${branch}..${base}`, cwd)
  return parseInt(behind || '0', 10) > 0
}

export function rebaseOnto(base: string, cwd: string): boolean {
  try {
    exec(`git rebase ${base}`, cwd)
    return true
  } catch {
    // Abort failed rebase
    try { execSync('git rebase --abort', { cwd, stdio: 'pipe' }) } catch {}
    return false
  }
}
