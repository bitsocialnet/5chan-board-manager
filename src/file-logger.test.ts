import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getNewLogfileByEvacuatingOldLogsIfNeeded } from './file-logger.js'

const dirs: string[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'file-logger-test-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

describe('getNewLogfileByEvacuatingOldLogsIfNeeded', () => {
  it('creates the directory if it does not exist', async () => {
    const base = tmp()
    const logPath = join(base, 'nested', 'log')
    const result = await getNewLogfileByEvacuatingOldLogsIfNeeded(logPath)
    expect(existsSync(logPath)).toBe(true)
    expect(result.logFilePath.startsWith(logPath)).toBe(true)
    expect(result.logFilePath).toMatch(/5chan_daemon_.*\.log$/)
    expect(result.deletedLogFile).toBeUndefined()
  })

  it('returns a new path matching 5chan_daemon_<ISO>.log', async () => {
    const logPath = tmp()
    const result = await getNewLogfileByEvacuatingOldLogsIfNeeded(logPath)
    expect(result.logFilePath).toMatch(/5chan_daemon_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.log$/)
  })

  it('does not delete anything when fewer than 5 files exist', async () => {
    const logPath = tmp()
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(logPath, `5chan_daemon_2026-04-24T10-0${i}-00.000Z.log`), 'x')
    }
    const result = await getNewLogfileByEvacuatingOldLogsIfNeeded(logPath)
    expect(result.deletedLogFile).toBeUndefined()
    expect(readdirSync(logPath).filter(n => n.startsWith('5chan_daemon_')).length).toBe(4)
  })

  it('deletes the oldest file when 5 files exist', async () => {
    const logPath = tmp()
    const names = [
      '5chan_daemon_2026-04-24T10-00-00.000Z.log',
      '5chan_daemon_2026-04-24T10-01-00.000Z.log',
      '5chan_daemon_2026-04-24T10-02-00.000Z.log',
      '5chan_daemon_2026-04-24T10-03-00.000Z.log',
      '5chan_daemon_2026-04-24T10-04-00.000Z.log',
    ]
    for (const n of names) writeFileSync(join(logPath, n), 'x')
    const result = await getNewLogfileByEvacuatingOldLogsIfNeeded(logPath)
    expect(result.deletedLogFile).toBe(names[0])
    expect(existsSync(join(logPath, names[0]!))).toBe(false)
    expect(existsSync(join(logPath, names[1]!))).toBe(true)
  })

  it('deletes only one file per call even when far over capacity', async () => {
    const logPath = tmp()
    const names: string[] = []
    for (let i = 0; i < 8; i++) {
      const n = `5chan_daemon_2026-04-24T10-0${i}-00.000Z.log`
      names.push(n)
      writeFileSync(join(logPath, n), 'x')
    }
    const result = await getNewLogfileByEvacuatingOldLogsIfNeeded(logPath)
    expect(result.deletedLogFile).toBe(names[0])
    const remaining = readdirSync(logPath).filter(n => n.startsWith('5chan_daemon_'))
    expect(remaining.length).toBe(7)
  })

  it('ignores non-5chan files in the directory', async () => {
    const logPath = tmp()
    writeFileSync(join(logPath, 'unrelated.txt'), 'x')
    writeFileSync(join(logPath, 'bitsocial_cli_daemon_2026-01-01T00-00-00.000Z.log'), 'x')
    const result = await getNewLogfileByEvacuatingOldLogsIfNeeded(logPath)
    expect(result.deletedLogFile).toBeUndefined()
    expect(existsSync(join(logPath, 'unrelated.txt'))).toBe(true)
  })
})

