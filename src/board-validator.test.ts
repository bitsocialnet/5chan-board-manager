import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validateBoardAddress } from './board-validator.js'
import type { PKCInstance } from './types.js'

vi.mock('./pkc-rpc.js', () => ({
  connectToPkcRpc: vi.fn(),
}))

import { connectToPkcRpc } from './pkc-rpc.js'

const mockConnect = vi.mocked(connectToPkcRpc)

function mockPKCInstance(communities: string[], destroy: () => Promise<void>): PKCInstance {
  return { communities, destroy } as unknown as PKCInstance
}

describe('validateBoardAddress', () => {
  const mockDestroy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

  beforeEach(() => {
    mockConnect.mockReset()
    mockDestroy.mockClear()
  })

  it('succeeds when address is in communities list', async () => {
    mockConnect.mockResolvedValue(mockPKCInstance(['board.bso', 'other.bso'], mockDestroy))

    await expect(validateBoardAddress('board.bso', 'ws://localhost:9138')).resolves.toBeUndefined()
    expect(mockDestroy).toHaveBeenCalledOnce()
  })

  it('throws when address is not in communities list', async () => {
    mockConnect.mockResolvedValue(mockPKCInstance(['other.bso', 'another.bso'], mockDestroy))

    await expect(validateBoardAddress('missing.bso', 'ws://localhost:9138'))
      .rejects.toThrow('Community "missing.bso" not found')
    expect(mockDestroy).toHaveBeenCalledOnce()
  })

  it('lists available communities in error message', async () => {
    mockConnect.mockResolvedValue(mockPKCInstance(['a.bso', 'b.bso'], mockDestroy))

    await expect(validateBoardAddress('missing.bso', 'ws://localhost:9138'))
      .rejects.toThrow('Available communities: a.bso, b.bso')
  })

  it('shows "no communities available" when list is empty', async () => {
    mockConnect.mockResolvedValue(mockPKCInstance([], mockDestroy))

    await expect(validateBoardAddress('missing.bso', 'ws://localhost:9138'))
      .rejects.toThrow('No communities available on this node')
  })

  it('includes RPC URL in error message', async () => {
    mockConnect.mockResolvedValue(mockPKCInstance([], mockDestroy))

    await expect(validateBoardAddress('x.bso', 'ws://custom:9138'))
      .rejects.toThrow('ws://custom:9138')
  })

  it('passes correct RPC URL to connectToPkcRpc', async () => {
    mockConnect.mockResolvedValue(mockPKCInstance(['board.bso'], mockDestroy))

    await validateBoardAddress('board.bso', 'ws://test:9138')

    expect(mockConnect).toHaveBeenCalledWith('ws://test:9138')
  })

  it('destroys PKC instance even when validation fails', async () => {
    mockConnect.mockResolvedValue(mockPKCInstance([], mockDestroy))

    try {
      await validateBoardAddress('x.bso', 'ws://localhost:9138')
    } catch {
      // expected
    }
    expect(mockDestroy).toHaveBeenCalledOnce()
  })
})
