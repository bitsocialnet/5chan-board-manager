import PKC from '@pkcprotocol/pkc-js'
import { createRequire } from 'node:module'
import type { PKCInstance } from './types.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

/** A reconnected transport does not restore the SDK's RPC subscriptions. */
export function watchRpcDisconnect(pkc: PKCInstance, onDisconnect: () => void): () => void {
  let notified = false
  const cleanups = Object.values(pkc.clients.pkcRpcClients).map((client) => {
    let connected = client.state === 'connected'
    const onState = (state: typeof client.state): void => {
      if (state === 'connected') connected = true
      if (connected && (state === 'stopped' || state === 'failed') && !notified) {
        notified = true
        onDisconnect()
      }
    }
    client.on('statechange', onState)
    return () => client.removeListener('statechange', onState)
  })
  return () => cleanups.forEach((cleanup) => cleanup())
}

/**
 * Connect to a PKC RPC node and wait for the communities list to be populated.
 *
 * After `await PKC(...)` the RPC connection is open but `pkc.communities`
 * is still empty. The RPC pushes the list asynchronously, firing the
 * `communitieschange` event once it arrives. This helper waits for that event
 * before returning — matching the pattern used by bitsocial-cli.
 */
export async function connectToPkcRpc(rpcUrl: string, userAgent?: string): Promise<PKCInstance> {
  let pkc: PKCInstance | undefined
  let finished = false
  let cleanup = (): void => {}
  let timer: NodeJS.Timeout | undefined
  const destroy = (instance: PKCInstance): void => {
    // SDK teardown can itself await an unavailable RPC. Do not let it defeat
    // the startup deadline; the daemon also bounds process shutdown.
    void instance.destroy().catch(() => {})
  }
  const connect = async (): Promise<PKCInstance> => {
    const instance = await PKC({
      pkcRpcClientsOptions: [rpcUrl],
      userAgent: userAgent ?? `5chan-board-manager:${version}`,
    })
    instance.on('error', (err: Error) => console.error('PKC RPC error:', err.message))
    if (finished) {
      destroy(instance)
      throw new Error('RPC startup already timed out')
    }
    pkc = instance
    await new Promise<void>((resolve, reject) => {
      const ready = (): void => resolve()
      const failed = (error: Error): void => reject(error)
      const unwatch = watchRpcDisconnect(instance, () => reject(new Error('RPC disconnected during startup')))
      cleanup = () => {
        instance.removeListener('communitieschange', ready)
        instance.removeListener('error', failed)
        unwatch()
      }
      instance.once('communitieschange', ready)
      instance.once('error', failed)
      if (instance.communities.length > 0) resolve()
    })
    return instance
  }
  try {
    return await Promise.race([
      connect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('RPC startup timed out after 30 seconds')), 30_000)
      }),
    ])
  } catch (error) {
    if (pkc) destroy(pkc)
    throw error
  } finally {
    finished = true
    clearTimeout(timer)
    cleanup()
  }
}
