import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { startMultiBoardManager } from './multi-runner.js'
import type { BoardManagerOptions, BoardManagerResult, MultiBoardConfig } from './types.js'

vi.mock('./board-manager.js', () => ({
  startBoardManager: vi.fn(),
}))

import { startBoardManager } from './board-manager.js'

const mockStartBoardManager = vi.mocked(startBoardManager)

function makeStopFn(): BoardManagerResult['stop'] {
  return vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
}

function makeConfig(overrides?: Partial<MultiBoardConfig>): MultiBoardConfig {
  return {
    boards: [{ address: 'a.bso' }, { address: 'b.bso' }],
    ...overrides,
  }
}

describe('startMultiBoardManager', () => {
  beforeEach(() => {
    mockStartBoardManager.mockReset()
  })

  it('starts all boards and returns them in the boardManagers map', async () => {
    const stopA = makeStopFn()
    const stopB = makeStopFn()
    mockStartBoardManager
      .mockResolvedValueOnce({ stop: stopA })
      .mockResolvedValueOnce({ stop: stopB })

    const result = await startMultiBoardManager(makeConfig(), '/test/config')

    expect(result.boardManagers.size).toBe(2)
    expect(result.boardManagers.has('a.bso')).toBe(true)
    expect(result.boardManagers.has('b.bso')).toBe(true)
    expect(result.errors.size).toBe(0)
  })

  it('passes correct options to startBoardManager', async () => {
    mockStartBoardManager.mockResolvedValue({ stop: makeStopFn() })

    const config = makeConfig({
      rpcUrl: 'ws://test:9138',
      defaults: { perPage: 20 },
      boards: [{ address: 'x.bso', bumpLimit: 500 }],
    })

    await startMultiBoardManager(config, '/test/config')

    const opts = mockStartBoardManager.mock.calls[0][0] as BoardManagerOptions
    expect(opts.communityAddress).toBe('x.bso')
    expect(opts.pkcRpcUrl).toBe('ws://test:9138')
    expect(opts.boardDir).toBe(join('/test/config', 'boards', 'x.bso'))
    expect(opts.perPage).toBe(20)
    expect(opts.bumpLimit).toBe(500)
  })

  it('records failed boards in errors map and continues', async () => {
    mockStartBoardManager
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ stop: makeStopFn() })

    const result = await startMultiBoardManager(makeConfig(), '/test/config')

    expect(result.boardManagers.size).toBe(1)
    expect(result.boardManagers.has('b.bso')).toBe(true)
    expect(result.errors.size).toBe(1)
    expect(result.errors.get('a.bso')?.message).toBe('connection refused')
  })

  it('throws AggregateError when ALL boards fail', async () => {
    mockStartBoardManager.mockRejectedValue(new Error('fail'))

    await expect(startMultiBoardManager(makeConfig(), '/test/config')).rejects.toThrow(AggregateError)
  })

  it('AggregateError contains all individual errors', async () => {
    mockStartBoardManager
      .mockRejectedValueOnce(new Error('fail-a'))
      .mockRejectedValueOnce(new Error('fail-b'))

    try {
      await startMultiBoardManager(makeConfig(), '/test/config')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError)
      const agg = err as AggregateError
      expect(agg.errors).toHaveLength(2)
      expect(agg.message).toContain('2 board(s) failed')
    }
  })

  it('starts boards sequentially (not in parallel)', async () => {
    const order: string[] = []

    mockStartBoardManager.mockImplementation(async (opts: BoardManagerOptions) => {
      order.push(opts.communityAddress)
      return { stop: makeStopFn() }
    })

    await startMultiBoardManager(makeConfig({
      boards: [{ address: 'first.bso' }, { address: 'second.bso' }, { address: 'third.bso' }],
    }), '/test/config')

    expect(order).toEqual(['first.bso', 'second.bso', 'third.bso'])
  })

  describe('stop()', () => {
    it('calls stop on all board managers', async () => {
      const stopA = makeStopFn()
      const stopB = makeStopFn()
      mockStartBoardManager
        .mockResolvedValueOnce({ stop: stopA })
        .mockResolvedValueOnce({ stop: stopB })

      const result = await startMultiBoardManager(makeConfig(), '/test/config')
      await result.stop()

      expect(stopA).toHaveBeenCalledOnce()
      expect(stopB).toHaveBeenCalledOnce()
    })

    it('is resilient to individual stop failures', async () => {
      const stopA = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('cleanup fail'))
      const stopB = makeStopFn()
      mockStartBoardManager
        .mockResolvedValueOnce({ stop: stopA })
        .mockResolvedValueOnce({ stop: stopB })

      const result = await startMultiBoardManager(makeConfig(), '/test/config')
      // Should not throw even though stopA fails
      await result.stop()

      expect(stopA).toHaveBeenCalledOnce()
      expect(stopB).toHaveBeenCalledOnce()
    })
  })

  it('wraps non-Error rejections in Error objects', async () => {
    mockStartBoardManager
      .mockRejectedValueOnce('string error')
      .mockResolvedValueOnce({ stop: makeStopFn() })

    const result = await startMultiBoardManager(makeConfig(), '/test/config')

    expect(result.errors.get('a.bso')?.message).toBe('string error')
  })
})
