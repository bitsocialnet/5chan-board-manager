import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import PKC from '@pkcprotocol/pkc-js'
import { loadState } from '../src/state.js'
import type { PKCInstance, Community, BoardManagerState, Page, ThreadComment } from '../src/types.js'

export const RPC_URL = process.env.PKC_RPC_WS_URL ?? 'ws://localhost:9138'

export async function createPkcRpc(): Promise<PKCInstance> {
  return PKC({ pkcRpcClientsOptions: [RPC_URL] })
}

export async function createTestCommunity(pkc: PKCInstance): Promise<{ sub: Community; address: string }> {
  const sub = await pkc.createCommunity()
  await sub.edit({ settings: { challenges: [] } })
  await sub.start()
  // Wait for the sub to emit its first update (it's running)
  await new Promise<void>((resolve) => {
    sub.on('update', function handler() {
      sub.removeListener('update', handler)
      resolve()
    })
  })
  return { sub, address: sub.address }
}

export async function publishThread(
  pkc: PKCInstance,
  communityAddress: string,
  title: string,
): Promise<{ cid: string; signer: Awaited<ReturnType<PKCInstance['createSigner']>> }> {
  const signer = await pkc.createSigner()
  const comment = await pkc.createComment({
    communityAddress,
    title,
    content: `Content for ${title}`,
    signer,
  })

  const cid = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`publishThread timed out for "${title}"`)), 120_000)
    comment.on('challengeverification', (msg: { challengeSuccess: boolean }) => {
      clearTimeout(timeout)
      if (msg.challengeSuccess) {
        resolve(comment.cid as string)
      } else {
        reject(new Error(`Challenge failed for thread "${title}"`))
      }
    })
    comment.on('challenge', () => {
      comment.publishChallengeAnswers([])
    })
    comment.publish()
  })

  return { cid, signer }
}

export async function publishReply(
  pkc: PKCInstance,
  communityAddress: string,
  parentCid: string,
  postCid?: string,
): Promise<string> {
  const signer = await pkc.createSigner()
  const comment = await pkc.createComment({
    communityAddress,
    parentCid,
    postCid: postCid ?? parentCid,
    content: `Reply to ${parentCid} at ${Date.now()}`,
    signer,
  })

  const cid = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`publishReply timed out for parent ${parentCid}`)), 120_000)
    comment.on('challengeverification', (msg: { challengeSuccess: boolean }) => {
      clearTimeout(timeout)
      if (msg.challengeSuccess) {
        resolve(comment.cid as string)
      } else {
        reject(new Error(`Challenge failed for reply to ${parentCid}`))
      }
    })
    comment.on('challenge', () => {
      comment.publishChallengeAnswers([])
    })
    comment.publish()
  })

  return cid
}

/** Collect all threads from a community's pages (active sort preferred, fallback to any preloaded) */
async function getAllThreads(sub: Community): Promise<ThreadComment[]> {
  const threads: ThreadComment[] = []

  if (sub.posts.pageCids.active) {
    let page: Page = await sub.posts.getPage({ cid: sub.posts.pageCids.active })
    threads.push(...page.comments)
    while (page.nextCid) {
      page = await sub.posts.getPage({ cid: page.nextCid })
      threads.push(...page.comments)
    }
  } else {
    const preloaded = Object.values(sub.posts.pages)[0]
    if (preloaded?.comments) {
      threads.push(...preloaded.comments)
      let nextCid = preloaded.nextCid
      while (nextCid) {
        const page: Page = await sub.posts.getPage({ cid: nextCid })
        threads.push(...page.comments)
        nextCid = page.nextCid
      }
    }
  }

  return threads
}

/** Wait until a thread CID appears in the community's pages */
export async function waitForThreadInPages(sub: Community, threadCid: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()

  // Check current state first
  const threads = await getAllThreads(sub)
  if (threads.some((t) => t.cid === threadCid)) return

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      sub.removeListener('update', check)
      reject(new Error(`waitForThreadInPages timed out for ${threadCid}`))
    }, timeoutMs - (Date.now() - start))

    async function check() {
      const threads = await getAllThreads(sub)
      if (threads.some((t) => t.cid === threadCid)) {
        clearTimeout(timeout)
        sub.removeListener('update', check)
        resolve()
      }
    }

    sub.on('update', check)
  })
}

