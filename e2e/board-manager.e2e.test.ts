import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startBoardManager } from '../src/board-manager.js'
import type { PKCInstance, BoardManagerResult, Community } from '../src/types.js'
import {
  RPC_URL,
  createPkcRpc,
  createTestCommunity,
  publishThread,
  publishReply,
  waitForThreadInPages,
  waitForThreadArchived,
  waitForThreadPinned,
  waitForReplyCount,
  waitForArchivedInState,
  waitForPurgedFromState,
  waitForSignerInState,
  createTempStateDir,
  cleanupTempDir,
  readStateFile,
  getAllThreads,
} from './helpers.js'

describe('board manager E2E', () => {
  let pkc: PKCInstance

  beforeAll(async () => {
    pkc = await createPkcRpc()
  })

  afterAll(async () => {
    await pkc.destroy()
  })

  describe('capacity archiving', () => {
    it('archives threads beyond capacity', async () => {
      const { sub, address } = await createTestCommunity(pkc)
      const { dir, statePath } = createTempStateDir()
      let boardManager: BoardManagerResult | undefined

      try {
        // Publish 4 threads sequentially, waiting for each to appear in pages
        const t1 = await publishThread(pkc, address, 'Thread 1')
        await waitForThreadInPages(sub, t1.cid)

        const t2 = await publishThread(pkc, address, 'Thread 2')
        await waitForThreadInPages(sub, t2.cid)

        const t3 = await publishThread(pkc, address, 'Thread 3')
        await waitForThreadInPages(sub, t3.cid)

        const t4 = await publishThread(pkc, address, 'Thread 4')
        await waitForThreadInPages(sub, t4.cid)

        // capacity = perPage * pages = 1 * 2 = 2
        // Active sort: T4 (newest), T3, T2, T1 (oldest)
        // T1 and T2 are beyond capacity and should be archived
        boardManager = await startBoardManager({
          communityAddress: address,
          pkcRpcUrl: RPC_URL,
          boardDir: dir,
          perPage: 1,
          pages: 2,
        })

        // Wait for the oldest threads to be archived in state
        await waitForArchivedInState(statePath, t1.cid)
        await waitForArchivedInState(statePath, t2.cid)

        // Verify state file
        const state = readStateFile(statePath)
        expect(state.archivedThreads[t1.cid]).toBeDefined()
        expect(state.archivedThreads[t2.cid]).toBeDefined()
        expect(state.archivedThreads[t3.cid]).toBeUndefined()
        expect(state.archivedThreads[t4.cid]).toBeUndefined()
        expect(state.signers[address]).toBeDefined()

        // Verify threads are actually archived in community pages
        await waitForThreadArchived(sub, t1.cid)
        await waitForThreadArchived(sub, t2.cid)

        // Verify T3 and T4 are NOT archived in pages
        const threads = await getAllThreads(sub)
        const t3InPages = threads.find((t) => t.cid === t3.cid)
        const t4InPages = threads.find((t) => t.cid === t4.cid)
        expect(t3InPages?.archived).toBeUndefined()
        expect(t4InPages?.archived).toBeUndefined()
      } finally {
        if (boardManager) await boardManager.stop()
        await sub.stop()
        cleanupTempDir(dir)
      }
    })

    it('does not archive threads within capacity', async () => {
      const { sub, address } = await createTestCommunity(pkc)
      const { dir, statePath } = createTempStateDir()
      let boardManager: BoardManagerResult | undefined

      try {
        // Publish 3 threads
        const t1 = await publishThread(pkc, address, 'Thread A')
        await waitForThreadInPages(sub, t1.cid)

        const t2 = await publishThread(pkc, address, 'Thread B')
        await waitForThreadInPages(sub, t2.cid)

        const t3 = await publishThread(pkc, address, 'Thread C')
        await waitForThreadInPages(sub, t3.cid)

        // capacity = 5 * 1 = 5, we only have 3 threads — all within capacity
        boardManager = await startBoardManager({
          communityAddress: address,
          pkcRpcUrl: RPC_URL,
          boardDir: dir,
          perPage: 5,
          pages: 1,
        })

        // Wait for board manager to be ready (signer created in state)
        await waitForSignerInState(statePath, address)

        // Give a few update cycles
        await new Promise((resolve) => setTimeout(resolve, 10_000))

        // Verify no threads were archived in state
        const state = readStateFile(statePath)
        expect(Object.keys(state.archivedThreads)).toHaveLength(0)

        // Verify no threads are archived in pages
        const threads = await getAllThreads(sub)
        for (const thread of threads) {
          expect(thread.archived).toBeUndefined()
        }
      } finally {
        if (boardManager) await boardManager.stop()
        await sub.stop()
        cleanupTempDir(dir)
      }
    })
  })

  describe('bump limit', () => {
    const SORT_NAME = '@pkcprotocol/active-page-sort'

    async function runActivePageSort(sub: Community, bumpLimit: string): Promise<void> {
      await sub.edit({
        settings: {
          ...sub.settings,
          pages: {
            posts: [{ name: SORT_NAME, options: { noBumpKeywords: 'sage', bumpLimit }, preloaded: true }],
            replies: [{ name: 'old', preloaded: true }, { name: 'new' }],
          },
        },
      })
    }

    /** Resolve once `condition` holds on the community, checking now and on every update. */
    async function waitForCommunity(sub: Community, condition: () => boolean, what: string, timeoutMs = 120_000): Promise<void> {
      if (condition()) return
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          sub.removeListener('update', check)
          reject(new Error(`timed out waiting for ${what}`))
        }, timeoutMs)
        function check() {
          if (!condition()) return
          clearTimeout(timeout)
          sub.removeListener('update', check)
          resolve()
        }
        sub.on('update', check)
      })
    }

    // Comment timestamps have one-second resolution, so steps that must be
    // ordered in time are spaced out
    const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1_100))

    /**
     * A, a reply to A, then B, then C, then a second reply to A. With a bump
     * limit of 1 the second reply does not bump A, so the order is C, B, A;
     * without a limit (and in lastReplyTimestamp order) it is A, C, B.
     */
    async function publishThreadPastBumpLimit(sub: Community, address: string) {
      const a = await publishThread(pkc, address, 'Thread A')
      await waitForThreadInPages(sub, a.cid)
      await nextSecond()
      await publishReply(pkc, address, a.cid)
      await waitForReplyCount(sub, a.cid, 1)
      await nextSecond()
      const b = await publishThread(pkc, address, 'Thread B')
      await waitForThreadInPages(sub, b.cid)
      await nextSecond()
      const c = await publishThread(pkc, address, 'Thread C')
      await waitForThreadInPages(sub, c.cid)
      await nextSecond()
      await publishReply(pkc, address, a.cid)
      await waitForReplyCount(sub, a.cid, 2)
      return { a, b, c }
    }

    it('writes the configured bump limit into active-page-sort', async () => {
      const { sub, address } = await createTestCommunity(pkc)
      const { dir, statePath } = createTempStateDir()
      let boardManager: BoardManagerResult | undefined

      try {
        await runActivePageSort(sub, '300')
        await waitForCommunity(sub, () => sub.pageSorts?.posts?.active?.name === SORT_NAME, 'the sort to be published')

        boardManager = await startBoardManager({
          communityAddress: address,
          pkcRpcUrl: RPC_URL,
          boardDir: dir,
          bumpLimit: 7,
        })
        await waitForSignerInState(statePath, address)

        await waitForCommunity(
          sub,
          () => sub.pageSorts?.posts?.active?.publicOptions?.bumpLimit === '7',
          'the published sort to carry bumpLimit 7',
        )
        const entry = sub.settings?.pages?.posts?.[0]
        expect(entry).toEqual({ name: SORT_NAME, options: { noBumpKeywords: 'sage', bumpLimit: '7' }, preloaded: true })
        // The rest of the settings survive the edit
        expect(sub.settings?.challenges).toEqual([])
        expect(sub.settings?.pages?.replies).toEqual([{ name: 'old', preloaded: true }, { name: 'new' }])
      } finally {
        if (boardManager) await boardManager.stop()
        await sub.stop()
        cleanupTempDir(dir)
      }
    })

    it('lets a thread past the bump limit sink and archives it at capacity', async () => {
      const { sub, address } = await createTestCommunity(pkc)
      const { dir, statePath } = createTempStateDir()
      let boardManager: BoardManagerResult | undefined

      try {
        await runActivePageSort(sub, '1')
        await waitForCommunity(sub, () => sub.pageSorts?.posts?.active?.publicOptions?.bumpLimit === '1', 'the sort to be published')
        const { a, b, c } = await publishThreadPastBumpLimit(sub, address)

        // capacity = 1 * 2 = 2: only the thread that sank below B and C goes
        boardManager = await startBoardManager({
          communityAddress: address,
          pkcRpcUrl: RPC_URL,
          boardDir: dir,
          bumpLimit: 1,
          perPage: 1,
          pages: 2,
        })

        await waitForArchivedInState(statePath, a.cid)
        await waitForThreadArchived(sub, a.cid)
        // A few more update cycles, to catch a wrong archive of B or C
        await new Promise((resolve) => setTimeout(resolve, 10_000))

        const state = readStateFile(statePath)
        expect(Object.keys(state.archivedThreads)).toEqual([a.cid])
        const threads = await getAllThreads(sub)
        expect(threads.find((t) => t.cid === b.cid)?.archived).toBeUndefined()
        expect(threads.find((t) => t.cid === c.cid)?.archived).toBeUndefined()
      } finally {
        if (boardManager) await boardManager.stop()
        await sub.stop()
        cleanupTempDir(dir)
      }
    })

    it('does not archive a thread at the bump limit while it is within capacity', async () => {
      const { sub, address } = await createTestCommunity(pkc)
      const { dir, statePath } = createTempStateDir()
      let boardManager: BoardManagerResult | undefined

      try {
        await runActivePageSort(sub, '1')
        await waitForCommunity(sub, () => sub.pageSorts?.posts?.active?.publicOptions?.bumpLimit === '1', 'the sort to be published')
        await publishThreadPastBumpLimit(sub, address)

        boardManager = await startBoardManager({
          communityAddress: address,
          pkcRpcUrl: RPC_URL,
          boardDir: dir,
          bumpLimit: 1,
          perPage: 15,
          pages: 10,
        })
        await waitForSignerInState(statePath, address)
        await new Promise((resolve) => setTimeout(resolve, 10_000))

        expect(Object.keys(readStateFile(statePath).archivedThreads)).toHaveLength(0)
      } finally {
        if (boardManager) await boardManager.stop()
        await sub.stop()
        cleanupTempDir(dir)
      }
    })

    it('archives by the new limit when the board manager changes it', async () => {
      const { sub, address } = await createTestCommunity(pkc)
      const { dir, statePath } = createTempStateDir()
      let boardManager: BoardManagerResult | undefined

      try {
        // The sort starts without an effective limit: A is on top (A, C, B)
        await runActivePageSort(sub, '300')
        await waitForCommunity(sub, () => sub.pageSorts?.posts?.active?.publicOptions?.bumpLimit === '300', 'the sort to be published')
        const { a, b, c } = await publishThreadPastBumpLimit(sub, address)

        boardManager = await startBoardManager({
          communityAddress: address,
          pkcRpcUrl: RPC_URL,
          boardDir: dir,
          bumpLimit: 1,
          perPage: 1,
          pages: 2,
        })

        // The manager holds capacity archiving until a record generated after its edit.
        // A quiet board only republishes on its timer, so nudge it with an edit that
        // does not touch the thread order.
        await waitForCommunity(sub, () => sub.settings?.pages?.posts?.[0]?.options?.bumpLimit === '1', 'the manager to set bumpLimit 1')
        await nextSecond()
        await nextSecond()
        await sub.edit({ title: 'republish after the bump limit change' })

        await waitForArchivedInState(statePath, a.cid)
        await new Promise((resolve) => setTimeout(resolve, 10_000))

        const state = readStateFile(statePath)
        expect(state.archivedThreads[b.cid]).toBeUndefined()
        expect(state.archivedThreads[c.cid]).toBeUndefined()
      } finally {
        if (boardManager) await boardManager.stop()
        await sub.stop()
        cleanupTempDir(dir)
      }
    })
  })

  describe('purge', () => {
    it('purges archived thread after archivePurgeSeconds', async () => {
      const { sub, address } = await createTestCommunity(pkc)
      const { dir, statePath } = createTempStateDir()
      let boardManager: BoardManagerResult | undefined

      try {
        // Publish 2 threads (T1 oldest, T2 newest)
        const t1 = await publishThread(pkc, address, 'Old Thread')
        await waitForThreadInPages(sub, t1.cid)

        const t2 = await publishThread(pkc, address, 'New Thread')
        await waitForThreadInPages(sub, t2.cid)

        // capacity=1, purge after 5 seconds.
        // The board goes quiet once T1 is archived, so no further `update` events
        // are guaranteed to arrive — the purge sweep is what makes this
        // deterministic rather than a race against unrelated board activity.
        boardManager = await startBoardManager({
          communityAddress: address,
          pkcRpcUrl: RPC_URL,
          boardDir: dir,
          perPage: 1,
          pages: 1,
          archivePurgeSeconds: 5,
          purgeSweepIntervalMs: 1_000,
        })

        // T1 should get archived first (beyond capacity)
        await waitForArchivedInState(statePath, t1.cid)

        // Verify it's archived in state
        const stateBeforePurge = readStateFile(statePath)
        expect(stateBeforePurge.archivedThreads[t1.cid]).toBeDefined()

        // Wait for purge (5s retention + up to one sweep interval)
        await waitForPurgedFromState(statePath, t1.cid, 60_000)

        // Verify T1 removed from state (purged)
        const stateAfterPurge = readStateFile(statePath)
        expect(stateAfterPurge.archivedThreads[t1.cid]).toBeUndefined()
      } finally {
        if (boardManager) await boardManager.stop()
        await sub.stop()
        cleanupTempDir(dir)
      }
    })
  })

  describe('pinned thread exemption', () => {
    it('does not archive pinned threads', async () => {
      const { sub, address } = await createTestCommunity(pkc)
      const { dir, statePath } = createTempStateDir()
      let boardManager: BoardManagerResult | undefined

      try {
        // Publish 3 threads
        const t1 = await publishThread(pkc, address, 'Thread X')
        await waitForThreadInPages(sub, t1.cid)

        const t2 = await publishThread(pkc, address, 'Thread Y')
        await waitForThreadInPages(sub, t2.cid)

        const t3 = await publishThread(pkc, address, 'Thread Z')
        await waitForThreadInPages(sub, t3.cid)

        // Pin T3 using a moderator signer
        const modSigner = await pkc.createSigner()
        await sub.edit({
          roles: { ...sub.roles, [modSigner.address]: { role: 'moderator' } },
        })
        const pinMod = await pkc.createCommentModeration({
          commentCid: t3.cid,
          commentModeration: { pinned: true },
          communityAddress: address,
          signer: modSigner,
        })
        await pinMod.publish()

        // Wait for T3 to show as pinned in pages
        await waitForThreadPinned(sub, t3.cid)

        // capacity=1, so among non-pinned (T1, T2), only 1 fits
        // Active sort: T2 (newer), T1 (older) → T1 beyond capacity
        boardManager = await startBoardManager({
          communityAddress: address,
          pkcRpcUrl: RPC_URL,
          boardDir: dir,
          perPage: 1,
          pages: 1,
        })

        // Wait for T1 to be archived (oldest non-pinned beyond capacity)
        await waitForArchivedInState(statePath, t1.cid)

        // Verify state
        const state = readStateFile(statePath)
        expect(state.archivedThreads[t1.cid]).toBeDefined()
        expect(state.archivedThreads[t2.cid]).toBeUndefined()
        expect(state.archivedThreads[t3.cid]).toBeUndefined()

        // Verify T1 is actually archived in pages
        await waitForThreadArchived(sub, t1.cid)

        // Verify T3 is NOT archived in pages (pinned exempt)
        const threads = await getAllThreads(sub)
        const t3InPages = threads.find((t) => t.cid === t3.cid)
        expect(t3InPages?.archived).toBeUndefined()
        expect(t3InPages?.pinned).toBe(true)

        // Verify T2 is NOT archived in pages
        const t2InPages = threads.find((t) => t.cid === t2.cid)
        expect(t2InPages?.archived).toBeUndefined()
      } finally {
        if (boardManager) await boardManager.stop()
        await sub.stop()
        cleanupTempDir(dir)
      }
    })
  })
})
