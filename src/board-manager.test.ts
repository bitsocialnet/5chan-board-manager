import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadState, saveState } from './state.js'
import type { BoardManagerState, PKCInstance, Page, ThreadComment } from './types.js'
import { startBoardManager } from './board-manager.js'

vi.mock('./pkc-rpc.js', () => ({
  connectToPkcRpc: vi.fn(),
}))

import { connectToPkcRpc } from './pkc-rpc.js'

// Helper to create a mock thread
function mockThread(cid: string, overrides: Record<string, unknown> = {}): ThreadComment {
  return { cid, pinned: false, archived: false, replyCount: 0, ...overrides } as unknown as ThreadComment
}

interface MockModerationRecord {
  commentCid: string
  commentModeration: { archived?: boolean; purged?: boolean; reason?: string }
  communityAddress: string
  signer: { address: string; privateKey: string; type: 'ed25519' }
}

// Helper to create a mock PKC instance (RPC-only, no dataPath)
function createMockPKC() {
  const mockSigner = { address: 'mock-address-123', privateKey: 'mock-pk-123' }
  const publishedModerations: MockModerationRecord[] = []

  const instance = {
    createSigner: vi.fn().mockResolvedValue({ ...mockSigner }),
    getCommunity: vi.fn(),
    communities: [] as string[],
    createCommentModeration: vi.fn().mockImplementation((opts: MockModerationRecord) => ({
      ...opts,
      publish: vi.fn().mockImplementation(async () => {
        publishedModerations.push(opts)
      }),
    })),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as PKCInstance

  vi.mocked(connectToPkcRpc).mockResolvedValue(instance)

  return {
    instance,
    mockSigner,
    publishedModerations,
  }
}

// Helper to create a mock community with posts configuration
function createMockCommunity(postsConfig: {
  pageCids?: Partial<Record<string, string>>
  pages?: Partial<Record<string, Page>>
  getPage?: (args: { cid: string }) => Promise<Page>
}, address?: string) {
  let updateCallback: (() => void) | undefined
  return {
    address: address ?? 'board.bso',
    roles: { 'mock-address-123': { role: 'moderator' as const } },
    posts: {
      pageCids: postsConfig.pageCids ?? {},
      pages: postsConfig.pages ?? {},
      getPage: postsConfig.getPage ?? vi.fn(),
    },
    on: vi.fn().mockImplementation((event: string, cb: () => void) => {
      if (event === 'update') updateCallback = cb
    }),
    update: vi.fn().mockImplementation(async () => {
      updateCallback?.()
    }),
    edit: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    removeListener: vi.fn(),
    // expose for tests to trigger update events manually
    _triggerUpdate: () => updateCallback?.(),
  }
}

describe('board manager logic', () => {
  let dir: string
  let boardDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-manager-test-'))
    boardDir = join(dir, 'boards', 'board.bso')
    mkdirSync(boardDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('state-based thread tracking', () => {
    it('records archivedTimestamp when adding an archived thread', () => {
      const filePath = join(dir, 'test-state.json')
      const state: BoardManagerState = { signers: {}, archivedThreads: {} }
      const now = Math.floor(Date.now() / 1000)
      state.archivedThreads['QmTest'] = { archivedTimestamp: now }
      saveState(filePath, state)

      const loaded = loadState(filePath)
      expect(loaded.archivedThreads['QmTest'].archivedTimestamp).toBe(now)
    })

    it('removes thread from state on purge', () => {
      const filePath = join(dir, 'test-state.json')
      const state: BoardManagerState = {
        signers: {},
        archivedThreads: {
          'QmKeep': { archivedTimestamp: 1000 },
          'QmPurge': { archivedTimestamp: 500 },
        },
      }
      delete state.archivedThreads['QmPurge']
      saveState(filePath, state)

      const loaded = loadState(filePath)
      expect(loaded.archivedThreads['QmKeep']).toBeDefined()
      expect(loaded.archivedThreads['QmPurge']).toBeUndefined()
    })
  })

  describe('thread filtering', () => {
    it('filters out pinned threads', () => {
      const threads = [
        mockThread('Qm1', { pinned: true }),
        mockThread('Qm2'),
        mockThread('Qm3'),
        mockThread('Qm4', { pinned: true }),
      ]
      const nonPinned = threads.filter((t) => !t.pinned)
      expect(nonPinned).toHaveLength(2)
      expect(nonPinned.map((t) => t.cid)).toEqual(['Qm2', 'Qm3'])
    })

    it('identifies threads beyond capacity', () => {
      const perPage = 2
      const pages = 2
      const maxThreads = perPage * pages // 4

      const threads = Array.from({ length: 6 }, (_, i) => mockThread(`Qm${i}`))
      const nonPinned = threads.filter((t) => !t.pinned)
      const beyondCapacity = nonPinned.slice(maxThreads)

      expect(beyondCapacity).toHaveLength(2)
      expect(beyondCapacity.map((t) => t.cid)).toEqual(['Qm4', 'Qm5'])
    })

    it('skips already archived threads', () => {
      const threads = [
        mockThread('Qm1'),
        mockThread('Qm2'),
        mockThread('Qm3', { archived: true }),
        mockThread('Qm4'),
        mockThread('Qm5'),
      ]
      const maxThreads = 2
      const nonPinned = threads.filter((t) => !t.pinned)
      const beyondCapacity = nonPinned.slice(maxThreads)
      const toArchive = beyondCapacity.filter((t) => !t.archived)

      expect(toArchive).toHaveLength(2)
      expect(toArchive.map((t) => t.cid)).toEqual(['Qm4', 'Qm5'])
    })
  })

  describe('active sort from hot pages', () => {
    it('sorts threads by lastReplyTimestamp descending', () => {
      const threads = [
        mockThread('QmA', { lastReplyTimestamp: 100 }),
        mockThread('QmB', { lastReplyTimestamp: 300 }),
        mockThread('QmC', { lastReplyTimestamp: 200 }),
      ]
      threads.sort((a, b) => {
        const diff = (b.lastReplyTimestamp ?? 0) - (a.lastReplyTimestamp ?? 0)
        if (diff !== 0) return diff
        return (b.postNumber ?? 0) - (a.postNumber ?? 0)
      })
      expect(threads.map((t) => t.cid)).toEqual(['QmB', 'QmC', 'QmA'])
    })

    it('breaks ties by postNumber descending', () => {
      const threads = [
        mockThread('QmX', { lastReplyTimestamp: 500, postNumber: 10 }),
        mockThread('QmY', { lastReplyTimestamp: 500, postNumber: 30 }),
        mockThread('QmZ', { lastReplyTimestamp: 500, postNumber: 20 }),
      ]
      threads.sort((a, b) => {
        const diff = (b.lastReplyTimestamp ?? 0) - (a.lastReplyTimestamp ?? 0)
        if (diff !== 0) return diff
        return (b.postNumber ?? 0) - (a.postNumber ?? 0)
      })
      // Same timestamp → sorted by postNumber desc: 30, 20, 10
      expect(threads.map((t) => t.cid)).toEqual(['QmY', 'QmZ', 'QmX'])
    })
  })

  describe('bump limit detection', () => {
    it('identifies threads at or above bump limit', () => {
      const bumpLimit = 300
      const threads = [
        mockThread('Qm1', { replyCount: 100 }),
        mockThread('Qm2', { replyCount: 300 }),
        mockThread('Qm3', { replyCount: 500 }),
        mockThread('Qm4', { replyCount: 299 }),
      ]
      const atBumpLimit = threads.filter((t) => t.replyCount >= bumpLimit)
      expect(atBumpLimit.map((t) => t.cid)).toEqual(['Qm2', 'Qm3'])
    })

    it('skips archived threads when checking bump limit', () => {
      const bumpLimit = 300
      const threads = [
        mockThread('Qm1', { replyCount: 300, archived: true }),
        mockThread('Qm2', { replyCount: 400 }),
      ]
      const toArchive = threads.filter((t) => t.replyCount >= bumpLimit && !t.archived)
      expect(toArchive).toHaveLength(1)
      expect(toArchive[0].cid).toBe('Qm2')
    })
  })

  describe('purge timing', () => {
    it('identifies threads past archive_purge_seconds', () => {
      const archivePurgeSeconds = 172800 // 48h
      const now = Math.floor(Date.now() / 1000)
      const state: BoardManagerState = {
        signers: {},
        archivedThreads: {
          'QmOld': { archivedTimestamp: now - 200000 }, // > 48h ago
          'QmRecent': { archivedTimestamp: now - 1000 }, // < 48h ago
          'QmExact': { archivedTimestamp: now - 172800 }, // exactly 48h ago
        },
      }

      const toPurge = Object.entries(state.archivedThreads)
        .filter(([_, info]) => now - info.archivedTimestamp > archivePurgeSeconds)
      // "QmExact" is exactly at the boundary (not >), so only QmOld
      expect(toPurge.map(([cid]) => cid)).toEqual(['QmOld'])
    })

    it('does not purge threads archived less than archive_purge_seconds ago', () => {
      const archivePurgeSeconds = 172800
      const now = Math.floor(Date.now() / 1000)
      const state: BoardManagerState = {
        signers: {},
        archivedThreads: {
          'Qm1': { archivedTimestamp: now - 100 },
          'Qm2': { archivedTimestamp: now },
        },
      }

      const toPurge = Object.entries(state.archivedThreads)
        .filter(([_, info]) => now - info.archivedTimestamp > archivePurgeSeconds)
      expect(toPurge).toHaveLength(0)
    })
  })

  describe('signer management', () => {
    it('persists signer to state file', () => {
      const filePath = join(dir, 'test-state.json')
      const state: BoardManagerState = { signers: {}, archivedThreads: {} }
      state.signers['my-board.bso'] = { privateKey: 'test-private-key' }
      saveState(filePath, state)

      const loaded = loadState(filePath)
      expect(loaded.signers['my-board.bso'].privateKey).toBe('test-private-key')
    })

    it('retrieves existing signer from state', () => {
      const filePath = join(dir, 'test-state.json')
      const state: BoardManagerState = {
        signers: { 'board.bso': { privateKey: 'existing-key' } },
        archivedThreads: {},
      }
      saveState(filePath, state)

      const loaded = loadState(filePath)
      expect(loaded.signers['board.bso']).toBeDefined()
      expect(loaded.signers['board.bso'].privateKey).toBe('existing-key')
    })

    it('handles multiple signers for different communities', () => {
      const filePath = join(dir, 'test-state.json')
      const state: BoardManagerState = {
        signers: {
          'board1.bso': { privateKey: 'key1' },
          'board2.bso': { privateKey: 'key2' },
        },
        archivedThreads: {},
      }
      saveState(filePath, state)

      const loaded = loadState(filePath)
      expect(Object.keys(loaded.signers)).toHaveLength(2)
      expect(loaded.signers['board1.bso'].privateKey).toBe('key1')
      expect(loaded.signers['board2.bso'].privateKey).toBe('key2')
    })
  })

  describe('idempotency', () => {
    it('skips threads already tracked in archivedThreads state', () => {
      const state: BoardManagerState = {
        signers: {},
        archivedThreads: { 'QmAlready': { archivedTimestamp: 1000 } },
      }
      const threads = [mockThread('QmAlready'), mockThread('QmNew')]
      const maxThreads = 0 // all beyond capacity

      const nonPinned = threads.filter((t) => !t.pinned)
      const beyondCapacity = nonPinned.slice(maxThreads)
      const toArchive = beyondCapacity.filter((t) => !t.archived && !state.archivedThreads[t.cid])

      expect(toArchive).toHaveLength(1)
      expect(toArchive[0].cid).toBe('QmNew')
    })
  })

  describe('cold start', () => {
    it('handles many threads needing archive at once', () => {
      const perPage = 2
      const pages = 1
      const maxThreads = perPage * pages // 2

      // Simulate 50 threads on a board that's been running without board manager
      const threads = Array.from({ length: 50 }, (_, i) => mockThread(`Qm${i}`))
      const nonPinned = threads.filter((t) => !t.pinned)
      const beyondCapacity = nonPinned.slice(maxThreads)
      const toArchive = beyondCapacity.filter((t) => !t.archived)

      expect(toArchive).toHaveLength(48)
    })
  })

  describe('createCommentModeration mock', () => {
    it('creates archive moderation with correct shape', async () => {
      const { instance } = createMockPKC()
      const mod = await instance.createCommentModeration({
        commentCid: 'QmTest',
        commentModeration: { archived: true },
        communityAddress: 'board.bso',
        signer: { address: 'addr', privateKey: 'pk', type: 'ed25519' },
      })
      expect(instance.createCommentModeration).toHaveBeenCalledWith({
        commentCid: 'QmTest',
        commentModeration: { archived: true },
        communityAddress: 'board.bso',
        signer: { address: 'addr', privateKey: 'pk', type: 'ed25519' },
      })
      expect(mod.publish).toBeDefined()
    })

    it('creates purge moderation with correct shape', async () => {
      const { instance } = createMockPKC()
      const mod = await instance.createCommentModeration({
        commentCid: 'QmTest',
        commentModeration: { purged: true },
        communityAddress: 'board.bso',
        signer: { address: 'addr', privateKey: 'pk', type: 'ed25519' },
      })
      expect(mod.commentModeration.purged).toBe(true)
    })

    it('tracks published moderations', async () => {
      const { instance, publishedModerations } = createMockPKC()
      const mod = await instance.createCommentModeration({
        commentCid: 'QmTest',
        commentModeration: { archived: true },
        communityAddress: 'board.bso',
        signer: { address: 'addr', privateKey: 'pk', type: 'ed25519' },
      })
      await mod.publish()
      expect(publishedModerations).toHaveLength(1)
      expect(publishedModerations[0].commentCid).toBe('QmTest')
    })
  })

  describe('thread fetching scenarios', () => {
    it('returns early when community has no posts', async () => {
      const { instance, publishedModerations } = createMockPKC()
      const mockSub = createMockCommunity({
        pageCids: {},
        pages: {},
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 15,
        pages: 10,
      })

      // No moderations should have been published
      expect(publishedModerations).toHaveLength(0)
      await boardManager.stop()
    })

    it('fetches all threads via pageCids.active with single page', async () => {
      const { instance, publishedModerations } = createMockPKC()
      const threadsOnPage = Array.from({ length: 5 }, (_, i) => mockThread(`QmActive${i}`))
      const getPage = vi.fn().mockResolvedValue({
        comments: threadsOnPage,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmActivePage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 2,
        pages: 1, // capacity = 2, so 3 threads should get archived
      })

      // Wait for moderations to be published (3 threads beyond capacity of 2)
      await vi.waitFor(() => {
        expect(publishedModerations).toHaveLength(3)
      })

      expect(getPage).toHaveBeenCalledWith({ cid: 'QmActivePage1' })

      const archivedCids = publishedModerations.map((m) => m.commentCid)
      expect(archivedCids).toEqual(['QmActive2', 'QmActive3', 'QmActive4'])
      await boardManager.stop()
    })

    it('paginates via nextCid when multiple pages exist', async () => {
      const { instance, publishedModerations } = createMockPKC()
      const page1Threads = [mockThread('QmP1a'), mockThread('QmP1b')]
      const page2Threads = [mockThread('QmP2a'), mockThread('QmP2b')]

      const getPage = vi.fn()
        .mockResolvedValueOnce({ comments: page1Threads, nextCid: 'QmPage2Cid' } as Page)
        .mockResolvedValueOnce({ comments: page2Threads, nextCid: undefined } as Page)

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmPage1Cid' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 1,
        pages: 1, // capacity = 1, so 3 threads should get archived
      })

      // 4 total threads, capacity 1 → 3 archived
      await vi.waitFor(() => {
        expect(publishedModerations).toHaveLength(3)
      })

      // Verify both pages were fetched with correct CIDs
      expect(getPage).toHaveBeenCalledTimes(2)
      expect(getPage).toHaveBeenCalledWith({ cid: 'QmPage1Cid' })
      expect(getPage).toHaveBeenCalledWith({ cid: 'QmPage2Cid' })

      const archivedCids = publishedModerations.map((m) => m.commentCid)
      expect(archivedCids).toEqual(['QmP1b', 'QmP2a', 'QmP2b'])
      await boardManager.stop()
    })

    it('falls back to preloaded hot page when pageCids.active is absent', async () => {
      const { instance, publishedModerations } = createMockPKC()
      // Threads with lastReplyTimestamp so active sort is deterministic
      const hotThreads = [
        mockThread('QmHot0', { lastReplyTimestamp: 400, postNumber: 1 }),
        mockThread('QmHot1', { lastReplyTimestamp: 300, postNumber: 2 }),
        mockThread('QmHot2', { lastReplyTimestamp: 200, postNumber: 3 }),
        mockThread('QmHot3', { lastReplyTimestamp: 100, postNumber: 4 }),
      ]

      const mockSub = createMockCommunity({
        pageCids: {}, // no active pageCid
        pages: {
          hot: { comments: hotThreads, nextCid: undefined } as Page,
        },
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 1,
        pages: 2, // capacity = 2, so 2 threads should get archived
      })

      await vi.waitFor(() => {
        expect(publishedModerations).toHaveLength(2)
      })

      // After sort by lastReplyTimestamp desc: QmHot0(400), QmHot1(300), QmHot2(200), QmHot3(100)
      // Capacity 2 → QmHot2 and QmHot3 get archived
      const archivedCids = publishedModerations.map((m) => m.commentCid)
      expect(archivedCids).toEqual(['QmHot2', 'QmHot3'])
      await boardManager.stop()
    })

    it('paginates hot pages via nextCid when pageCids.active is absent', async () => {
      const { instance, publishedModerations } = createMockPKC()
      // Page 1 (preloaded): newer threads
      const page1Threads = [
        mockThread('QmH1', { lastReplyTimestamp: 500, postNumber: 10 }),
        mockThread('QmH2', { lastReplyTimestamp: 400, postNumber: 9 }),
      ]
      // Page 2 (fetched via nextCid): older threads
      const page2Threads = [
        mockThread('QmH3', { lastReplyTimestamp: 300, postNumber: 8 }),
        mockThread('QmH4', { lastReplyTimestamp: 200, postNumber: 7 }),
      ]

      const getPage = vi.fn().mockResolvedValue({
        comments: page2Threads,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockCommunity({
        pageCids: {}, // no active pageCid
        pages: {
          hot: { comments: page1Threads, nextCid: 'QmHotPage2' } as Page,
        },
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 1,
        pages: 1, // capacity = 1, so 3 threads archived
      })

      // All 4 threads collected, sorted by lastReplyTimestamp desc: QmH1(500), QmH2(400), QmH3(300), QmH4(200)
      // Capacity 1 → 3 archived
      await vi.waitFor(() => {
        expect(publishedModerations).toHaveLength(3)
      })

      expect(getPage).toHaveBeenCalledWith({ cid: 'QmHotPage2' })

      const archivedCids = publishedModerations.map((m) => m.commentCid)
      expect(archivedCids).toEqual(['QmH2', 'QmH3', 'QmH4'])
      await boardManager.stop()
    })

    it('throws for remote community when signer has no mod role', async () => {
      const { instance } = createMockPKC()
      // communities is empty → board.bso is remote
      ;(instance as unknown as { communities: string[] }).communities = []

      const mockSub = createMockCommunity({
        pageCids: {},
        pages: {},
      })
      // Signer has no role
      ;(mockSub as unknown as { roles: Record<string, unknown> }).roles = {}
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      await expect(startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
      })).rejects.toThrow(
        'Signer mock-address-123 does not have a moderator role on remote community board.bso. Ask the community owner to add this address as a moderator.'
      )
    })

    it('starts successfully for remote community when signer has mod role', async () => {
      const { instance } = createMockPKC()
      // communities is empty → board.bso is remote
      ;(instance as unknown as { communities: string[] }).communities = []

      const mockSub = createMockCommunity({
        pageCids: {},
        pages: {},
      })
      // Signer already has moderator role
      mockSub.roles = { 'mock-address-123': { role: 'moderator' as const } }
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
      })

      // Should not have called edit (role already exists)
      expect(mockSub.edit).not.toHaveBeenCalled()
      await boardManager.stop()
    })

    it('auto-grants mod role for local community without mod role', async () => {
      const { instance } = createMockPKC()
      // communities includes board.bso → it's local
      ;(instance as unknown as { communities: string[] }).communities = ['board.bso']

      const mockSub = createMockCommunity({
        pageCids: {},
        pages: {},
      })
      // Signer has no role
      ;(mockSub as unknown as { roles: Record<string, unknown> }).roles = {}
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
      })

      // Should have called edit to auto-grant moderator role
      expect(mockSub.edit).toHaveBeenCalledWith({
        roles: { 'mock-address-123': { role: 'moderator' } },
      })
      await boardManager.stop()
    })

  })

  describe('update serialization', () => {
    it('serializes concurrent update events', async () => {
      const { instance } = createMockPKC()

      // Use a deferred promise to block getPage so we can control timing
      let resolveGetPage: ((value: Page) => void) | undefined
      const getPageCalls: string[] = []
      const getPage = vi.fn().mockImplementation(({ cid }: { cid: string }) => {
        getPageCalls.push(cid)
        return new Promise<Page>((resolve) => {
          resolveGetPage = resolve
        })
      })

      const threads = [mockThread('Qm1'), mockThread('Qm2'), mockThread('Qm3')]

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 15,
        pages: 10,
      })

      // First update is now in progress (blocked on getPage).
      // Wait for the first getPage call to be made.
      await vi.waitFor(() => {
        expect(getPageCalls).toHaveLength(1)
      })

      // Fire two more updates while the first is blocked.
      // Due to serialization, these should coalesce into a single re-run.
      mockSub._triggerUpdate()
      mockSub._triggerUpdate()

      // Resolve the first getPage — first handleUpdate completes
      resolveGetPage!({ comments: threads, nextCid: undefined } as Page)

      // Wait for the coalesced re-run's getPage call
      await vi.waitFor(() => {
        expect(getPageCalls).toHaveLength(2)
      })

      // Resolve the second getPage
      resolveGetPage!({ comments: threads, nextCid: undefined } as Page)

      // Wait for the second run to complete
      await new Promise((r) => setTimeout(r, 50))

      // getPage should have been called exactly 2 times (initial + one coalesced re-run),
      // NOT 3 times (which would indicate no coalescing)
      expect(getPageCalls).toHaveLength(2)

      await boardManager.stop()
    })

    it('does not re-run when no update arrives during handleUpdate', async () => {
      const { instance } = createMockPKC()
      const getPageCalls: string[] = []
      const getPage = vi.fn().mockImplementation(({ cid }: { cid: string }) => {
        getPageCalls.push(cid)
        return Promise.resolve({ comments: [mockThread('Qm1')], nextCid: undefined } as Page)
      })

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 15,
        pages: 10,
      })

      // The initial update from community.update() triggers one handleUpdate
      await vi.waitFor(() => {
        expect(getPageCalls).toHaveLength(1)
      })

      // Wait a bit to confirm no additional runs happen
      await new Promise((r) => setTimeout(r, 50))
      expect(getPageCalls).toHaveLength(1)

      await boardManager.stop()
    })
  })

  describe('process lock', () => {
    it('throws when lock is held by a live PID', async () => {
      const lockPath = join(boardDir, 'state.json.lock')
      writeFileSync(lockPath, String(process.pid))

      const { instance } = createMockPKC()
      const mockSub = createMockCommunity({ pageCids: {}, pages: {} })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      await expect(startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
      })).rejects.toThrow(`Another board manager (PID ${process.pid}) is already running for board.bso`)
    })

    it('succeeds when lock has stale PID', async () => {
      const lockPath = join(boardDir, 'state.json.lock')
      writeFileSync(lockPath, '999999')

      const { instance } = createMockPKC()
      const mockSub = createMockCommunity({ pageCids: {}, pages: {} })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
      })

      expect(existsSync(lockPath)).toBe(true)
      await boardManager.stop()
    })

    it('releases lock on stop()', async () => {
      const { instance } = createMockPKC()
      const mockSub = createMockCommunity({ pageCids: {}, pages: {} })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
      })

      const lockPath = join(boardDir, 'state.json.lock')
      expect(existsSync(lockPath)).toBe(true)

      await boardManager.stop()

      expect(existsSync(lockPath)).toBe(false)
    })

    it('can start again after stop()', async () => {
      const { instance } = createMockPKC()
      const mockSub = createMockCommunity({ pageCids: {}, pages: {} })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const lockPath = join(boardDir, 'state.json.lock')

      const boardManager1 = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
      })
      expect(existsSync(lockPath)).toBe(true)
      await boardManager1.stop()
      expect(existsSync(lockPath)).toBe(false)

      // Re-mock PKC for second call since mock is consumed
      const { instance: instance2 } = createMockPKC()
      const mockSub2 = createMockCommunity({ pageCids: {}, pages: {} })
      vi.mocked(instance2.getCommunity).mockResolvedValue(mockSub2 as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager2 = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
      })
      expect(existsSync(lockPath)).toBe(true)
      await boardManager2.stop()
      expect(existsSync(lockPath)).toBe(false)
    })
  })

  describe('deleted comment purging', () => {
    it('purges a deleted top-level thread', async () => {
      const { instance, publishedModerations } = createMockPKC()
      const threads = [
        mockThread('QmNormal', { deleted: false }),
        mockThread('QmDeleted', { deleted: true }),
      ]
      const getPage = vi.fn().mockResolvedValue({
        comments: threads,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 15,
        pages: 10,
      })

      await vi.waitFor(() => {
        const purges = publishedModerations.filter((m) => m.commentModeration.purged === true)
        expect(purges).toHaveLength(1)
      })

      const purges = publishedModerations.filter((m) => m.commentModeration.purged === true)
      expect(purges[0].commentCid).toBe('QmDeleted')
      expect(purges[0].communityAddress).toBe('board.bso')
      expect(purges[0].signer).toBeDefined()
      expect(purges[0].commentModeration).toEqual({ purged: true, reason: '5chan board manager: content purged — author-deleted' })

      // Verify createCommentModeration was called with correct purge args
      expect(instance.createCommentModeration).toHaveBeenCalledWith(
        expect.objectContaining({
          commentCid: 'QmDeleted',
          commentModeration: { purged: true, reason: '5chan board manager: content purged — author-deleted' },
          communityAddress: 'board.bso',
        })
      )
      await boardManager.stop()
    })

    it('purges a deleted reply in preloaded replies.pages', async () => {
      const { instance, publishedModerations } = createMockPKC()
      const threads = [
        mockThread('QmThread1', {
          replies: {
            pages: {
              newFlat: {
                comments: [
                  mockThread('QmReply1', { deleted: false }),
                  mockThread('QmReply2', { deleted: true }),
                ],
                nextCid: undefined,
              },
            },
            pageCids: {},
          },
        }),
      ]
      const getPage = vi.fn().mockResolvedValue({
        comments: threads,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 15,
        pages: 10,
      })

      await vi.waitFor(() => {
        const purges = publishedModerations.filter((m) => m.commentModeration.purged === true)
        expect(purges).toHaveLength(1)
      })

      const purges = publishedModerations.filter((m) => m.commentModeration.purged === true)
      expect(purges[0].commentCid).toBe('QmReply2')
      expect(purges[0].communityAddress).toBe('board.bso')
      expect(purges[0].signer).toBeDefined()
      expect(purges[0].commentModeration).toEqual({ purged: true, reason: '5chan board manager: content purged — author-deleted' })
      await boardManager.stop()
    })

    it('cleans up archivedThreads when deleted thread is purged', async () => {
      const { instance, publishedModerations } = createMockPKC()
      const threads = [
        mockThread('QmArchived', { deleted: true }),
      ]
      const getPage = vi.fn().mockResolvedValue({
        comments: threads,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      // Pre-seed state with thread in archivedThreads (recent timestamp to avoid archive-purge)
      const statePath = join(boardDir, 'state.json')
      saveState(statePath, {
        signers: {},
        archivedThreads: { 'QmArchived': { archivedTimestamp: Math.floor(Date.now() / 1000) } },
      })

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 15,
        pages: 10,
      })

      await vi.waitFor(() => {
        const purges = publishedModerations.filter((m) => m.commentModeration.purged === true)
        expect(purges).toHaveLength(1)
      })

      const loaded = loadState(statePath)
      expect(loaded.archivedThreads['QmArchived']).toBeUndefined()
      await boardManager.stop()
    })

    it('purges deleted pinned threads', async () => {
      const { instance, publishedModerations } = createMockPKC()
      const threads = [
        mockThread('QmPinned', { pinned: true, deleted: true }),
        mockThread('QmNormal', { deleted: false }),
      ]
      const getPage = vi.fn().mockResolvedValue({
        comments: threads,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 15,
        pages: 10,
      })

      await vi.waitFor(() => {
        const purges = publishedModerations.filter((m) => m.commentModeration.purged === true)
        expect(purges).toHaveLength(1)
      })

      const purges = publishedModerations.filter((m) => m.commentModeration.purged === true)
      expect(purges[0].commentCid).toBe('QmPinned')
      await boardManager.stop()
    })

  })

  describe('moderation reasons', () => {
    it('uses default moderation reasons when not configured', async () => {
      const { instance, publishedModerations } = createMockPKC()
      const threads = Array.from({ length: 5 }, (_, i) => mockThread(`QmR${i}`))
      const getPage = vi.fn().mockResolvedValue({
        comments: threads,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 2,
        pages: 1, // capacity = 2, so 3 archived
      })

      await vi.waitFor(() => {
        expect(publishedModerations).toHaveLength(3)
      })

      for (const mod of publishedModerations) {
        expect(mod.commentModeration.reason).toBe('5chan board manager: thread archived — exceeded board capacity')
      }
      await boardManager.stop()
    })

    it('uses custom moderation reasons from options (partial override)', async () => {
      const { instance, publishedModerations } = createMockPKC()
      const threads = Array.from({ length: 4 }, (_, i) => mockThread(`QmC${i}`))
      const getPage = vi.fn().mockResolvedValue({
        comments: threads,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 1,
        pages: 1, // capacity = 1, so 3 archived
        moderationReasons: {
          archiveCapacity: 'Custom capacity reason',
        },
      })

      await vi.waitFor(() => {
        expect(publishedModerations).toHaveLength(3)
      })

      for (const mod of publishedModerations) {
        expect(mod.commentModeration.reason).toBe('Custom capacity reason')
      }
      await boardManager.stop()
    })

    it('passes correct reason for bump-limit archive', async () => {
      const { instance, publishedModerations } = createMockPKC()
      const threads = [
        mockThread('QmBump', { replyCount: 300 }),
      ]
      const getPage = vi.fn().mockResolvedValue({
        comments: threads,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 15,
        pages: 10,
        bumpLimit: 300,
      })

      await vi.waitFor(() => {
        expect(publishedModerations).toHaveLength(1)
      })

      expect(publishedModerations[0].commentModeration).toEqual({
        archived: true,
        reason: '5chan board manager: thread archived — reached bump limit',
      })
      await boardManager.stop()
    })

    it('passes purge reason for archived thread purge', async () => {
      const { instance, publishedModerations } = createMockPKC()
      const threads = [mockThread('QmKeep')]
      const getPage = vi.fn().mockResolvedValue({
        comments: threads,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      // Pre-seed state with an old archived thread
      const statePath = join(boardDir, 'state.json')
      saveState(statePath, {
        signers: {},
        archivedThreads: { 'QmOldArchived': { archivedTimestamp: 0 } },
      })

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 15,
        pages: 10,
        archivePurgeSeconds: 1,
      })

      await vi.waitFor(() => {
        const purges = publishedModerations.filter((m) => m.commentModeration.purged === true)
        expect(purges).toHaveLength(1)
      })

      const purges = publishedModerations.filter((m) => m.commentModeration.purged === true)
      expect(purges[0].commentModeration).toEqual({
        purged: true,
        reason: '5chan board manager: thread purged — archive retention expired',
      })
      await boardManager.stop()
    })

    it('passes purge reason for author-deleted comment', async () => {
      const { instance, publishedModerations } = createMockPKC()
      const threads = [
        mockThread('QmDel', { deleted: true }),
      ]
      const getPage = vi.fn().mockResolvedValue({
        comments: threads,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      })
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: 'board.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: boardDir,
        perPage: 15,
        pages: 10,
      })

      await vi.waitFor(() => {
        const purges = publishedModerations.filter((m) => m.commentModeration.purged === true)
        expect(purges).toHaveLength(1)
      })

      const purges = publishedModerations.filter((m) => m.commentModeration.purged === true)
      expect(purges[0].commentModeration).toEqual({
        purged: true,
        reason: '5chan board manager: content purged — author-deleted',
      })
      await boardManager.stop()
    })
  })

  describe('address change', () => {
    it('detects address change and migrates state/lock files', async () => {
      const hashBoardDir = join(dir, 'boards', '12D3KooWHash123')
      mkdirSync(hashBoardDir, { recursive: true })

      const { instance } = createMockPKC()
      const mockSub = createMockCommunity({
        pageCids: {},
        pages: {},
      }, '12D3KooWHash123')
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: '12D3KooWHash123',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: hashBoardDir,
        onAddressChange: (oldAddr: string, newAddr: string) => {
          renameSync(join(dir, 'boards', oldAddr), join(dir, 'boards', newAddr))
        },
      })

      // Verify old state/lock files exist
      expect(existsSync(join(hashBoardDir, 'state.json'))).toBe(true)
      expect(existsSync(join(hashBoardDir, 'state.json.lock'))).toBe(true)

      // Simulate address change
      mockSub.address = 'random.bso'
      mockSub._triggerUpdate()

      // Wait for migration to complete
      await vi.waitFor(() => {
        expect(existsSync(join(dir, 'boards', 'random.bso', 'state.json'))).toBe(true)
      })

      // Old directory should no longer exist (directory was renamed)
      expect(existsSync(join(dir, 'boards', '12D3KooWHash123'))).toBe(false)

      // New lock should exist
      expect(existsSync(join(dir, 'boards', 'random.bso', 'state.json.lock'))).toBe(true)

      // Verify signer was migrated
      const newState = loadState(join(dir, 'boards', 'random.bso', 'state.json'))
      expect(newState.signers['random.bso']).toBeDefined()
      expect(newState.signers['12D3KooWHash123']).toBeUndefined()

      await boardManager.stop()
    })

    it('calls onAddressChange callback with correct args', async () => {
      const hashBoardDir = join(dir, 'boards', '12D3KooWHash456')
      mkdirSync(hashBoardDir, { recursive: true })

      const { instance } = createMockPKC()
      const mockSub = createMockCommunity({
        pageCids: {},
        pages: {},
      }, '12D3KooWHash456')
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const onAddressChange = vi.fn().mockImplementation((oldAddr: string, newAddr: string) => {
        renameSync(join(dir, 'boards', oldAddr), join(dir, 'boards', newAddr))
      })
      const boardManager = await startBoardManager({
        communityAddress: '12D3KooWHash456',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: hashBoardDir,
        onAddressChange,
      })

      // Simulate address change
      mockSub.address = 'named.bso'
      mockSub._triggerUpdate()

      await vi.waitFor(() => {
        expect(onAddressChange).toHaveBeenCalledOnce()
      })

      expect(onAddressChange).toHaveBeenCalledWith('12D3KooWHash456', 'named.bso')

      await boardManager.stop()
    })

    it('subsequent moderation uses new address after migration', async () => {
      const oldBoardDir = join(dir, 'boards', '12D3KooWOld')
      mkdirSync(oldBoardDir, { recursive: true })

      const { instance, publishedModerations } = createMockPKC()
      const threads = Array.from({ length: 5 }, (_, i) => mockThread(`QmAddr${i}`))
      const getPage = vi.fn().mockResolvedValue({
        comments: threads,
        nextCid: undefined,
      } as Page)

      const mockSub = createMockCommunity({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage,
      }, '12D3KooWOld')
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager = await startBoardManager({
        communityAddress: '12D3KooWOld',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: oldBoardDir,
        perPage: 2,
        pages: 1, // capacity 2, so 3 archived
        onAddressChange: (oldAddr: string, newAddr: string) => {
          renameSync(join(dir, 'boards', oldAddr), join(dir, 'boards', newAddr))
        },
      })

      // Wait for initial moderation
      await vi.waitFor(() => {
        expect(publishedModerations).toHaveLength(3)
      })

      // All initial moderations should use old address
      for (const mod of publishedModerations) {
        expect(mod.communityAddress).toBe('12D3KooWOld')
      }

      // Simulate address change
      publishedModerations.length = 0
      mockSub.address = 'new.bso'
      mockSub._triggerUpdate()

      // Wait for new moderations after address change
      // The threads are the same, so archived ones won't be re-archived.
      // But we can verify the state was migrated.
      await vi.waitFor(() => {
        expect(existsSync(join(dir, 'boards', 'new.bso', 'state.json'))).toBe(true)
      })

      await boardManager.stop()
    })

    it('does not migrate when address is unchanged', async () => {
      const stableBoardDir = join(dir, 'boards', 'stable.bso')
      mkdirSync(stableBoardDir, { recursive: true })

      const { instance } = createMockPKC()
      const mockSub = createMockCommunity({
        pageCids: {},
        pages: {},
      }, 'stable.bso')
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const onAddressChange = vi.fn()
      const boardManager = await startBoardManager({
        communityAddress: 'stable.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: stableBoardDir,
        onAddressChange,
      })

      // Trigger update without changing address
      mockSub._triggerUpdate()
      await new Promise((r) => setTimeout(r, 100))

      expect(onAddressChange).not.toHaveBeenCalled()

      await boardManager.stop()
    })

    it('gracefully handles lock conflict on new address', async () => {
      const conflictBoardDir = join(dir, 'boards', '12D3KooWConflict')
      mkdirSync(conflictBoardDir, { recursive: true })

      const { instance } = createMockPKC()
      const mockSub = createMockCommunity({
        pageCids: {},
        pages: {},
      }, '12D3KooWConflict')
      vi.mocked(instance.getCommunity).mockResolvedValue(mockSub as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const onAddressChange = vi.fn().mockImplementation((oldAddr: string, newAddr: string) => {
        renameSync(join(dir, 'boards', oldAddr), join(dir, 'boards', newAddr))
        // Create a conflicting lock file with current PID at the new location
        writeFileSync(join(dir, 'boards', newAddr, 'state.json.lock'), String(process.pid))
      })
      const boardManager = await startBoardManager({
        communityAddress: '12D3KooWConflict',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: conflictBoardDir,
        onAddressChange,
      })

      // Simulate address change to conflicting address
      mockSub.address = 'conflict.bso'
      mockSub._triggerUpdate()
      await new Promise((r) => setTimeout(r, 100))

      // onAddressChange was called (rename happened), but lock acquisition failed
      // so rollback calls onAddressChange again to rename back
      expect(onAddressChange).toHaveBeenCalledTimes(2)

      // Original state/lock should still exist (rollback renamed dir back)
      expect(existsSync(join(dir, 'boards', '12D3KooWConflict', 'state.json'))).toBe(true)
      expect(existsSync(join(dir, 'boards', '12D3KooWConflict', 'state.json.lock'))).toBe(true)

      await boardManager.stop()
    })
  })

  describe('per-community state isolation', () => {
    it('two board managers for different communities use separate state files', async () => {
      const board1Dir = join(dir, 'boards', 'board1.bso')
      const board2Dir = join(dir, 'boards', 'board2.bso')
      mkdirSync(board1Dir, { recursive: true })
      mkdirSync(board2Dir, { recursive: true })

      // First board manager for board1.bso
      const { instance: instance1 } = createMockPKC()
      const mockSub1 = createMockCommunity({
        pageCids: { active: 'QmPage1' },
        pages: {},
        getPage: vi.fn().mockResolvedValue({
          comments: [mockThread('QmBoard1Thread')],
          nextCid: undefined,
        } as Page),
      }, 'board1.bso')
      vi.mocked(instance1.getCommunity).mockResolvedValue(mockSub1 as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager1 = await startBoardManager({
        communityAddress: 'board1.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: board1Dir,
        perPage: 15,
        pages: 10,
      })

      // Second board manager for board2.bso
      const { instance: instance2 } = createMockPKC()
      const mockSub2 = createMockCommunity({
        pageCids: { active: 'QmPage2' },
        pages: {},
        getPage: vi.fn().mockResolvedValue({
          comments: [mockThread('QmBoard2Thread')],
          nextCid: undefined,
        } as Page),
      }, 'board2.bso')
      vi.mocked(instance2.getCommunity).mockResolvedValue(mockSub2 as unknown as Awaited<ReturnType<PKCInstance['getCommunity']>>)

      const boardManager2 = await startBoardManager({
        communityAddress: 'board2.bso',
        pkcRpcUrl: 'ws://localhost:9138',
        boardDir: board2Dir,
        perPage: 15,
        pages: 10,
      })

      // Wait for both board managers to process
      await vi.waitFor(() => {
        expect(existsSync(join(board1Dir, 'state.json'))).toBe(true)
        expect(existsSync(join(board2Dir, 'state.json'))).toBe(true)
      })

      // Verify each state file has its own signer and they don't clobber each other
      const state1 = loadState(join(board1Dir, 'state.json'))
      const state2 = loadState(join(board2Dir, 'state.json'))

      expect(state1.signers['board1.bso']).toBeDefined()
      expect(state2.signers['board2.bso']).toBeDefined()

      // Each file only has its own community's signer
      expect(state1.signers['board2.bso']).toBeUndefined()
      expect(state2.signers['board1.bso']).toBeUndefined()

      await boardManager1.stop()
      await boardManager2.stop()
    })
  })
})
