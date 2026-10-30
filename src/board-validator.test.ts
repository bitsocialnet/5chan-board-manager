import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validateBoardAddress } from './board-validator.js'
import type { PKCInstance } from './types.js'

vi.mock('./pkc-rpc.js', () => ({
  connectToPkcRpc: vi.fn(),
}))

import { connectToPkcRpc } from './pkc-rpc.js'

const mockConnect = vi.mocked(connectToPkcRpc)

type CommunitiesEntry = PKCInstance['communities'][number]

/** A hosted community as pkc-js >= 0.0.129 lists it (pkcprotocol/pkc-js#460). */
function entry(address: string, publicKey = `${address}-key`): CommunitiesEntry {
  return address.includes('.')
    ? { name: address, publicKey, address, started: true }
    : { publicKey, address: publicKey, started: true }
}

function mockPKCInstance(communities: string[], destroy: () => Promise<void>): PKCInstance {
  return { communities: communities.map((address) => entry(address)), destroy } as unknown as PKCInstance
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

  it('finds a board configured by its public key (pkc-js#460 entries)', async () => {
    const keyOnly = entry('12D3KooWkey', '12D3KooWkey')
    const named = entry('board.bso', '12D3KooWnamed')
    mockConnect.mockResolvedValue({ communities: [keyOnly, named], destroy: mockDestroy } as unknown as PKCInstance)

    await expect(validateBoardAddress('12D3KooWkey', 'ws://localhost:9138')).resolves.toBeUndefined()
    await expect(validateBoardAddress('12D3KooWnamed', 'ws://localhost:9138')).resolves.toBeUndefined()
    await expect(validateBoardAddress('board.bso', 'ws://localhost:9138')).resolves.toBeUndefined()
  })

  it('does not match an entry on a field other than its address or key', async () => {
    mockConnect.mockResolvedValue({
      communities: [{ name: 'board.bso', publicKey: 'key', address: 'board.bso', started: false }],
      destroy: mockDestroy,
    } as unknown as PKCInstance)

    await expect(validateBoardAddress('true', 'ws://localhost:9138')).rejects.toThrow('Available communities: board.bso')
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
