import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { connectToPkcRpc, watchRpcDisconnect } from './pkc-rpc.js'
import type { PKCInstance } from './types.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

vi.mock('@pkcprotocol/pkc-js', () => ({ default: vi.fn() }))
import PKC from '@pkcprotocol/pkc-js'
const mockPKC = vi.mocked(PKC)

function createMockInstance(state = 'connected') {
  const rpc = Object.assign(new EventEmitter(), { state })
  const instance = Object.assign(new EventEmitter(), {
    communities: [] as string[],
    clients: { pkcRpcClients: { 'ws://localhost:9138': rpc } },
    destroy: vi.fn().mockResolvedValue(undefined),
  })
  return { instance, pkc: instance as unknown as PKCInstance, rpc }
}

describe('connectToPkcRpc', () => {
  beforeEach(() => mockPKC.mockReset())
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('waits for communitieschange, including an empty list, and removes startup listeners', async () => {
    const { instance, pkc, rpc } = createMockInstance()
    mockPKC.mockResolvedValue(pkc)
    let resolved = false
    const promise = connectToPkcRpc('ws://localhost:9138').then((value) => { resolved = true; return value })
    await Promise.resolve()
    expect(resolved).toBe(false)
    instance.emit('communitieschange', [])
    expect(await promise).toBe(pkc)
    expect(instance.listenerCount('communitieschange')).toBe(0)
    expect(instance.listenerCount('error')).toBe(1)
    expect(rpc.listenerCount('statechange')).toBe(0)
  })

  it.each([undefined, 'custom-agent:1.0'])('passes the configured userAgent (%s)', async (userAgent) => {
    const { instance, pkc } = createMockInstance()
    instance.communities.push('board.bso')
    mockPKC.mockResolvedValue(pkc)
    expect(await connectToPkcRpc('ws://localhost:9138', userAgent)).toBe(pkc)
    expect(mockPKC).toHaveBeenCalledWith({
      pkcRpcClientsOptions: ['ws://localhost:9138'],
      userAgent: userAgent ?? `5chan-board-manager:${version}`,
    })
  })

  it('rejects startup when the RPC never supplies its communities list', async () => {
    vi.useFakeTimers()
    const { instance, pkc, rpc } = createMockInstance()
    mockPKC.mockResolvedValue(pkc)
    const result = connectToPkcRpc('ws://localhost:9138').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await result).toMatchObject({ message: 'RPC startup timed out after 30 seconds' })
    expect(instance.destroy).toHaveBeenCalledOnce()
    expect(instance.listenerCount('communitieschange')).toBe(0)
    expect(rpc.listenerCount('statechange')).toBe(0)
  })

  it('destroys a PKC instance that arrives after the startup deadline', async () => {
    vi.useFakeTimers()
    const { instance, pkc } = createMockInstance()
    let finish!: (value: PKCInstance) => void
    mockPKC.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const result = connectToPkcRpc('ws://localhost:9138').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await result).toBeInstanceOf(Error)
    finish(pkc)
    await vi.advanceTimersByTimeAsync(0)
    expect(instance.destroy).toHaveBeenCalledOnce()
    expect(instance.listenerCount('communitieschange')).toBe(0)
  })

  it('rejects connection errors even if SDK cleanup hangs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { instance, pkc } = createMockInstance('connecting')
    instance.destroy.mockImplementation(() => new Promise(() => {}))
    mockPKC.mockResolvedValue(pkc)
    const result = connectToPkcRpc('ws://localhost:9138').catch((error: unknown) => error)
    await Promise.resolve()
    const error = new Error('connection refused')
    instance.emit('error', error)
    expect(await result).toBe(error)
    expect(instance.destroy).toHaveBeenCalledOnce()
  })

  it('rejects a disconnect before the first communities update', async () => {
    const { instance, pkc, rpc } = createMockInstance('connecting')
    mockPKC.mockResolvedValue(pkc)
    const result = connectToPkcRpc('ws://localhost:9138').catch((error: unknown) => error)
    await Promise.resolve()
    rpc.emit('statechange', 'connected')
    rpc.emit('statechange', 'stopped')
    expect(await result).toMatchObject({ message: 'RPC disconnected during startup' })
    expect(instance.destroy).toHaveBeenCalledOnce()
  })
})

describe('watchRpcDisconnect', () => {
  it('invalidates the session once even if the transport immediately reconnects', () => {
    const { pkc, rpc } = createMockInstance()
    const lost = vi.fn()
    const unwatch = watchRpcDisconnect(pkc, lost)
    rpc.emit('statechange', 'stopped')
    rpc.emit('statechange', 'connected')
    rpc.emit('statechange', 'failed')
    expect(lost).toHaveBeenCalledOnce()
    unwatch()
    expect(rpc.listenerCount('statechange')).toBe(0)
  })

  it('does not mistake initial connection or intentional teardown for a lost session', () => {
    const { pkc, rpc } = createMockInstance('stopped')
    const lost = vi.fn()
    const unwatch = watchRpcDisconnect(pkc, lost)
    rpc.emit('statechange', 'connecting')
    rpc.emit('statechange', 'stopped')
    expect(lost).not.toHaveBeenCalled()
    rpc.emit('statechange', 'connected')
    unwatch()
    rpc.emit('statechange', 'stopped')
    expect(lost).not.toHaveBeenCalled()
  })
})
