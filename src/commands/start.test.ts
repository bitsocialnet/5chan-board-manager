import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveBoardConfig, saveGlobalConfig } from '../config-manager.js'

vi.mock('../board-managers.js', () => ({
  startBoardManagers: vi.fn(),
}))

import { startBoardManagers } from '../board-managers.js'
import type { BoardManagers } from '../board-managers.js'
import Start from './start.js'

const mockStartManager = vi.mocked(startBoardManagers)

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'start-test-'))
}

function writeBoardConfig(dir: string, board: { address: string;[key: string]: unknown }): void {
  saveBoardConfig(dir, board as Parameters<typeof saveBoardConfig>[1])
}

function makeMockManager(overrides?: Partial<BoardManagers>): BoardManagers {
  return {
    boardManagers: new Map(),
    errors: new Map(),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  }
}

async function runCommand(args: string[], configDir: string): Promise<{ stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''

  const cmd = new Start(args, {} as never)
  Object.defineProperty(cmd, 'config', {
    value: {
      configDir,
      runHook: async () => ({ successes: [], failures: [] }),
    },
  })
  cmd.log = (...logArgs: string[]) => {
    stdout += logArgs.join(' ') + '\n'
  }
  cmd.warn = ((...warnArgs: [string | Error]) => {
    stderr += String(warnArgs[0]) + '\n'
  }) as typeof cmd.warn

  await cmd.run()

  return { stdout, stderr }
}

describe('start command', () => {
  const dirs: string[] = []
  let signalListeners: Set<unknown>

  function tmpDir(): string {
    const d = makeTmpDir()
    dirs.push(d)
    return d
  }

  beforeEach(() => {
    mockStartManager.mockReset()
    signalListeners = new Set([...process.listeners('SIGINT'), ...process.listeners('SIGTERM')])
  })

  afterEach(() => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signalListeners.has(listener)) process.removeListener(signal, listener)
      }
    }
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('exits once with failure on a lost RPC session so Docker rebuilds subscriptions', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    const manager = makeMockManager()
    mockStartManager.mockResolvedValue(manager)
    await runCommand([], tmpDir())
    const runtime = mockStartManager.mock.calls[0][2]
    expect(runtime?.onRpcDisconnect).toBeTypeOf('function')
    runtime!.onRpcDisconnect!()
    runtime!.onRpcDisconnect!()
    process.emit('SIGTERM', 'SIGTERM')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(exit).toHaveBeenCalledOnce()
    expect(manager.stop).toHaveBeenCalledOnce()
  })

  it('forces failure exit after ten seconds if disconnected SDK teardown hangs', async () => {
    vi.useFakeTimers()
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    const manager = makeMockManager({ stop: vi.fn(() => new Promise<void>(() => {})) })
    mockStartManager.mockResolvedValue(manager)
    await runCommand([], tmpDir())
    mockStartManager.mock.calls[0][2]!.onRpcDisconnect!()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('bounds shutdown when RPC fails while boards are still starting', async () => {
    vi.useFakeTimers()
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    mockStartManager.mockImplementation(async (_dir, _config, runtime) => {
      queueMicrotask(() => runtime!.onRpcDisconnect!())
      return new Promise(() => {})
    })
    void runCommand([], tmpDir())
    await vi.advanceTimersByTimeAsync(10_001)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits successfully after an intentional stop', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    const manager = makeMockManager()
    mockStartManager.mockResolvedValue(manager)
    await runCommand([], tmpDir())
    process.emit('SIGTERM', 'SIGTERM')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(manager.stop).toHaveBeenCalledOnce()
  })

  it('logs waiting message and starts with zero boards when none configured', async () => {
    const manager = makeMockManager()
    mockStartManager.mockResolvedValue(manager)

    const dir = tmpDir()
    const { stdout } = await runCommand([], dir)

    expect(stdout).toContain('No boards configured')
    expect(stdout).toContain('Waiting for boards to be added')
    expect(mockStartManager).toHaveBeenCalledOnce()
    const [, config] = mockStartManager.mock.calls[0]
    expect(config.boards).toEqual([])
    expect(stdout).toContain('Started 0 board manager(s)')
  })

  it('starts board managers with correct config', async () => {
    const manager = makeMockManager({
      boardManagers: new Map([['a.bso', { stop: vi.fn() }]]),
    })
    mockStartManager.mockResolvedValue(manager)

    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'a.bso' })

    await runCommand([], dir)

    expect(mockStartManager).toHaveBeenCalledOnce()
    const [configDir, config] = mockStartManager.mock.calls[0]
    expect(configDir).toBe(dir)
    expect(config.boards[0].address).toBe('a.bso')
  })

  it('uses custom config dir when --config-dir flag provided', async () => {
    const manager = makeMockManager({
      boardManagers: new Map([['a.bso', { stop: vi.fn() }]]),
    })
    mockStartManager.mockResolvedValue(manager)

    const dir = tmpDir()
    const customDir = join(dir, 'custom')
    writeBoardConfig(customDir, { address: 'a.bso' })

    await runCommand(['--config-dir', customDir], dir)

    const [configDir] = mockStartManager.mock.calls[0]
    expect(configDir).toBe(customDir)
  })

  it('prints startup summary', async () => {
    const manager = makeMockManager({
      boardManagers: new Map([['a.bso', { stop: vi.fn() }]]),
    })
    mockStartManager.mockResolvedValue(manager)

    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'a.bso' })

    const { stdout } = await runCommand([], dir)
    expect(stdout).toContain('Starting board managers for 1 board(s)')
    expect(stdout).toContain('Started 1 board manager(s)')
  })

  it('propagates error when startBoardManagers throws', async () => {
    mockStartManager.mockRejectedValue(
      new AggregateError(
        [new Error('connection refused')],
        'All 1 board(s) failed to start',
      ),
    )

    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'a.bso' })

    await expect(runCommand([], dir)).rejects.toThrow(
      'All 1 board(s) failed to start',
    )
  })

  it('reports failed boards in startup summary', async () => {
    const manager = makeMockManager({
      boardManagers: new Map([['a.bso', { stop: vi.fn() }]]),
      errors: new Map([['b.bso', new Error('connection refused')]]),
    })
    mockStartManager.mockResolvedValue(manager)

    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'a.bso' })
    writeBoardConfig(dir, { address: 'b.bso' })

    const { stdout, stderr } = await runCommand([], dir)
    expect(stdout).toContain('1 failed')
    expect(stderr).toContain('FAILED: b.bso')
    expect(stderr).toContain('connection refused')
  })
})