describe('pipeDebugLogsToLogFile (subprocess)', () => {
  // The pipe globally hijacks process.stdout/stderr.write, so we run it in a
  // child process to avoid polluting the test runner. The subprocess imports
  // from the compiled dist/, which `prepare` builds on install.

  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const fileLoggerJs = join(projectRoot, 'dist', 'file-logger.js')

  beforeAll(() => {
    if (!existsSync(fileLoggerJs)) {
      const result = spawnSync('npm', ['run', 'build'], { cwd: projectRoot, encoding: 'utf-8' })
      if (result.status !== 0) {
        throw new Error(`Failed to build dist: ${result.stderr || result.stdout}`)
      }
    }
  }, 120_000)

  function runChildScript(script: string, logPath: string, extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
    const prepared = script
      .replace('__FILE_LOGGER__', fileLoggerJs)
      .replace('__LOG_PATH__', logPath)
    const result = spawnSync('node', ['--input-type=module', '-e', prepared], {
      encoding: 'utf-8',
      env: { ...process.env, ...extraEnv },
      cwd: projectRoot,
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  it('writes stdout with [ISO] [stdout] prefix and tees to terminal', async () => {
    const logPath = tmp()
    const script = `
      import { pipeDebugLogsToLogFile } from 'file://__FILE_LOGGER__'
      const { logFile } = await pipeDebugLogsToLogFile('__LOG_PATH__')
      process.stdout.write('hello stdout\\n')
      await new Promise((r) => logFile.end(r))
    `
    const result = runChildScript(script, logPath)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('hello stdout')
    const files = readdirSync(logPath).filter(n => n.startsWith('5chan_daemon_'))
    expect(files.length).toBe(1)
    const content = readFileSync(join(logPath, files[0]!), 'utf-8')
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[stdout\] hello stdout/)
  })

  it('writes stderr to log file only (not to terminal)', async () => {
    const logPath = tmp()
    const script = `
      import { pipeDebugLogsToLogFile } from 'file://__FILE_LOGGER__'
      const { logFile } = await pipeDebugLogsToLogFile('__LOG_PATH__')
      process.stderr.write('hidden stderr\\n')
      await new Promise((r) => logFile.end(r))
    `
    const result = runChildScript(script, logPath)
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('hidden stderr')
    const files = readdirSync(logPath).filter(n => n.startsWith('5chan_daemon_'))
    const content = readFileSync(join(logPath, files[0]!), 'utf-8')
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[stderr\] hidden stderr/)
  })

  it('captures debug() output into the log file via the debug hijack', async () => {
    const logPath = tmp()
    const script = `
      import { pipeDebugLogsToLogFile } from 'file://__FILE_LOGGER__'
      import Logger from '@pkcprotocol/pkc-logger'
      const { logFile } = await pipeDebugLogsToLogFile('__LOG_PATH__')
      const log = Logger('5chan:test')
      log('marker-pkc-event-xyz')
      // Give the debug line a tick to flush
      await new Promise((r) => setTimeout(r, 50))
      await new Promise((r) => logFile.end(r))
    `
    const result = runChildScript(script, logPath, { DEBUG: '5chan:*' })
    expect(result.status).toBe(0)
    const files = readdirSync(logPath).filter(n => n.startsWith('5chan_daemon_'))
    const content = readFileSync(join(logPath, files[0]!), 'utf-8')
    expect(content).toContain('marker-pkc-event-xyz')
    expect(content).toMatch(/\[stderr\]/)
  })

  it('does not double-timestamp continuation lines', async () => {
    const logPath = tmp()
    const script = `
      import { pipeDebugLogsToLogFile } from 'file://__FILE_LOGGER__'
      const { logFile } = await pipeDebugLogsToLogFile('__LOG_PATH__')
      process.stdout.write('line1\\nline2\\nline3\\n')
      await new Promise((r) => logFile.end(r))
    `
    const result = runChildScript(script, logPath)
    expect(result.status).toBe(0)
    const files = readdirSync(logPath).filter(n => n.startsWith('5chan_daemon_'))
    const content = readFileSync(join(logPath, files[0]!), 'utf-8')
    const matches = content.match(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[stdout\]/g) ?? []
    expect(matches.length).toBe(1)
    expect(content).toContain('line1')
    expect(content).toContain('line2')
    expect(content).toContain('line3')
  })

  it('skips empty/whitespace-only writes', async () => {
    const logPath = tmp()
    const script = `
      import { pipeDebugLogsToLogFile } from 'file://__FILE_LOGGER__'
      const { logFile } = await pipeDebugLogsToLogFile('__LOG_PATH__')
      process.stdout.write('')
      process.stdout.write('   \\n')
      process.stdout.write('real content\\n')
      await new Promise((r) => logFile.end(r))
    `
    const result = runChildScript(script, logPath)
    expect(result.status).toBe(0)
    const files = readdirSync(logPath).filter(n => n.startsWith('5chan_daemon_'))
    const content = readFileSync(join(logPath, files[0]!), 'utf-8')
    const stdoutPrefixes = content.match(/\[stdout\]/g) ?? []
    expect(stdoutPrefixes.length).toBe(1)
    expect(content).toContain('real content')
  })
})
