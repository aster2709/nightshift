import fs from 'node:fs'
import path from 'node:path'

export type ProjectType = 'node' | 'python' | 'rust' | 'go' | 'generic'

export interface ProjectInfo {
  type: ProjectType
  name: string
  description: string
  packageManager?: string
}

export async function detectProject(dir: string): Promise<ProjectInfo> {
  // Node
  const pkgPath = path.join(dir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const pm = detectNodePackageManager(dir)
    return {
      type: 'node',
      name: pkg.name ?? path.basename(dir),
      description: pkg.description ?? '',
      packageManager: pm,
    }
  }

  // Python
  const pyprojectPath = path.join(dir, 'pyproject.toml')
  if (fs.existsSync(pyprojectPath)) {
    const content = fs.readFileSync(pyprojectPath, 'utf-8')
    const name = extractTomlValue(content, 'name') ?? path.basename(dir)
    const description = extractTomlValue(content, 'description') ?? ''
    return { type: 'python', name, description }
  }

  // Rust
  const cargoPath = path.join(dir, 'Cargo.toml')
  if (fs.existsSync(cargoPath)) {
    const content = fs.readFileSync(cargoPath, 'utf-8')
    const name = extractTomlValue(content, 'name') ?? path.basename(dir)
    const description = extractTomlValue(content, 'description') ?? ''
    return { type: 'rust', name, description }
  }

  // Go
  const goModPath = path.join(dir, 'go.mod')
  if (fs.existsSync(goModPath)) {
    const content = fs.readFileSync(goModPath, 'utf-8')
    const moduleMatch = content.match(/^module\s+(.+)$/m)
    const name = moduleMatch ? moduleMatch[1].trim() : path.basename(dir)
    return { type: 'go', name, description: '' }
  }

  // Generic
  return {
    type: 'generic',
    name: path.basename(dir),
    description: '',
  }
}

export async function detectEvalCommands(dir: string, info: ProjectInfo): Promise<string[]> {
  const commands: string[] = []

  switch (info.type) {
    case 'node': {
      const pm = info.packageManager ?? 'npm'
      const run = pm === 'npm' ? 'npm run' : pm
      const pkgPath = path.join(dir, 'package.json')
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        const scripts = pkg.scripts ?? {}
        const evalScripts = ['typecheck', 'tsc', 'lint', 'check', 'test']
        for (const name of evalScripts) {
          if (scripts[name]) {
            commands.push(`${run} ${name}`)
          }
        }
        // Also check for tsc --noEmit in scripts
        if (!scripts['typecheck'] && !scripts['tsc']) {
          const hasTsc = pkg.devDependencies?.typescript || pkg.dependencies?.typescript
          if (hasTsc) {
            commands.push(`npx tsc --noEmit`)
          }
        }
      }
      break
    }

    case 'python': {
      const pyprojectPath = path.join(dir, 'pyproject.toml')
      const content = fs.existsSync(pyprojectPath)
        ? fs.readFileSync(pyprojectPath, 'utf-8')
        : ''

      if (content.includes('pytest') || fs.existsSync(path.join(dir, 'tests'))) {
        commands.push('pytest')
      }
      if (content.includes('mypy')) {
        commands.push('mypy .')
      }
      if (content.includes('ruff')) {
        commands.push('ruff check .')
      } else if (content.includes('flake8')) {
        commands.push('flake8 .')
      }
      break
    }

    case 'rust': {
      commands.push('cargo test')
      commands.push('cargo clippy -- -D warnings')
      break
    }

    case 'go': {
      commands.push('go test ./...')
      commands.push('go vet ./...')
      break
    }

    case 'generic': {
      const makefilePath = path.join(dir, 'Makefile')
      if (fs.existsSync(makefilePath)) {
        const content = fs.readFileSync(makefilePath, 'utf-8')
        const targets = ['test', 'lint', 'check']
        for (const target of targets) {
          const re = new RegExp(`^${target}\\s*:`, 'm')
          if (re.test(content)) {
            commands.push(`make ${target}`)
          }
        }
      }
      break
    }
  }

  return commands
}

export async function detectExistingContext(dir: string): Promise<string> {
  const MAX_CHARS = 2000
  const parts: string[] = []

  const readmePath = path.join(dir, 'README.md')
  if (fs.existsSync(readmePath)) {
    const content = fs.readFileSync(readmePath, 'utf-8')
    parts.push('# README.md\n' + content.slice(0, MAX_CHARS))
  }

  const claudeMdPath = path.join(dir, 'CLAUDE.md')
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, 'utf-8')
    parts.push('# CLAUDE.md\n' + content.slice(0, MAX_CHARS))
  }

  return parts.join('\n\n')
}

// --- helpers ---

function detectNodePackageManager(dir: string): string {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn'
  if (fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun'
  return 'npm'
}

function extractTomlValue(content: string, key: string): string | undefined {
  const re = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm')
  const match = content.match(re)
  return match ? match[1] : undefined
}
