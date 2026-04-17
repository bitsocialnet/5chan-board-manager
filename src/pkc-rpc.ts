import PKC from '@pkcprotocol/pkc-js'
import { createRequire } from 'node:module'
import type { PKCInstance } from './types.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

/**
 * Connect to a PKC RPC node and wait for the communities list to be populated.
 *
 * After `await PKC(...)` the RPC connection is open but `pkc.communities`
 * is still empty. The RPC pushes the list asynchronously, firing the
 * `communitieschange` event once it arrives. This helper waits for that event
 * before returning — matching the pattern used by bitsocial-cli.
 */
export async function connectToPkcRpc(rpcUrl: string, userAgent?: string): Promise<PKCInstance> {
  const pkc = await PKC({
    pkcRpcClientsOptions: [rpcUrl],
    userAgent: userAgent ?? `5chan-board-manager:${version}`,
  })
  pkc.on('error', (err: Error) => {
    console.error('PKC RPC error:', err.message)
  })
  await new Promise<string[]>((resolve) => pkc.once('communitieschange', resolve))
  return pkc
}
