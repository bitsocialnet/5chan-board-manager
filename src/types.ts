import type PKCFn from '@pkcprotocol/pkc-js'

/** The PKC instance type returned by `await PKC()` */
export type PKCInstance = Awaited<ReturnType<typeof PKCFn>>

/** Community returned by `pkc.getCommunity()` */
export type Community = Awaited<ReturnType<PKCInstance['getCommunity']>>

/** Signer returned by `pkc.createSigner()` */
export type Signer = Awaited<ReturnType<PKCInstance['createSigner']>>

/** Comment returned by `pkc.getComment()` */
export type Comment = Awaited<ReturnType<PKCInstance['getComment']>>

/** A single page returned by `community.posts.getPage()` */
export type Page = Awaited<ReturnType<Community['posts']['getPage']>>

/** A comment/thread within a page */
export type ThreadComment = Page['comments'][number]

export interface ModerationReasons {
  archiveCapacity?: string
  archiveBumpLimit?: string
  purgeArchived?: string
  purgeDeleted?: string
}

export interface BoardManagerOptions {
  communityAddress: string
  pkcRpcUrl: string
  boardDir: string
  userAgent?: string
  perPage?: number
  pages?: number
  bumpLimit?: number
  archivePurgeSeconds?: number
  moderationReasons?: ModerationReasons
  onAddressChange?: (oldAddress: string, newAddress: string) => void
  /**
   * How often to sweep for archived threads whose retention has expired, in ms.
   * Archiving is driven by community `update` events, but purging is time-based:
   * a quiet board emits no updates, so without this sweep an expired thread would
   * sit in the archive until unrelated activity happened to wake the manager.
   * Defaults from `PURGE_SWEEP_INTERVAL_SECONDS` env or 60_000.
   */
  purgeSweepIntervalMs?: number
  /** Path to a shared heartbeat file the board ticks `mtime` on. Disabled if undefined. */
  heartbeatPath?: string
  /** Heartbeat tick interval in ms. Defaults from `HEARTBEAT_INTERVAL_SECONDS` env or 300_000. */
  heartbeatIntervalMs?: number
  /** If `now - lastUpdateAt` exceeds this, a stale-update warning is logged each tick. Defaults from `HEARTBEAT_STALE_UPDATE_SECONDS` env or 1_800_000. */
  heartbeatStaleUpdateMs?: number
}

export interface BoardManagerResult {
  stop: () => Promise<void>
}

export interface SignerState {
  privateKey: string
}

export interface ArchivedThread {
  archivedTimestamp: number
}

export interface FileLock {
  lockPath: string
  release: () => Promise<void>
}

export interface BoardManagerState {
  signers: Record<string, SignerState>
  archivedThreads: Record<string, ArchivedThread>
}

/** Per-board config entry in the multi-board config file */
export interface BoardConfig {
  address: string
  perPage?: number
  pages?: number
  bumpLimit?: number
  archivePurgeSeconds?: number
  moderationReasons?: ModerationReasons
}

/** Default settings applied to all boards unless overridden per-board */
export interface BoardDefaults {
  perPage?: number
  pages?: number
  bumpLimit?: number
  archivePurgeSeconds?: number
  moderationReasons?: ModerationReasons
}

/** Global config stored in global.json */
export interface GlobalConfig {
  rpcUrl?: string
  userAgent?: string
  defaults?: BoardDefaults
}

/** Top-level multi-board JSON config */
export interface MultiBoardConfig {
  rpcUrl?: string
  userAgent?: string
  defaults?: BoardDefaults
  boards: BoardConfig[]
}

/** Result of starting multi-board managers */
export interface MultiBoardResult {
  boardManagers: Map<string, BoardManagerResult>
  errors: Map<string, Error>
  stop: () => Promise<void>
}