/** Wait until a thread CID shows archived=true in the community's pages */
export async function waitForThreadArchived(sub: Community, threadCid: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()

  const threads = await getAllThreads(sub)
  const thread = threads.find((t) => t.cid === threadCid)
  if (thread?.archived) return

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      sub.removeListener('update', check)
      reject(new Error(`waitForThreadArchived timed out for ${threadCid}`))
    }, timeoutMs - (Date.now() - start))

    async function check() {
      const threads = await getAllThreads(sub)
      const thread = threads.find((t) => t.cid === threadCid)
      if (thread?.archived) {
        clearTimeout(timeout)
        sub.removeListener('update', check)
        resolve()
      }
    }

    sub.on('update', check)
  })
}

/** Wait until a thread CID shows pinned=true in the community's pages */
export async function waitForThreadPinned(sub: Community, threadCid: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()

  const threads = await getAllThreads(sub)
  const thread = threads.find((t) => t.cid === threadCid)
  if (thread?.pinned) return

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      sub.removeListener('update', check)
      reject(new Error(`waitForThreadPinned timed out for ${threadCid}`))
    }, timeoutMs - (Date.now() - start))

    async function check() {
      const threads = await getAllThreads(sub)
      const thread = threads.find((t) => t.cid === threadCid)
      if (thread?.pinned) {
        clearTimeout(timeout)
        sub.removeListener('update', check)
        resolve()
      }
    }

    sub.on('update', check)
  })
}

/** Wait for a thread's replyCount to reach a target value in the community's pages */
export async function waitForReplyCount(
  sub: Community,
  threadCid: string,
  targetCount: number,
  timeoutMs = 120_000,
): Promise<void> {
  const start = Date.now()

  const threads = await getAllThreads(sub)
  const thread = threads.find((t) => t.cid === threadCid)
  if (thread && (thread.replyCount ?? 0) >= targetCount) return

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      sub.removeListener('update', check)
      reject(new Error(`waitForReplyCount timed out for ${threadCid} (target: ${targetCount})`))
    }, timeoutMs - (Date.now() - start))

    async function check() {
      const threads = await getAllThreads(sub)
      const thread = threads.find((t) => t.cid === threadCid)
      if (thread && (thread.replyCount ?? 0) >= targetCount) {
        clearTimeout(timeout)
        sub.removeListener('update', check)
        resolve()
      }
    }

    sub.on('update', check)
  })
}

/** Wait until a CID appears in archivedThreads in the state JSON file */
export async function waitForArchivedInState(statePath: string, cid: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()
  return new Promise<void>((resolve, reject) => {
    const interval = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval)
        reject(new Error(`waitForArchivedInState timed out for ${cid}`))
        return
      }
      const state = readStateFile(statePath)
      if (state.archivedThreads[cid]) {
        clearInterval(interval)
        resolve()
      }
    }, 1000)
  })
}

/** Wait until a CID is removed from archivedThreads in the state JSON file (purged) */
export async function waitForPurgedFromState(statePath: string, cid: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()
  return new Promise<void>((resolve, reject) => {
    const interval = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval)
        reject(new Error(`waitForPurgedFromState timed out for ${cid}`))
        return
      }
      const state = readStateFile(statePath)
      if (!state.archivedThreads[cid]) {
        clearInterval(interval)
        resolve()
      }
    }, 1000)
  })
}

/** Wait until the board manager signer appears in the state file for a given community address */
export async function waitForSignerInState(statePath: string, subAddress: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()
  return new Promise<void>((resolve, reject) => {
    const interval = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval)
        reject(new Error(`waitForSignerInState timed out for ${subAddress}`))
        return
      }
      const state = readStateFile(statePath)
      if (state.signers[subAddress]) {
        clearInterval(interval)
        resolve()
      }
    }, 1000)
  })
}

export function createTempStateDir(): { dir: string; statePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'board-manager-e2e-'))
  const statePath = join(dir, 'state.json')
  return { dir, statePath }
}

export function cleanupTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

export function readStateFile(statePath: string): BoardManagerState {
  return loadState(statePath)
}

/** Load all threads from community pages and return them */
export { getAllThreads }
