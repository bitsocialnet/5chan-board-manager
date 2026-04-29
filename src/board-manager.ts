import { connectToPkcRpc } from './pkc-rpc.js'
import Logger from '@pkcprotocol/pkc-logger'
import { closeSync, openSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { loadState, saveState, acquireLock } from './state.js'
import type { BoardManagerOptions, BoardManagerResult, BoardManagerState, Comment, FileLock, ModerationReasons, Community, Signer, ThreadComment, Page } from './types.js'

const log = Logger('bitsocial:5chan-board-manager:archiver')

const DEFAULTS = {
  perPage: 15,
  pages: 10,
  bumpLimit: 300,
  archivePurgeSeconds: 172800,
  moderationReasons: {
    archiveCapacity: '5chan board manager: thread archived — exceeded board capacity',
    archiveBumpLimit: '5chan board manager: thread archived — reached bump limit',
    purgeArchived: '5chan board manager: thread purged — archive retention expired',
    purgeDeleted: '5chan board manager: content purged — author-deleted',
  },
} as const

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

  const moderationReasons: Required<ModerationReasons> = {
    archiveCapacity: options.moderationReasons?.archiveCapacity ?? DEFAULTS.moderationReasons.archiveCapacity,
    archiveBumpLimit: options.moderationReasons?.archiveBumpLimit ?? DEFAULTS.moderationReasons.archiveBumpLimit,
    purgeArchived: options.moderationReasons?.purgeArchived ?? DEFAULTS.moderationReasons.purgeArchived,
    purgeDeleted: options.moderationReasons?.purgeDeleted ?? DEFAULTS.moderationReasons.purgeDeleted,
  }

  const maxThreads = perPage * pages
  let statePath = join(options.boardDir, 'state.json')

  let fileLock: FileLock
  try {
    fileLock = acquireLock(statePath)
  } catch (err) {
    throw new Error(`${(err as Error).message} for ${communityAddress}`)
  }

  let state: BoardManagerState = loadState(statePath)

  let stopped = false

  log(`starting board manager for ${communityAddress} (capacity=${maxThreads}, bumpLimit=${bumpLimit}, purgeAfter=${archivePurgeSeconds}s)`)

  const pkc = await connectToPkcRpc(pkcRpcUrl, userAgent)

  async function ensureModRole(community: Community, signerAddress: string): Promise<void> {
    const roles = community.roles ?? {}
    if (roles[signerAddress]?.role === 'moderator' || roles[signerAddress]?.role === 'admin' || roles[signerAddress]?.role === 'owner') {
      return
    }
    if (!pkc.communities.includes(communityAddress)) {
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

  function migrateAddress(newAddress: string): void {
    const oldAddress = communityAddress
    const oldStatePath = statePath

    log(`address changed: ${oldAddress} → ${newAddress}, migrating state`)

    // Migrate signer key in memory
    if (state.signers[oldAddress]) {
      state.signers[newAddress] = state.signers[oldAddress]
      delete state.signers[oldAddress]
    }

    // Release old lock
    fileLock.release()

    // Save state with migrated signers to current path (directory still has old name)
    saveState(statePath, state)

    // Notify caller — renames boards/{oldAddress}/ to boards/{newAddress}/
    options.onAddressChange?.(oldAddress, newAddress)

    // Compute new paths (directory has been renamed by onAddressChange)
    const boardsParentDir = dirname(options.boardDir)
    const newStatePath = join(boardsParentDir, newAddress, 'state.json')

    // Acquire lock on new path
    try {
      fileLock = acquireLock(newStatePath)
    } catch (err) {
      // Rollback: rename directory back, restore signer key, re-lock
      log.error(`failed to acquire lock on new state path ${newStatePath}: ${err}`)
      try { options.onAddressChange?.(newAddress, oldAddress) } catch {}
      if (state.signers[newAddress]) {
        state.signers[oldAddress] = state.signers[newAddress]
        delete state.signers[newAddress]
      }
      fileLock = acquireLock(oldStatePath)
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

  async function handleUpdate(community: Community, signer: Signer): Promise<void> {
    if (stopped) return

    // Scenario 3: no posts at all — nothing to archive.
    const preloadedPage = Object.values(community.posts.pages)[0]
    if (!community.posts.pageCids.active && !preloadedPage) {
      return
    }

    // Build full thread list from active sort pages.
    // The community IPFS record is capped at 1MB total. The first preloaded page
    // is loaded into whatever space remains. If all posts fit, there's no nextCid.
    // If they don't fit, nextCid points to additional pages to fetch.
    const threads: ThreadComment[] = []

    if (community.posts.pageCids.active) {
      // Scenario 1: pageCids.active exists — fetch active-sorted pages
      let page: Page = await community.posts.getPage({ cid: community.posts.pageCids.active })
      threads.push(...page.comments)
      while (page.nextCid) {
        page = await community.posts.getPage({ cid: page.nextCid })
        threads.push(...page.comments)
      }
    } else if (preloadedPage?.comments) {
      // Scenario 2: no pageCids.active — collect all preloaded pages, sort by active
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

    // Filter out pinned threads
    const nonPinned = threads.filter((t: ThreadComment) => !t.pinned)

    // Archive threads beyond capacity
    for (const thread of nonPinned.slice(maxThreads)) {
      if (thread.archived) continue
      if (state.archivedThreads[thread.cid]) continue
      try {
        await archiveThread(thread.cid, signer, moderationReasons.archiveCapacity)
      } catch (err) {
        log.error(`failed to archive thread ${thread.cid}: ${err}`)
      }
    }

    // Archive threads past bump limit
    for (const thread of nonPinned) {
      if (thread.archived) continue
      if (state.archivedThreads[thread.cid]) continue
      if ((thread.replyCount ?? 0) >= bumpLimit) {
        try {
          await archiveThread(thread.cid, signer, moderationReasons.archiveBumpLimit)
        } catch (err) {
          log.error(`failed to archive thread ${thread.cid}: ${err}`)
        }
      }
    }

    // Purge archived threads past archive_purge_seconds
    const now = Math.floor(Date.now() / 1000)
    for (const [cid, info] of Object.entries(state.archivedThreads)) {
      if (now - info.archivedTimestamp > archivePurgeSeconds) {
        try {
          await purgeThread(cid, signer, moderationReasons.purgeArchived)
        } catch (err) {
          log.error(`failed to purge thread ${cid}: ${err}`)
        }
      }
    }

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
  const signer = await getOrCreateSigner()
  const community = await pkc.getCommunity({ address: communityAddress })
  await ensureModRole(community, signer.address)

  let updateRunning = false
  let updatePendingRerun = false
  let lastUpdateAt = Date.now()

  const updateHandler = () => {
    lastUpdateAt = Date.now()
    if (updateRunning) {
      updatePendingRerun = true
      return
    }
    updateRunning = true

    const run = async (): Promise<void> => {
      try {
        // Detect address change (e.g., hash → named address via bitsocial-cli)
        if (community.address && community.address !== communityAddress) {
          try {
            migrateAddress(community.address)
          } catch (err) {
            log.error(`address migration failed: ${err}`)
          }
        }
        const signer = await getOrCreateSigner()
        await handleUpdate(community, signer)
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
  await community.update()
  log(`board manager running for ${communityAddress}`)

  const heartbeatPath = options.heartbeatPath
  const heartbeatIntervalMs = options.heartbeatIntervalMs
    ?? parseInt(process.env['HEARTBEAT_INTERVAL_SECONDS'] ?? '300', 10) * 1000
  const heartbeatStaleUpdateMs = options.heartbeatStaleUpdateMs
    ?? parseInt(process.env['HEARTBEAT_STALE_UPDATE_SECONDS'] ?? '1800', 10) * 1000
  const heartbeatFailureThreshold = options.heartbeatFailureThreshold
    ?? parseInt(process.env['HEARTBEAT_FAILURE_THRESHOLD'] ?? '3', 10)
  const onHeartbeatExit = options.onHeartbeatExit ?? ((): void => { process.exit(1) })

  let consecutiveStaleTicks = 0
  let heartbeatInterval: NodeJS.Timeout | undefined

  if (heartbeatPath) {
    heartbeatInterval = setInterval(() => {
      if (stopped) return
      const now = Date.now()
      const sinceLastUpdate = now - lastUpdateAt
      const lastUpdateIso = new Date(lastUpdateAt).toISOString()
      console.log(`[board ${communityAddress}] heartbeat — last update: ${lastUpdateIso} (${Math.round(sinceLastUpdate / 1000)}s ago)`)

      try {
        utimesSync(heartbeatPath, now / 1000, now / 1000)
      } catch {
        try {
          closeSync(openSync(heartbeatPath, 'w'))
        } catch (err) {
          console.error(`[board ${communityAddress}] failed to touch heartbeat file ${heartbeatPath}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (sinceLastUpdate > heartbeatStaleUpdateMs) {
        consecutiveStaleTicks++
        console.error(`[board ${communityAddress}] no update events for ${Math.round(sinceLastUpdate / 1000)}s (stale tick ${consecutiveStaleTicks}/${heartbeatFailureThreshold})`)
        if (consecutiveStaleTicks >= heartbeatFailureThreshold) {
          console.error(`[board ${communityAddress}] heartbeat threshold exceeded, exiting for restart`)
          onHeartbeatExit()
        }
      } else {
        consecutiveStaleTicks = 0
      }
    }, heartbeatIntervalMs)
  }

  return {
    async stop() {
      stopped = true
      if (heartbeatInterval) clearInterval(heartbeatInterval)
      community.removeListener('update', updateHandler)
      saveState(statePath, state)
      fileLock.release()
      await community.stop?.()
      await pkc.destroy()
      log(`board manager stopped for ${communityAddress}`)
    },
  }
}
