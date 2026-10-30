import { connectToPkcRpc, watchRpcDisconnect } from './pkc-rpc.js'
import { isHostedCommunity } from './communities.js'
import Logger from '@pkcprotocol/pkc-logger'
import { closeSync, openSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { loadState, saveState, acquireLock } from './state.js'
import { DEFAULT_BUMP_LIMIT } from './defaults.js'
import { ACTIVE_PAGE_SORT_NAME, runsActivePageSort, withActivePageSortBumpLimit } from './page-sorts.js'
import type { BoardManagerOptions, BoardManagerResult, BoardManagerState, Comment, DeprecatedModerationReason, FileLock, ModerationReasons, Community, Signer, ThreadComment, Page, PKCInstance } from './types.js'

const log = Logger('bitsocial:5chan-board-manager:archiver')

/** Read from old configs but ignored: the bump limit is applied by the page sort now. */
const DEPRECATED_MODERATION_REASONS: readonly DeprecatedModerationReason[] = ['archiveBumpLimit', 'lockBumpLimit']

const DEFAULTS = {
  perPage: 15,
  pages: 10,
  bumpLimit: DEFAULT_BUMP_LIMIT,
  archivePurgeSeconds: 172800,
  purgeSweepIntervalMs: 60_000,
  moderationReasons: {
    archiveCapacity: '5chan board manager: thread archived — exceeded board capacity',
    purgeArchived: '5chan board manager: thread purged — archive retention expired',
    purgeDeleted: '5chan board manager: content purged — author-deleted',
    purgeCapacity: '5chan board manager: thread purged — exceeded board capacity',
  },
} as const

/**
 * Resolve the purge sweep cadence from an explicit option or the environment.
 *
 * `0` disables the sweep deliberately. Anything malformed falls back to the
 * default instead, because the dangerous failure mode here is a bad value
 * silently resolving to "disabled" and quietly restoring the bug this sweep
 * exists to fix.
 */
export function resolvePurgeSweepIntervalMs(
  optionValue: number | undefined,
  envValue: string | undefined,
): number {
  if (optionValue !== undefined) {
    if (!Number.isInteger(optionValue) || optionValue < 0) {
      log.error(`invalid purge sweep interval ${optionValue}, falling back to ${DEFAULTS.purgeSweepIntervalMs}ms`)
      return DEFAULTS.purgeSweepIntervalMs
    }
    return optionValue
  }

  if (envValue === undefined) {
    return DEFAULTS.purgeSweepIntervalMs
  }

  // Deliberately not parseInt: it stops at the first non-digit, so "0oops" would
  // resolve to 0 and silently disable the sweep. Require the whole value to be a
  // non-negative integer.
  const trimmed = envValue.trim()
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
  const intervalMs = seconds * 1000

  if (!Number.isFinite(intervalMs)) {
    log.error(
      `invalid PURGE_SWEEP_INTERVAL_SECONDS ${JSON.stringify(envValue)}, falling back to ${DEFAULTS.purgeSweepIntervalMs}ms`,
    )
    return DEFAULTS.purgeSweepIntervalMs
  }

  return intervalMs
}

export async function startBoardManager(options: BoardManagerOptions): Promise<BoardManagerResult> {
  const {
    pkcRpcUrl,
    userAgent,
    perPage = DEFAULTS.perPage,
    pages = DEFAULTS.pages,
    bumpLimit = DEFAULTS.bumpLimit,
    archivePurgeSeconds = DEFAULTS.archivePurgeSeconds,
  } = options

  let communityAddress = options.communityAddress

  const moderationReasons: Required<Omit<ModerationReasons, DeprecatedModerationReason>> = {
    archiveCapacity: options.moderationReasons?.archiveCapacity ?? DEFAULTS.moderationReasons.archiveCapacity,
    purgeArchived: options.moderationReasons?.purgeArchived ?? DEFAULTS.moderationReasons.purgeArchived,
    purgeDeleted: options.moderationReasons?.purgeDeleted ?? DEFAULTS.moderationReasons.purgeDeleted,
    purgeCapacity: options.moderationReasons?.purgeCapacity ?? DEFAULTS.moderationReasons.purgeCapacity,
  }
  for (const key of DEPRECATED_MODERATION_REASONS) {
    if (options.moderationReasons?.[key] !== undefined) {
      log.error(`moderationReasons.${key} is deprecated and ignored for ${options.communityAddress}: threads at the bump limit are no longer archived or locked, they sink in ${ACTIVE_PAGE_SORT_NAME}'s bump order`)
    }
  }

  const maxThreads = perPage * pages
  let statePath = join(options.boardDir, 'state.json')

  let fileLock: FileLock
  try {
    fileLock = await acquireLock(statePath)
  } catch (err) {
    throw new Error(`${(err as Error).message} for ${communityAddress}`)
  }

  let state: BoardManagerState = loadState(statePath)

  let stopped = false
  let boardHadNoArchive = false

  // Purges published on a board without an archive leave no state entry, so this keeps
  // the next update from republishing them before the board's pages reflect the change.
  const noArchivePurgedThreads = new Set<string>()
  // The bump limit lives in the board's page sort; checked against it once per start.
  let bumpLimitSyncPending = true
  // Set after this manager changed the sort's limit: capacity archiving waits for a record whose
  // `updatedAt` is past this. Until the board publishes a record generated after the edit, its
  // pages are still ordered by the old limit, so archiving by them would take the wrong threads.
  // `pageSorts` is no signal (pkc-js updates it on edit, before the pages are regenerated), and
  // `updatedAt` is not wall-clock time (it stays strictly increasing, so rapid publishes run it
  // ahead of the clock). Publish cycles do not overlap, so a record stamped past both the record
  // current at the edit and the edit's own second, plus one for a cycle already in flight, was
  // generated after the edit.
  let holdArchivingUntilUpdatedAt: number | undefined

  log(`starting board manager for ${communityAddress} (capacity=${maxThreads}, bumpLimit=${bumpLimit}, purgeAfter=${archivePurgeSeconds}s)`)

  let pkc: PKCInstance
  try {
    pkc = await connectToPkcRpc(pkcRpcUrl, userAgent)
  } catch (error) {
    await fileLock.release()
    options.onRpcDisconnect?.()
    throw error
  }
  const unwatchRpc = options.onRpcDisconnect
    ? watchRpcDisconnect(pkc, options.onRpcDisconnect)
    : () => {}

  async function failStartup(error: unknown): Promise<never> {
    unwatchRpc()
    void pkc.destroy().catch(() => {})
    await fileLock.release()
    throw error
  }

  async function ensureModRole(community: Community, signerAddress: string): Promise<void> {
    const roles = community.roles ?? {}
    if (roles[signerAddress]?.role === 'moderator' || roles[signerAddress]?.role === 'admin' || roles[signerAddress]?.role === 'owner') {
      return
    }
    if (!isHostedCommunity(pkc, communityAddress)) {
      throw new Error(
        `Signer ${signerAddress} does not have a moderator role on remote community ${communityAddress}. Ask the community owner to add this address as a moderator.`
      )
    }
    log(`adding moderator role for ${signerAddress} on ${communityAddress}`)
    await community.edit({
      roles: {
        ...roles,
        [signerAddress]: { role: 'moderator' },
      },
    })
  }

  async function getOrCreateSigner(): Promise<Signer> {
    if (state.signers[communityAddress]) {
      return pkc.createSigner({ privateKey: state.signers[communityAddress].privateKey, type: 'ed25519' })
    }
    log(`creating new signer for ${communityAddress}`)
    const signer = await pkc.createSigner()
    state.signers[communityAddress] = { privateKey: signer.privateKey }
    saveState(statePath, state)
    return signer
  }

  async function migrateAddress(newAddress: string): Promise<void> {
    const oldAddress = communityAddress
    const oldStatePath = statePath

    log(`address changed: ${oldAddress} → ${newAddress}, migrating state`)

    // Migrate signer key in memory
    if (state.signers[oldAddress]) {
      state.signers[newAddress] = state.signers[oldAddress]
      delete state.signers[oldAddress]
    }

    // Release old lock
    await fileLock.release()

    // Save state with migrated signers to current path (directory still has old name)
    saveState(statePath, state)

    // Notify caller — renames boards/{oldAddress}/ to boards/{newAddress}/
    options.onAddressChange?.(oldAddress, newAddress)

    // Compute new paths (directory has been renamed by onAddressChange)
    const boardsParentDir = dirname(options.boardDir)
    const newStatePath = join(boardsParentDir, newAddress, 'state.json')

    // Acquire lock on new path
    try {
      fileLock = await acquireLock(newStatePath)
    } catch (err) {
      // Rollback: rename directory back, restore signer key, re-lock
      log.error(`failed to acquire lock on new state path ${newStatePath}: ${err}`)
      try { options.onAddressChange?.(newAddress, oldAddress) } catch {}
      if (state.signers[newAddress]) {
        state.signers[oldAddress] = state.signers[newAddress]
        delete state.signers[newAddress]
      }
      fileLock = await acquireLock(oldStatePath)
      saveState(oldStatePath, state)
      throw err
    }

    // Update mutable references
    communityAddress = newAddress
    statePath = newStatePath

    log(`address migration complete: ${oldAddress} → ${newAddress}`)
  }

  async function archiveThread(commentCid: string, signer: Signer, reason: string): Promise<void> {
    log(`archiving thread ${commentCid} (${reason})`)
    const mod = await pkc.createCommentModeration({
      commentCid,
      commentModeration: { archived: true, reason },
      communityAddress,
      signer,
    })
    await mod.publish()
    state.archivedThreads[commentCid] = { archivedTimestamp: Math.floor(Date.now() / 1000) }
    saveState(statePath, state)
  }

  async function purgeThread(commentCid: string, signer: Signer, reason: string): Promise<void> {
    log(`purging thread ${commentCid}`)
    const mod = await pkc.createCommentModeration({
      commentCid,
      commentModeration: { purged: true, reason },
      communityAddress,
      signer,
    })
    await mod.publish()
    delete state.archivedThreads[commentCid]
    saveState(statePath, state)
  }

  async function purgeDeletedComment(commentCid: string, signer: Signer, reason: string): Promise<void> {
    log(`purging author-deleted comment ${commentCid}`)
    const mod = await pkc.createCommentModeration({
      commentCid,
      commentModeration: { purged: true, reason },
      communityAddress,
      signer,
    })
    await mod.publish()
    if (state.archivedThreads[commentCid]) {
      delete state.archivedThreads[commentCid]
    }
    saveState(statePath, state)
  }

  /**
   * Purge every archived thread whose retention window has elapsed.
   *
   * Kept separate from `handleUpdate` because this is the one piece of work that
   * is driven by the clock rather than by board activity — see the purge sweep
   * below.
   */
  async function purgeExpiredArchivedThreads(signer: Signer): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    for (const [cid, info] of Object.entries(state.archivedThreads)) {
      if (stopped) return
      if (now - info.archivedTimestamp > archivePurgeSeconds) {
        try {
          await purgeThread(cid, signer, moderationReasons.purgeArchived)
        } catch (err) {
          log.error(`failed to purge thread ${cid}: ${err}`)
        }
      }
    }
  }

  async function findDeletedReplies(thread: ThreadComment): Promise<string[]> {
    const deletedCids: string[] = []
    const visited = new Set<string>()
    const queue: Array<{ pageCid: string; parentCid: string }> = []
    const commentCache = new Map<string, Comment>()

    async function getCommentInstance(cid: string): Promise<Comment> {
      let instance = commentCache.get(cid)
      if (!instance) {
        instance = await pkc.getComment({ cid })
        commentCache.set(cid, instance)
      }
      return instance
    }

    function enqueue(pageCid: string | undefined, parentCid: string): void {
      if (!pageCid) return
      const key = `${parentCid}:${pageCid}`
      if (visited.has(key)) return
      visited.add(key)
      queue.push({ pageCid, parentCid })
    }

    function processComments(comments: ThreadComment[]): void {
      for (const comment of comments) {
        if (comment.deleted) {
          deletedCids.push(comment.cid)
        }
        if (comment.replies?.pages) {
          for (const page of Object.values(comment.replies.pages)) {
            if (!page) continue
            processComments(page.comments)
            enqueue(page.nextCid, comment.cid)
          }
        }
        if (comment.replies?.pageCids) {
          for (const pageCid of Object.values(comment.replies.pageCids)) {
            enqueue(pageCid, comment.cid)
          }
        }
      }
    }

    if (thread.replies?.pages) {
      for (const page of Object.values(thread.replies.pages)) {
        if (!page) continue
        processComments(page.comments)
        enqueue(page.nextCid, thread.cid)
      }
    }
    if (thread.replies?.pageCids) {
      for (const pageCid of Object.values(thread.replies.pageCids)) {
        enqueue(pageCid, thread.cid)
      }
    }

    while (queue.length > 0) {
      const { pageCid, parentCid } = queue.shift()!
      try {
        const parentComment = await getCommentInstance(parentCid)
        const page = await parentComment.replies.getPage({ cid: pageCid })
        processComments(page.comments)
        enqueue(page.nextCid, parentCid)
      } catch (err) {
        log.error(`failed to fetch reply page ${pageCid} for comment ${parentCid}: ${err}`)
      }
    }

    return deletedCids
  }

  /**
   * Make the board's `@pkcprotocol/active-page-sort` entry carry the configured bump limit.
   *
   * The sort applies the limit (past it a thread stays open but sinks), so the manager's
   * `bumpLimit` only takes effect through the sort's `bumpLimit` option. The manager config
   * is the source of truth: a limit edited on the sort by hand is put back on the next start.
   * Runs once per start, on the first update that carries the board's settings.
   */
  async function syncBumpLimit(community: Community): Promise<void> {
    if (!bumpLimitSyncPending) return
    const settings = community.settings
    if (settings === undefined) {
      // A board hosted by this RPC server loads its settings with its first updates; a remote
      // board never shares them, so only its published sort can be checked.
      if (isHostedCommunity(pkc, communityAddress)) return
      bumpLimitSyncPending = false
      const published = community.pageSorts?.posts?.active
      if (published?.name !== ACTIVE_PAGE_SORT_NAME) {
        log(`bumpLimit=${bumpLimit} has no effect: ${communityAddress} does not run ${ACTIVE_PAGE_SORT_NAME}`)
      } else if (published.publicOptions?.bumpLimit !== String(bumpLimit)) {
        log.error(`bump limit mismatch on remote board ${communityAddress}: configured ${bumpLimit}, ${ACTIVE_PAGE_SORT_NAME} has ${published.publicOptions?.bumpLimit ?? 'none'}; only the board owner can change it`)
      }
      return
    }
    bumpLimitSyncPending = false

    if (!runsActivePageSort(settings)) {
      log(`bumpLimit=${bumpLimit} has no effect: ${communityAddress} does not run ${ACTIVE_PAGE_SORT_NAME}`)
      return
    }
    const updatedSettings = withActivePageSortBumpLimit(settings, bumpLimit)
    if (!updatedSettings) return

    const current = settings.pages?.posts?.find((entry) => entry.name === ACTIVE_PAGE_SORT_NAME)?.options?.bumpLimit
    log(`setting ${ACTIVE_PAGE_SORT_NAME} bumpLimit on ${communityAddress}: ${current ?? 'none'} → ${bumpLimit}`)
    const updatedAtBeforeEdit = community.updatedAt ?? 0
    try {
      await community.edit({ settings: updatedSettings })
      holdArchivingUntilUpdatedAt = Math.max(updatedAtBeforeEdit, Math.floor(Date.now() / 1000)) + 1
    } catch (err) {
      log.error(`failed to set bump limit on ${communityAddress} (configured ${bumpLimit}, ${ACTIVE_PAGE_SORT_NAME} has ${current ?? 'none'}): ${err}`)
    }
  }

  async function handleUpdate(community: Community, signer: Signer): Promise<void> {
    if (stopped) return

    // Build the full thread list in bump order. The `active` sort is preferred however it is
    // published: embedded in the record (pages.active, with nextCid when it spans several
    // pages) or only by CID (pageCids.active, when its first page did not fit the record).
    // Its order is used as-is, because @pkcprotocol/active-page-sort ranks saged threads and
    // threads past the bump limit below their latest reply; re-sorting by lastReplyTimestamp
    // would bump them back up and capacity archiving would never reach them.
    const threads: ThreadComment[] = []
    const activeFirstPage = community.posts.pages.active
      ?? (community.posts.pageCids.active ? await community.posts.getPage({ cid: community.posts.pageCids.active }) : undefined)

    if (activeFirstPage) {
      let page: Page = activeFirstPage
      threads.push(...page.comments)
      while (page.nextCid) {
        page = await community.posts.getPage({ cid: page.nextCid })
        threads.push(...page.comments)
      }
    } else {
      // No `active` sort at all, e.g. a board without settings.pages whose posts fit the
      // single-chunk shortcut, so only the preloaded `hot` page is published. Rebuild bump
      // order from whichever page is preloaded.
      const preloadedPage = Object.values(community.posts.pages)[0]
      if (!preloadedPage) return // no posts at all — nothing to archive
      threads.push(...preloadedPage.comments)
      let nextCid = preloadedPage.nextCid
      while (nextCid) {
        const page: Page = await community.posts.getPage({ cid: nextCid })
        threads.push(...page.comments)
        nextCid = page.nextCid
      }
      threads.sort((a, b) => {
        const diff = (b.lastReplyTimestamp ?? 0) - (a.lastReplyTimestamp ?? 0)
        if (diff !== 0) return diff
        return (b.postNumber ?? 0) - (a.postNumber ?? 0)
      })
    }

    // A board with features.noArchive has no archive, like 4chan /b/: threads that fall
    // past capacity are purged right away instead of archived.
    const boardHasNoArchive = community.features?.noArchive === true
    if (boardHasNoArchive !== boardHadNoArchive) {
      log(boardHasNoArchive
        ? `${communityAddress} has no archive: purging threads past capacity`
        : `${communityAddress} has an archive again: archiving threads past capacity`)
      boardHadNoArchive = boardHasNoArchive
    }
    const threadCids = new Set(threads.map((thread) => thread.cid))
    for (const cid of noArchivePurgedThreads) {
      if (!threadCids.has(cid)) noArchivePurgedThreads.delete(cid)
    }

    // Filter out pinned threads
    const nonPinned = threads.filter((t: ThreadComment) => !t.pinned)

    if (holdArchivingUntilUpdatedAt !== undefined && (community.updatedAt ?? 0) > holdArchivingUntilUpdatedAt) {
      holdArchivingUntilUpdatedAt = undefined
    }
    const awaitingBumpLimitPages = holdArchivingUntilUpdatedAt !== undefined
    if (awaitingBumpLimitPages) {
      log(`waiting for ${communityAddress} to publish pages sorted with bumpLimit ${bumpLimit} before archiving by capacity`)
    }

    // Archive (or, without an archive, purge) threads beyond capacity
    for (const thread of awaitingBumpLimitPages ? [] : nonPinned.slice(maxThreads)) {
      if (boardHasNoArchive) {
        // Includes threads archived earlier, by this manager or by hand: clients list no archive
        // for such a board, so an archived thread would otherwise linger out of reach
        if (noArchivePurgedThreads.has(thread.cid)) continue
        try {
          await purgeThread(thread.cid, signer, moderationReasons.purgeCapacity)
          noArchivePurgedThreads.add(thread.cid)
        } catch (err) {
          log.error(`failed to purge thread ${thread.cid}: ${err}`)
        }
        continue
      }
      if (thread.archived) continue
      if (state.archivedThreads[thread.cid]) continue
      try {
        await archiveThread(thread.cid, signer, moderationReasons.archiveCapacity)
      } catch (err) {
        log.error(`failed to archive thread ${thread.cid}: ${err}`)
      }
    }

    // Purge archived threads past archive_purge_seconds
    await purgeExpiredArchivedThreads(signer)

    // Purge author-deleted threads and replies
    for (const thread of threads) {
      if (thread.deleted) {
        try {
          await purgeDeletedComment(thread.cid, signer, moderationReasons.purgeDeleted)
        } catch (err) {
          log.error(`failed to purge deleted thread ${thread.cid}: ${err}`)
        }
      }

      if (thread.replies) {
        try {
          const deletedReplyCids = await findDeletedReplies(thread)
          for (const cid of deletedReplyCids) {
            try {
              await purgeDeletedComment(cid, signer, moderationReasons.purgeDeleted)
            } catch (err) {
              log.error(`failed to purge deleted reply ${cid}: ${err}`)
            }
          }
        } catch (err) {
          log.error(`failed to scan replies for thread ${thread.cid}: ${err}`)
        }
      }
    }
  }

  // Startup: get signer, community, ensure mod role, subscribe to updates
  let community: Community
  try {
    const signer = await getOrCreateSigner()
    community = await pkc.getCommunity({ address: communityAddress })
    await ensureModRole(community, signer.address)
  } catch (error) {
    return failStartup(error)
  }

  let updateRunning = false
  let updatePendingRerun = false
  let lastUpdateAt = Date.now()

  /**
   * Serializes the update handler against the purge sweep. Both publish
   * moderations and mutate `state.archivedThreads`, so letting them overlap
   * could publish two purges for the same thread.
   */
  let workLock: Promise<unknown> = Promise.resolve()
  function withWorkLock<T>(task: () => Promise<T>): Promise<T> {
    const result = workLock.then(task, task)
    workLock = result.catch(() => undefined)
    return result
  }

  const updateHandler = () => {
    lastUpdateAt = Date.now()
    if (updateRunning) {
      updatePendingRerun = true
      return
    }
    updateRunning = true

    const run = async (): Promise<void> => {
      try {
        await withWorkLock(async () => {
          // Detect address change (e.g., hash → named address via bitsocial-cli)
          if (community.address && community.address !== communityAddress) {
            try {
              await migrateAddress(community.address)
            } catch (err) {
              log.error(`address migration failed: ${err}`)
            }
          }
          await syncBumpLimit(community)
          const signer = await getOrCreateSigner()
          await handleUpdate(community, signer)
        })
      } catch (err) {
        log.error(`update handler error: ${err}`)
      }
      if (updatePendingRerun && !stopped) {
        updatePendingRerun = false
        return run()
      }
      updateRunning = false
    }

    run()
  }

  community.on('update', updateHandler)
  try {
    await community.update()
  } catch (error) {
    stopped = true
    community.removeListener('update', updateHandler)
    await workLock
    return failStartup(error)
  }
  log(`board manager running for ${communityAddress}`)

  // Archiving reacts to board activity, but purging is purely time-based: once a
  // thread has been archived, nothing else needs to happen for its retention to
  // expire. A quiet board emits no `update` events, so without this sweep an
  // expired thread would linger in the archive until unrelated activity arrived.
  const purgeSweepIntervalMs = resolvePurgeSweepIntervalMs(
    options.purgeSweepIntervalMs,
    process.env['PURGE_SWEEP_INTERVAL_SECONDS'],
  )

  let purgeSweepInterval: NodeJS.Timeout | undefined
  // A sweep with many expired threads publishes moderations one at a time and can
  // outlast the interval. Without this guard every tick would queue another task
  // behind the running one, and update processing would wait behind the backlog.
  //
  // Deliberately untested: queued sweeps are serialized so they never overlap, and
  // after stop() they short-circuit before doing anything observable — every test
  // written for this passed with the guard removed, so none is kept.
  let purgeSweepPending = false

  if (purgeSweepIntervalMs > 0) {
    purgeSweepInterval = setInterval(() => {
      if (stopped || purgeSweepPending) return
      purgeSweepPending = true
      void withWorkLock(async () => {
        if (stopped) return
        const sweepSigner = await getOrCreateSigner()
        await purgeExpiredArchivedThreads(sweepSigner)
      })
        .catch((err) => {
          log.error(`purge sweep error: ${err}`)
        })
        .finally(() => {
          purgeSweepPending = false
        })
    }, purgeSweepIntervalMs)
  }

  const heartbeatPath = options.heartbeatPath
  const heartbeatIntervalMs = options.heartbeatIntervalMs
    ?? parseInt(process.env['HEARTBEAT_INTERVAL_SECONDS'] ?? '300', 10) * 1000
  const heartbeatStaleUpdateMs = options.heartbeatStaleUpdateMs
    ?? parseInt(process.env['HEARTBEAT_STALE_UPDATE_SECONDS'] ?? '1800', 10) * 1000

  let heartbeatInterval: NodeJS.Timeout | undefined

  if (heartbeatPath) {
    heartbeatInterval = setInterval(() => {
      if (stopped) return
      const now = Date.now()
      const sinceLastUpdate = now - lastUpdateAt
      const lastUpdateIso = new Date(lastUpdateAt).toISOString()
      log.trace(`[board ${communityAddress}] heartbeat — last update: ${lastUpdateIso} (${Math.round(sinceLastUpdate / 1000)}s ago)`)

      try {
        utimesSync(heartbeatPath, now / 1000, now / 1000)
      } catch {
        try {
          closeSync(openSync(heartbeatPath, 'w'))
        } catch (err) {
          log.error(`[board ${communityAddress}] failed to touch heartbeat file ${heartbeatPath}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (sinceLastUpdate > heartbeatStaleUpdateMs) {
        log.error(`[board ${communityAddress}] no update events for ${Math.round(sinceLastUpdate / 1000)}s`)
      }
    }, heartbeatIntervalMs)
  }

  return {
    async stop() {
      stopped = true
      if (purgeSweepInterval) clearInterval(purgeSweepInterval)
      if (heartbeatInterval) clearInterval(heartbeatInterval)
      community.removeListener('update', updateHandler)
      // Clearing the timers only stops future ticks. An update or sweep already
      // inside publish() would otherwise resume after the lock is released and
      // the PKC instance is destroyed, then write state holding no lock. Nothing
      // can queue new work at this point: the timer is cleared, the listener is
      // removed, and both paths bail on `stopped`.
      await workLock
      saveState(statePath, state)
      await fileLock.release()
      let teardownTimer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          (async () => {
            await community.stop?.()
            unwatchRpc()
            await pkc.destroy()
          })(),
          new Promise<never>((_, reject) => {
            // stop() also runs during config reload, outside the CLI's
            // shutdown deadline. A lost unsubscribe must not stall reload.
            teardownTimer = setTimeout(() => reject(new Error('RPC cleanup timed out after 10 seconds')), 10_000)
          }),
        ])
      } catch (error) {
        options.onRpcDisconnect?.()
        throw error
      } finally {
        clearTimeout(teardownTimer)
        unwatchRpc()
      }
      log(`board manager stopped for ${communityAddress}`)
    },
  }
}
