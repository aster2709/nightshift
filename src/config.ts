import fs from 'node:fs'
import path from 'node:path'

export const NIGHTSHIFT_DIR = '.nightshift'

export interface NightshiftConfig {
  eval: string[]
  branch: string
  maxIterations: number
  maxConsecutiveFailures: number
  timeout: number
  model: string
  exclude: string[]
}

export const DEFAULT_CONFIG: NightshiftConfig = {
  eval: [],
  branch: 'nightshift/dev',
  maxIterations: 20,
  maxConsecutiveFailures: 3,
  timeout: 900,
  model: 'claude-opus-4-6',
  exclude: [],
}

function configPath(projectDir: string): string {
  return path.join(projectDir, NIGHTSHIFT_DIR, 'config.json')
}

export function configExists(projectDir: string): boolean {
  return fs.existsSync(configPath(projectDir))
}

export function readConfig(projectDir: string): NightshiftConfig {
  const filePath = configPath(projectDir)

  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_CONFIG }
  }

  const raw = fs.readFileSync(filePath, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<NightshiftConfig>

  return { ...DEFAULT_CONFIG, ...parsed }
}

export function writeConfig(projectDir: string, config: NightshiftConfig): void {
  const dir = path.join(projectDir, NIGHTSHIFT_DIR)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(configPath(projectDir), JSON.stringify(config, null, 2) + '\n', 'utf-8')
}
