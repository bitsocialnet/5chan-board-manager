import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Logs from './logs.js'

const T1 = '2026-04-24T10:00:00.000Z'
const T2 = '2026-04-24T10:05:00.000Z'
const T3 = '2026-04-24T10:10:00.000Z'
const T4 = '2026-04-24T10:15:00.000Z'

const FIXTURE_CONTENT = [
  `[${T1}] [stdout] first stdout`,
  `[${T2}] [stderr] first stderr`,
  `[${T3}] [stdout] second stdout`,
  `[${T4}] [stderr] second stderr`,
  '',
].join('\n')

function makeLogDir(content = FIXTURE_CONTENT, fileName = '5chan_daemon_2026-04-24T10-00-00.000Z.log'): string {
  const dir = mkdtempSync(join(tmpdir(), 'logs-test-'))
  writeFileSync(join(dir, fileName), content)
  return dir
}

interface RunResult {
  stdout: string
  stderr: string
  error?: Error
}

async function runLogs(args: string[]): Promise<RunResult> {
  let stdout = ''
  let stderr = ''
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    return true
  }) as typeof process.stdout.write)
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    return true
  }) as typeof process.stderr.write)

  const cmd = new Logs(args, {} as never)
  Object.defineProperty(cmd, 'config', {
    value: { configDir: '/tmp', runHook: async () => ({ successes: [], failures: [] }) },
  })

  let error: Error | undefined
  try {
    await cmd.run()
  } catch (e) {
    error = e as Error
  } finally {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  }
  return { stdout, stderr, error }
}

const dirs: string[] = []

function tmpLogDir(content?: string, fileName?: string): string {
  const d = makeLogDir(content, fileName)
  dirs.push(d)
  return d
}

describe('logs command — one-shot', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  it('dumps all entries by default', async () => {
    const dir = tmpLogDir()
    const { stdout, error } = await runLogs(['--logPath', dir])
    expect(error).toBeUndefined()
    expect(stdout).toContain('first stdout')
    expect(stdout).toContain('first stderr')
    expect(stdout).toContain('second stdout')
    expect(stdout).toContain('second stderr')
  })

  it('filters to stdout with --stdout', async () => {
    const dir = tmpLogDir()
    const { stdout, error } = await runLogs(['--logPath', dir, '--stdout'])
    expect(error).toBeUndefined()
    expect(stdout).toContain('first stdout')
    expect(stdout).toContain('second stdout')
    expect(stdout).not.toContain('first stderr')
    expect(stdout).not.toContain('second stderr')
  })

  it('filters to stderr with --stderr', async () => {
    const dir = tmpLogDir()
    const { stdout, error } = await runLogs(['--logPath', dir, '--stderr'])
    expect(error).toBeUndefined()
    expect(stdout).toContain('first stderr')
    expect(stdout).toContain('second stderr')
    expect(stdout).not.toContain('first stdout')
    expect(stdout).not.toContain('second stdout')
  })

  it('tails to the last N entries with -n', async () => {
    const dir = tmpLogDir()
    const { stdout, error } = await runLogs(['--logPath', dir, '-n', '2'])
    expect(error).toBeUndefined()
    expect(stdout).not.toContain('first stdout')
    expect(stdout).not.toContain('first stderr')
    expect(stdout).toContain('second stdout')
    expect(stdout).toContain('second stderr')
  })

  it('filters by --since (ISO)', async () => {
    const dir = tmpLogDir()
    const { stdout, error } = await runLogs(['--logPath', dir, '--since', T3])
    expect(error).toBeUndefined()
    expect(stdout).not.toContain('first stdout')
    expect(stdout).not.toContain('first stderr')
    expect(stdout).toContain('second stdout')
    expect(stdout).toContain('second stderr')
  })

  it('filters by --until (ISO)', async () => {
    const dir = tmpLogDir()
    const { stdout, error } = await runLogs(['--logPath', dir, '--until', T2])
    expect(error).toBeUndefined()
    expect(stdout).toContain('first stdout')
    expect(stdout).toContain('first stderr')
    expect(stdout).not.toContain('second stdout')
    expect(stdout).not.toContain('second stderr')
  })

  it('combines --stdout with -n', async () => {
    const dir = tmpLogDir()
    const { stdout, error } = await runLogs(['--logPath', dir, '--stdout', '-n', '1'])
    expect(error).toBeUndefined()
    expect(stdout).not.toContain('first stdout')
    expect(stdout).toContain('second stdout')
    expect(stdout).not.toContain('first stderr')
    expect(stdout).not.toContain('second stderr')
  })

  it('picks the latest file when multiple exist', async () => {
    const dir = tmpLogDir('[2026-04-24T09:00:00.000Z] [stdout] older\n', '5chan_daemon_2026-04-24T09-00-00.000Z.log')
    // Write a newer file to the same dir
    writeFileSync(join(dir, '5chan_daemon_2026-04-24T11-00-00.000Z.log'), '[2026-04-24T11:00:00.000Z] [stdout] newer\n')
    const { stdout, error } = await runLogs(['--logPath', dir])
    expect(error).toBeUndefined()
    expect(stdout).toContain('newer')
    expect(stdout).not.toContain('older')
  })

  it('errors when directory does not exist', async () => {
    const { error } = await runLogs(['--logPath', '/nonexistent/path/xyz'])
    expect(error).toBeDefined()
    expect(error!.message).toMatch(/Log directory does not exist/)
  })

  it('errors when directory exists but has no matching log files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'logs-empty-'))
    dirs.push(dir)
    const { error } = await runLogs(['--logPath', dir])
    expect(error).toBeDefined()
    expect(error!.message).toMatch(/No log files found/)
  })

  it('errors on invalid --since value', async () => {
    const dir = tmpLogDir()
    const { error } = await runLogs(['--logPath', dir, '--since', 'not-a-date'])
    expect(error).toBeDefined()
    expect(error!.message).toMatch(/Invalid timestamp/)
  })

  it('errors on invalid --tail value', async () => {
    const dir = tmpLogDir()
    const { error } = await runLogs(['--logPath', dir, '-n', 'abc'])
    expect(error).toBeDefined()
    expect(error!.message).toMatch(/Invalid --tail value/)
  })

  it('preserves continuation lines in output', async () => {
    const content = [
      `[${T1}] [stderr] Error: boom`,
      '    at stack frame 1',
      '    at stack frame 2',
      `[${T2}] [stdout] ok`,
      '',
    ].join('\n')
    const dir = tmpLogDir(content)
    const { stdout, error } = await runLogs(['--logPath', dir])
    expect(error).toBeUndefined()
    expect(stdout).toContain('Error: boom')
    expect(stdout).toContain('    at stack frame 1')
    expect(stdout).toContain('    at stack frame 2')
    expect(stdout).toContain('ok')
  })

  it('only dumps matching entries for --stderr + continuation lines', async () => {
    const content = [
      `[${T1}] [stderr] Error: boom`,
      '    at stack frame 1',
      `[${T2}] [stdout] ok`,
      '',
    ].join('\n')
    const dir = tmpLogDir(content)
    const { stdout, error } = await runLogs(['--logPath', dir, '--stderr'])
    expect(error).toBeUndefined()
    expect(stdout).toContain('Error: boom')
    expect(stdout).toContain('    at stack frame 1')
    expect(stdout).not.toContain('ok')
  })
})
