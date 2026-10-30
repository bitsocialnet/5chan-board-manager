import type { PKCInstance } from './types.js'

/**
 * Whether the RPC node hosts the community. Since pkc-js 0.0.129 (pkcprotocol/pkc-js#460)
 * `pkc.communities` lists `{ name?, publicKey, address, started }` entries instead of address
 * strings. A board is configured by its domain name or its public key, so match either.
 */
export function isHostedCommunity(pkc: PKCInstance, address: string): boolean {
  return pkc.communities.some((entry) => entry.address === address || entry.publicKey === address)
}

/** Addresses of the communities the RPC node hosts, for error messages. */
export function hostedCommunityAddresses(pkc: PKCInstance): string[] {
  return pkc.communities.map((entry) => entry.address)
}
