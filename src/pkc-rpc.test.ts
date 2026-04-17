import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { connectToPkcRpc } from './pkc-rpc.js'
import type { PKCInstance } from './types.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

vi.mock('@pkcprotocol/pkc-js', () => ({
  default: vi.fn(),
}))

import PKC from '@pkcprotocol/pkc-js'

const mockPKC = vi.mocked(PKC)

type Listener = (...args: unknown[]) => void

function createMockInstance() {
  const listeners: Record<string, Listener[]> = {}
  const instance = {
    communities: [] as string[],
    on: vi.fn((event: string, cb: Listener) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    }),
    once: vi.fn((event: string, cb: Listener) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as PKCInstance

  return { instance, listeners }
}

describe('connectToPkcRpc', () => {
  beforeEach(() => {
    mockPKC.mockReset()
  })

  it('waits for communitieschange before returning', async () => {
    const { instance, listeners } = createMockInstance()
    mockPKC.mockResolvedValue(instance)

    let resolved = false
    const promise = connectToPkcRpc('ws://localhost:9138').then((p) => {
      resolved = true
      return p
    })

    // Give microtasks a chance to run
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)

    // Fire the event
    for (const cb of listeners['communitieschange'] ?? []) cb()

    const result = await promise
    expect(resolved).toBe(true)
    expect(result).toBe(instance)
  })

  it('attaches an error handler', async () => {
    const { instance, listeners } = createMockInstance()
    // Resolve communitieschange immediately
    ;(instance.once as ReturnType<typeof vi.fn>).mockImplementation((_event: string, cb: Listener) => {
      cb()
    })
    mockPKC.mockResolvedValue(instance)

    await connectToPkcRpc('ws://localhost:9138')

    const errorHandlers = (listeners['error'] ?? [])
    expect(errorHandlers).toHaveLength(1)
  })

  it('passes correct RPC options to PKC constructor with default userAgent', async () => {
    const { instance } = createMockInstance()
    ;(instance.once as ReturnType<typeof vi.fn>).mockImplementation((_event: string, cb: Listener) => {
      cb()
    })
    mockPKC.mockResolvedValue(instance)

    await connectToPkcRpc('ws://custom:9138')

    expect(mockPKC).toHaveBeenCalledWith({
      pkcRpcClientsOptions: ['ws://custom:9138'],
      userAgent: `5chan-board-manager:${version}`,
    })
  })

  it('passes custom userAgent when provided', async () => {
    const { instance } = createMockInstance()
    ;(instance.once as ReturnType<typeof vi.fn>).mockImplementation((_event: string, cb: Listener) => {
      cb()
    })
    mockPKC.mockResolvedValue(instance)

    await connectToPkcRpc('ws://custom:9138', 'my-custom-agent:1.0')

    expect(mockPKC).toHaveBeenCalledWith({
      pkcRpcClientsOptions: ['ws://custom:9138'],
      userAgent: 'my-custom-agent:1.0',
    })
  })
})
