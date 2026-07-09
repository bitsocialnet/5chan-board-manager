import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startBoardManagers } from './board-managers.js'
import { saveBoardConfig } from './config-manager.js'
import type { BoardManagerOptions, BoardManagerResult, MultiBoardConfig } from './types.js'

vi.mock('./board-manager.js', () => ({
  startBoardManager: vi.fn(),
}))

import { startBoardManager } from './board-manager.js'

const mockStartBoardManager = vi.mocked(startBoardManager)

// Watcher-driven tests poll for up to 30s (see waitForReload); when every core
// is saturated (full-suite parallel workers plus other builds on the machine)
// the watcher's poll timers can starve for several seconds, so both the poll
// window and the test timeout need generous headroom. Healthy runs still
// finish in a few hundred ms — the poll returns as soon as the state matches.
vi.setConfig({ testTimeout: 60_000 })

function makeStopFn(): BoardManagerResult['stop'] {
  return vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
}

// Poll until the watcher pipeline (chokidar awaitWriteFinish + debounce +
// handleConfigChange) has produced the expected state, instead of sleeping a
// fixed amount — fs-event latency varies wildly with machine load.
function waitForReload(assertions: () => void): Promise<void> {
  return vi.waitFor(assertions, { timeout: 30_000, interval: 50 })
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'board-managers-test-'))
}

function writeGlobalConfig(dir: string, config: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'global.json'), JSON.stringify(config))
}

function writeBoardConfig(dir: string, board: { address: string;[key: string]: unknown }): void {
  const boardDir = join(dir, 'boards', board.address)
  mkdirSync(boardDir, { recursive: true })
  writeFileSync(join(boardDir, 'config.json'), JSON.stringify(board))
}

