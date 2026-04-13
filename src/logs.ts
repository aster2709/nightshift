import fs from 'node:fs'
import path from 'node:path'
import pc from 'picocolors'
import { configExists, NIGHTSHIFT_DIR } from './config.js'

interface LogsOptions {
  list?: boolean
}

function getLogsDir(cwd: string): string {
  return path.join(cwd, NIGHTSHIFT_DIR, 'logs')
}

function getLogFiles(logsDir: string): string[] {
  if (!fs.existsSync(logsDir)) return []

  return fs.readdirSync(logsDir)
    .filter(f => /^iteration_\d+\.log$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)![0], 10)
      const numB = parseInt(b.match(/\d+/)![0], 10)
      return numA - numB
    })
}

function iterationNumber(filename: string): number {
  return parseInt(filename.match(/\d+/)![0], 10)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function listLogs(logsDir: string, files: string[]): void {
  console.log()
  console.log(pc.bold(pc.cyan('nightshift')) + ' logs')
  console.log()

  for (const file of files) {
    const filePath = path.join(logsDir, file)
    const stat = fs.statSync(filePath)
    const size = formatBytes(stat.size)
    const modified = stat.mtime.toLocaleString()
    const num = iterationNumber(file)

    console.log(`  ${pc.white(`iteration ${String(num).padStart(3)}`)}  ${pc.dim(size.padStart(10))}  ${pc.dim(modified)}`)
  }

  console.log()
  console.log(pc.dim(`  ${files.length} log file${files.length === 1 ? '' : 's'}`))
  console.log()
}

function showLog(logsDir: string, filename: string): void {
  const filePath = path.join(logsDir, filename)
  const content = fs.readFileSync(filePath, 'utf-8')

  console.log()
  console.log(pc.bold(pc.cyan('nightshift')) + ` ${pc.dim('iteration')} ${iterationNumber(filename)}`)
  console.log()
  console.log(content)
}

export async function logs(iteration: number | undefined, opts: LogsOptions): Promise<void> {
  const cwd = process.cwd()

  if (!configExists(cwd)) {
    console.error(pc.red('No nightshift config found. Run `nightshift init` first.'))
    process.exit(1)
  }

  const logsDir = getLogsDir(cwd)
  const files = getLogFiles(logsDir)

  if (files.length === 0) {
    console.log()
    console.log(pc.yellow('No iteration logs found.') + ' Run `nightshift run` first.')
    console.log()
    return
  }

  if (opts.list) {
    listLogs(logsDir, files)
    return
  }

  if (iteration !== undefined) {
    const target = `iteration_${iteration}.log`
    if (!files.includes(target)) {
      console.error(pc.red(`Log for iteration ${iteration} not found.`))
      console.log(pc.dim(`Available: ${files.map(f => iterationNumber(f)).join(', ')}`))
      process.exit(1)
    }
    showLog(logsDir, target)
    return
  }

  // Default: show all logs
  for (const file of files) {
    showLog(logsDir, file)
  }
}
