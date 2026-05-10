import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from '@pkcprotocol/proper-lock-file'
import type { BoardManagerState, FileLock } from './types.js'

const DEFAULT_STATE: BoardManagerState = {
  signers: {},
  archivedThreads: {},
}

export function loadState(path: string): BoardManagerState {
  try {
    const data = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(data) as Partial<BoardManagerState>
    return {
      signers: parsed.signers ?? {},
      archivedThreads: parsed.archivedThreads ?? {},
    }
  } catch {
    return structuredClone(DEFAULT_STATE)
  }
}

export function saveState(path: string, state: BoardManagerState): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = path + '.tmp'
  try {
    writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n')
    renameSync(tmpPath, path)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }
}

export async function acquireLock(statePath: string): Promise<FileLock> {
  const lockPath = statePath + '.lock'
  mkdirSync(dirname(lockPath), { recursive: true })

  // Migrate legacy file-format locks left over from the prior PID-based scheme.
  // proper-lockfile uses an mkdir-based directory at the lockfile path; if a
  // regular file is sitting there it would EEXIST. The legacy lock can't be
  // honoured anyway — its owner check (pid+hostname) self-collided after Docker
  // restart, which is the bug we're replacing.
  try {
    if (statSync(lockPath).isFile()) unlinkSync(lockPath)
  } catch { /* not present — fine */ }

  const release = await lockfile.lock(statePath, {
    lockfilePath: lockPath,
    realpath: false,             // statePath may not yet exist on first run
    stale: 30_000,               // 30s — well above the 10s update interval
    update: 10_000,              // refresh mtime every 10s as liveness signal
    retries: { retries: 0 },     // fail fast — caller decides whether to retry
  })

  return {
    lockPath,
    release: async () => {
      try { await release() } catch { /* already released or compromised — ignore */ }
    },
  }
}
