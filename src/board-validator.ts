import { connectToPkcRpc } from './pkc-rpc.js'

/**
 * Validate that a board address exists in the PKC node's communities list.
 * Throws a descriptive error if the address is not found.
 */
export async function validateBoardAddress(address: string, rpcUrl: string): Promise<void> {
  const pkc = await connectToPkcRpc(rpcUrl)
  try {
    if (!pkc.communities.includes(address)) {
      const available = pkc.communities.length > 0
        ? `Available communities: ${pkc.communities.join(', ')}`
        : 'No communities available on this node'
      throw new Error(
        `Community "${address}" not found on RPC node at ${rpcUrl}. ${available}`,
      )
    }
  } finally {
    await pkc.destroy()
  }
}
