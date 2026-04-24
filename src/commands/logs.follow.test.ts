import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const T1 = '2026-04-24T10:00:00.000Z'
const T2 = '2026-04-24T10:05:00.000Z'
const T3 = '2026-04-24T10:10:00.000Z'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const binRun = join(projectRoot, 'bin', 'run.js')
const distLogs = join(projectRoot, 'dist', 'commands', 'logs.js')

const dirs: string[] = []
const procs: ChildProcessWithoutNullStreams[] = []

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'logs-follow-'))
  dirs.push(d)
  return d
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function waitFor(getText: () => string, needle: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (getText().includes(needle)) return
    await sleep(100)
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for "${needle}". Current text: ${JSON.stringify(getText())}`)
}

describe('logs --follow (subprocess)', () => {
  beforeAll(() => {
    if (!existsSync(distLogs)) {
      const result = spawnSync('npm', ['run', 'build'], { cwd: projectRoot, encoding: 'utf-8' })
      if (result.status !== 0) {
        throw new Error(`Failed to build dist: ${result.stderr || result.stdout}`)
      }
    }
  }, 120_000)

  afterEach(() => {
    for (const p of procs) {
      if (!p.killed) p.kill('SIGKILL')
    }
    procs.length = 0
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  it('streams new lines appended to the log file', async () => {
    const dir = tmpDir()
    const logFile = join(dir, '5chan_daemon_2026-04-24T10-00-00.000Z.log')
    writeFileSync(logFile, `[${T1}] [stdout] initial line\n`)

    const child = spawn('node', [binRun, 'logs', '--logPath', dir, '-f'], { cwd: projectRoot })
    procs.push(child)
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })

    await waitFor(() => stdout, 'initial line')

    appendFileSync(logFile, `[${T2}] [stdout] appended A\n`)
    await waitFor(() => stdout, 'appended A')
    appendFileSync(logFile, `[${T3}] [stderr] appended B\n`)
    await waitFor(() => stdout, 'appended B')

    child.kill('SIGTERM')
  }, 15_000)

  it('filters streamed output with --stdout', async () => {
    const dir = tmpDir()
    const logFile = join(dir, '5chan_daemon_2026-04-24T10-00-00.000Z.log')
    writeFileSync(logFile, `[${T1}] [stdout] initial stdout\n`)

    const child = spawn('node', [binRun, 'logs', '--logPath', dir, '-f', '--stdout'], { cwd: projectRoot })
    procs.push(child)
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })

    await waitFor(() => stdout, 'initial stdout')
    appendFileSync(logFile, `[${T2}] [stderr] should-be-filtered\n`)
    appendFileSync(logFile, `[${T3}] [stdout] should-appear\n`)
    await waitFor(() => stdout, 'should-appear')

    expect(stdout).not.toContain('should-be-filtered')

    child.kill('SIGTERM')
  }, 15_000)

  it('switches to a new log file when it appears', async () => {
    const dir = tmpDir()
    const firstFile = join(dir, '5chan_daemon_2026-04-24T10-00-00.000Z.log')
    writeFileSync(firstFile, `[${T1}] [stdout] old-file-line\n`)

    const child = spawn('node', [binRun, 'logs', '--logPath', dir, '-f'], { cwd: projectRoot })
    procs.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })

    await waitFor(() => stdout, 'old-file-line')
    // Create a newer file; rotation check runs every 3s
    const secondFile = join(dir, '5chan_daemon_2026-04-24T11-00-00.000Z.log')
    writeFileSync(secondFile, `[${T2}] [stdout] new-file-line\n`)

    await waitFor(() => stdout, 'new-file-line', 8000)
    expect(stderr).toContain('switched to new log file')

    child.kill('SIGTERM')
  }, 20_000)
})
