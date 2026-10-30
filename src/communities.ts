import type { PKCInstance } from './types.js'

/**
 * Whether the RPC node hosts the community. Since pkc-js 0.0.129 (pkcprotocol/pkc-js#460)
 * `pkc.communities` lists `{ name?, publicKey, address, started }` entries instead of address
 * strings. Match on `address` only, which is the name when the community has one and its
 * public key otherwise, the same value the string list used to carry: a named community is
 * not matched by its key, so the same community cannot be added as two boards.
 */
export function isHostedCommunity(pkc: PKCInstance, address: string): boolean {
  return pkc.communities.some((entry) => entry.address === address)
}

/** Addresses of the communities the RPC node hosts, for error messages. */
export function hostedCommunityAddresses(pkc: PKCInstance): string[] {
  return pkc.communities.map((entry) => entry.address)
}