describe('startBoardManagers', () => {
  const dirs: string[] = []

  function tmpDir(): string {
    const d = makeTmpDir()
    dirs.push(d)
    return d
  }

  beforeEach(() => {
    mockStartBoardManager.mockReset()
  })

  afterEach(async () => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('starts board managers for all boards in initial config', async () => {
    const stopA = makeStopFn()
    const stopB = makeStopFn()
    mockStartBoardManager
      .mockResolvedValueOnce({ stop: stopA })
      .mockResolvedValueOnce({ stop: stopB })

    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'a.bso' })
    writeBoardConfig(dir, { address: 'b.bso' })
    const config: MultiBoardConfig = {
      boards: [{ address: 'a.bso' }, { address: 'b.bso' }],
    }

    const manager = await startBoardManagers(dir, config)

    expect(manager.boardManagers.size).toBe(2)
    expect(manager.boardManagers.has('a.bso')).toBe(true)
    expect(manager.boardManagers.has('b.bso')).toBe(true)
    expect(manager.errors.size).toBe(0)

    await manager.stop()
  })

  it('records failed boards in errors map and continues', async () => {
    mockStartBoardManager
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ stop: makeStopFn() })

    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'a.bso' })
    writeBoardConfig(dir, { address: 'b.bso' })
    const config: MultiBoardConfig = {
      boards: [{ address: 'a.bso' }, { address: 'b.bso' }],
    }

    const manager = await startBoardManagers(dir, config)

    expect(manager.boardManagers.size).toBe(1)
    expect(manager.boardManagers.has('b.bso')).toBe(true)
    expect(manager.errors.size).toBe(1)
    expect(manager.errors.get('a.bso')?.message).toBe('connection refused')

    await manager.stop()
  })

  it('throws AggregateError when all boards fail to start', async () => {
    mockStartBoardManager
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('timeout'))

    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'a.bso' })
    writeBoardConfig(dir, { address: 'b.bso' })
    const config: MultiBoardConfig = {
      boards: [{ address: 'a.bso' }, { address: 'b.bso' }],
    }

    await expect(startBoardManagers(dir, config)).rejects.toThrow(
      'All 2 board(s) failed to start',
    )
  })

  it('starts with empty config', async () => {
    const dir = tmpDir()
    mkdirSync(join(dir, 'boards'), { recursive: true })
    const config: MultiBoardConfig = { boards: [] }

    const manager = await startBoardManagers(dir, config)

    expect(manager.boardManagers.size).toBe(0)
    expect(manager.errors.size).toBe(0)

    await manager.stop()
  })

  it('starts with empty config when boards directory does not exist', async () => {
    const dir = tmpDir()
    // Do NOT create boards/ directory — startBoardManagers should create it
    const config: MultiBoardConfig = { boards: [] }

    const manager = await startBoardManagers(dir, config)

    expect(manager.boardManagers.size).toBe(0)
    expect(manager.errors.size).toBe(0)
    expect(existsSync(join(dir, 'boards'))).toBe(true)

    await manager.stop()
  })

  it('passes correct options to startBoardManager', async () => {
    mockStartBoardManager.mockResolvedValue({ stop: makeStopFn() })

    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', bumpLimit: 500 })
    const config: MultiBoardConfig = {
      rpcUrl: 'ws://test:9138',
      defaults: { perPage: 20 },
      boards: [{ address: 'x.bso', bumpLimit: 500 }],
    }

    const manager = await startBoardManagers(dir, config)

    const opts = mockStartBoardManager.mock.calls[0][0] as BoardManagerOptions
    expect(opts.communityAddress).toBe('x.bso')
    expect(opts.pkcRpcUrl).toBe('ws://test:9138')
    expect(opts.boardDir).toBe(join(dir, 'boards', 'x.bso'))
    expect(opts.perPage).toBe(20)
    expect(opts.bumpLimit).toBe(500)

    await manager.stop()
  })

  describe('hot-reload', () => {
    it('picks up boards added after starting with zero boards', async () => {
      const stopNew = makeStopFn()
      mockStartBoardManager.mockResolvedValueOnce({ stop: stopNew })

      const dir = tmpDir()
      const config: MultiBoardConfig = { boards: [] }

      const manager = await startBoardManagers(dir, config)
      expect(manager.boardManagers.size).toBe(0)

      // Add a board config file (simulating "5chan board add")
      writeBoardConfig(dir, { address: 'new.bso' })

      await waitForReload(() => {
        expect(manager.boardManagers.size).toBe(1)
        expect(manager.boardManagers.has('new.bso')).toBe(true)
      })

      await manager.stop()
    })

    it('starts new board managers when boards are added to config', async () => {
      const stopA = makeStopFn()
      const stopNew = makeStopFn()
      mockStartBoardManager
        .mockResolvedValueOnce({ stop: stopA })
        .mockResolvedValueOnce({ stop: stopNew })

      const dir = tmpDir()
      writeBoardConfig(dir, { address: 'a.bso' })
      const config: MultiBoardConfig = {
        boards: [{ address: 'a.bso' }],
      }

      const manager = await startBoardManagers(dir, config)
      expect(manager.boardManagers.size).toBe(1)

      // Add new board config file
      writeBoardConfig(dir, { address: 'new.bso' })

      await waitForReload(() => {
        expect(manager.boardManagers.size).toBe(2)
        expect(manager.boardManagers.has('new.bso')).toBe(true)
      })

      await manager.stop()
    })

    it('restarts board managers when board config changes', async () => {
      const stopA = makeStopFn()
      const stopNew = makeStopFn()
      mockStartBoardManager
        .mockResolvedValueOnce({ stop: stopA })
        .mockResolvedValueOnce({ stop: stopNew })

      const dir = tmpDir()
      writeBoardConfig(dir, { address: 'a.bso', bumpLimit: 300 })
      const config: MultiBoardConfig = {
        boards: [{ address: 'a.bso', bumpLimit: 300 }],
      }

      const manager = await startBoardManagers(dir, config)
      expect(manager.boardManagers.size).toBe(1)

      // Update board config file with changed bumpLimit
      writeBoardConfig(dir, { address: 'a.bso', bumpLimit: 500 })

      await waitForReload(() => {
        expect(stopA).toHaveBeenCalledOnce()
        expect(mockStartBoardManager).toHaveBeenCalledTimes(2)
        expect(manager.boardManagers.size).toBe(1)
        expect(manager.boardManagers.has('a.bso')).toBe(true)
      })

      await manager.stop()
    })

    it('restarts all boards when userAgent changes in global config', async () => {
      const stopA = makeStopFn()
      const stopNew = makeStopFn()
      mockStartBoardManager
        .mockResolvedValueOnce({ stop: stopA })
        .mockResolvedValueOnce({ stop: stopNew })

      const dir = tmpDir()
      writeGlobalConfig(dir, { userAgent: 'old-agent:1.0' })
      writeBoardConfig(dir, { address: 'a.bso' })
      const config: MultiBoardConfig = {
        userAgent: 'old-agent:1.0',
        boards: [{ address: 'a.bso' }],
      }

      const manager = await startBoardManagers(dir, config)
      expect(manager.boardManagers.size).toBe(1)

      // Update global config with changed userAgent
      writeGlobalConfig(dir, { userAgent: 'new-agent:2.0' })

      await waitForReload(() => {
        expect(stopA).toHaveBeenCalledOnce()
        expect(mockStartBoardManager).toHaveBeenCalledTimes(2)
      })

      await manager.stop()
    })

    it('records error when restart of changed board fails', async () => {
      const stopA = makeStopFn()
      mockStartBoardManager
        .mockResolvedValueOnce({ stop: stopA })
        .mockRejectedValueOnce(new Error('restart failed'))

      const dir = tmpDir()
      writeBoardConfig(dir, { address: 'a.bso', bumpLimit: 300 })
      const config: MultiBoardConfig = {
        boards: [{ address: 'a.bso', bumpLimit: 300 }],
      }

      const manager = await startBoardManagers(dir, config)
      expect(manager.boardManagers.size).toBe(1)

      // Update board config file with changed bumpLimit
      writeBoardConfig(dir, { address: 'a.bso', bumpLimit: 500 })

      await waitForReload(() => {
        expect(stopA).toHaveBeenCalledOnce()
        expect(manager.boardManagers.has('a.bso')).toBe(false)
        expect(manager.errors.size).toBe(1)
        expect(manager.errors.get('a.bso')?.message).toBe('restart failed')
      })

      await manager.stop()
    })

    it('picks up boards added via saveBoardConfig (real atomic-write path)', async () => {
      // Regression test for the Linux recursive fs.watch race: when `5chan board add`
      // creates `boards/<addr>/` and writes `config.json` back-to-back, the inotify
      // event for the inner file can be lost because the recursive watch on the
      // newly-created subdirectory is registered asynchronously. This test exercises
      // the exact atomic-write path (mkdir → write .tmp → rename) that the CLI uses,
      // so it fails under native fs.watch on affected systems and passes under
      // chokidar (which manages per-subdir watches explicitly).
      const stopNew = makeStopFn()
      mockStartBoardManager.mockResolvedValueOnce({ stop: stopNew })

      const dir = tmpDir()
      const manager = await startBoardManagers(dir, { boards: [] })
      expect(manager.boardManagers.size).toBe(0)

      saveBoardConfig(dir, { address: 'new.bso' })

      await waitForReload(() => {
        expect(manager.boardManagers.size).toBe(1)
        expect(manager.boardManagers.has('new.bso')).toBe(true)
      })

      await manager.stop()
    })

    it('stops board managers when boards are removed from config', async () => {
      const stopA = makeStopFn()
      const stopB = makeStopFn()
      mockStartBoardManager
        .mockResolvedValueOnce({ stop: stopA })
        .mockResolvedValueOnce({ stop: stopB })

      const dir = tmpDir()
      writeBoardConfig(dir, { address: 'a.bso' })
      writeBoardConfig(dir, { address: 'b.bso' })
      const config: MultiBoardConfig = {
        boards: [{ address: 'a.bso' }, { address: 'b.bso' }],
      }

      const manager = await startBoardManagers(dir, config)
      expect(manager.boardManagers.size).toBe(2)

      // Remove board config directory
      rmSync(join(dir, 'boards', 'b.bso'), { recursive: true })

      await waitForReload(() => {
        expect(manager.boardManagers.size).toBe(1)
        expect(manager.boardManagers.has('a.bso')).toBe(true)
        expect(manager.boardManagers.has('b.bso')).toBe(false)
        expect(stopB).toHaveBeenCalledOnce()
      })

      await manager.stop()
    })

    it('does not drop a config change that arrives during an active reload', async () => {
      // Regression test: handleConfigChange used to bail out when a reload was
      // already running, silently dropping the change until the next unrelated
      // fs event. The change must instead be queued and applied right after.
      const stopA = makeStopFn()
      const stopB = makeStopFn()
      let releaseFirstStart!: () => void
      const firstStartGate = new Promise<void>((resolve) => {
        releaseFirstStart = resolve
      })
      mockStartBoardManager
        .mockImplementationOnce(async () => {
          await firstStartGate
          return { stop: stopA }
        })
        .mockResolvedValueOnce({ stop: stopB })

      const dir = tmpDir()
      const manager = await startBoardManagers(dir, { boards: [] })

      // First change starts a reload that blocks inside startBoardManager
      writeBoardConfig(dir, { address: 'a.bso' })
      await waitForReload(() => {
        expect(mockStartBoardManager).toHaveBeenCalledTimes(1)
      })

      // Second change arrives while that reload is still in progress; wait long
      // enough for its watcher event + debounce to fire into the reload window
      writeBoardConfig(dir, { address: 'b.bso' })
      await new Promise((r) => setTimeout(r, 1500))
      expect(mockStartBoardManager).toHaveBeenCalledTimes(1)

      releaseFirstStart()

      await waitForReload(() => {
        expect(manager.boardManagers.size).toBe(2)
        expect(manager.boardManagers.has('a.bso')).toBe(true)
        expect(manager.boardManagers.has('b.bso')).toBe(true)
      })

      await manager.stop()
    })
  })

  describe('stop()', () => {
    it('calls stop on all board managers', async () => {
      const stopA = makeStopFn()
      const stopB = makeStopFn()
      mockStartBoardManager
        .mockResolvedValueOnce({ stop: stopA })
        .mockResolvedValueOnce({ stop: stopB })

      const dir = tmpDir()
      writeBoardConfig(dir, { address: 'a.bso' })
      writeBoardConfig(dir, { address: 'b.bso' })
      const config: MultiBoardConfig = {
        boards: [{ address: 'a.bso' }, { address: 'b.bso' }],
      }

      const manager = await startBoardManagers(dir, config)
      await manager.stop()

      expect(stopA).toHaveBeenCalledOnce()
      expect(stopB).toHaveBeenCalledOnce()
    })

    it('is resilient to individual stop failures', async () => {
      const stopA = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('cleanup fail'))
      const stopB = makeStopFn()
      mockStartBoardManager
        .mockResolvedValueOnce({ stop: stopA })
        .mockResolvedValueOnce({ stop: stopB })

      const dir = tmpDir()
      writeBoardConfig(dir, { address: 'a.bso' })
      writeBoardConfig(dir, { address: 'b.bso' })
      const config: MultiBoardConfig = {
        boards: [{ address: 'a.bso' }, { address: 'b.bso' }],
      }

      const manager = await startBoardManagers(dir, config)
      // Should not throw even though stopA fails
      await manager.stop()

      expect(stopA).toHaveBeenCalledOnce()
      expect(stopB).toHaveBeenCalledOnce()
    })
  })

  describe('address change', () => {
    it('updates map keys when onAddressChange is called', async () => {
      const stopA = makeStopFn()
      mockStartBoardManager.mockResolvedValueOnce({ stop: stopA })

      const dir = tmpDir()
      writeBoardConfig(dir, { address: 'old.bso' })
      const config: MultiBoardConfig = {
        boards: [{ address: 'old.bso' }],
      }

      const manager = await startBoardManagers(dir, config)
      expect(manager.boardManagers.has('old.bso')).toBe(true)

      // Extract the onAddressChange callback from the startBoardManager call
      const opts = mockStartBoardManager.mock.calls[0][0] as BoardManagerOptions
      expect(opts.onAddressChange).toBeDefined()

      // Simulate address change callback
      opts.onAddressChange!('old.bso', 'new.bso')

      // Map key should be updated
      expect(manager.boardManagers.has('old.bso')).toBe(false)
      expect(manager.boardManagers.has('new.bso')).toBe(true)

      await manager.stop()
    })

    it('renames config file on disk when onAddressChange is called', async () => {
      const stopA = makeStopFn()
      mockStartBoardManager.mockResolvedValueOnce({ stop: stopA })

      const dir = tmpDir()
      writeBoardConfig(dir, { address: 'hash123', bumpLimit: 500 })
      const config: MultiBoardConfig = {
        boards: [{ address: 'hash123', bumpLimit: 500 }],
      }

      const manager = await startBoardManagers(dir, config)

      // Extract and call onAddressChange
      const opts = mockStartBoardManager.mock.calls[0][0] as BoardManagerOptions
      opts.onAddressChange!('hash123', 'named.bso')

      // Old config should be gone, new one should exist with updated address
      expect(existsSync(join(dir, 'boards', 'hash123'))).toBe(false)
      expect(existsSync(join(dir, 'boards', 'named.bso', 'config.json'))).toBe(true)

      const newConfig = JSON.parse(readFileSync(join(dir, 'boards', 'named.bso', 'config.json'), 'utf-8'))
      expect(newConfig.address).toBe('named.bso')
      expect(newConfig.bumpLimit).toBe(500)

      await manager.stop()
    })

    it('hot-reload does not cause spurious restart after rename', async () => {
      const stopA = makeStopFn()
      mockStartBoardManager.mockResolvedValueOnce({ stop: stopA })

      const dir = tmpDir()
      writeBoardConfig(dir, { address: 'hash456' })
      const config: MultiBoardConfig = {
        boards: [{ address: 'hash456' }],
      }

      const manager = await startBoardManagers(dir, config)

      // Extract and call onAddressChange — this updates currentConfig in-place
      // AND renames the config file, which triggers the fs watcher
      const opts = mockStartBoardManager.mock.calls[0][0] as BoardManagerOptions
      opts.onAddressChange!('hash456', 'renamed.bso')

      // Wait for the watcher debounce to fire (200ms) + processing time
      await new Promise((r) => setTimeout(r, 500))

      // startBoardManager should only have been called once (initial start)
      // — NOT a second time from the hot-reload detecting a "change"
      expect(mockStartBoardManager).toHaveBeenCalledTimes(1)

      // The manager should still be running under the new key
      expect(manager.boardManagers.has('renamed.bso')).toBe(true)
      expect(stopA).not.toHaveBeenCalled()

      await manager.stop()
    })
  })
})
