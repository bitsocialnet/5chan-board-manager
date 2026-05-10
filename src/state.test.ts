import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { loadState, saveState, acquireLock } from './state.js'
import type { BoardManagerState } from './types.js'

describe('state', () => {
  let dir: string
  let statePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-manager-test-'))
    statePath = join(dir, 'state.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('loadState', () => {
    it('returns default state when file does not exist', () => {
      const state = loadState(statePath)
      expect(state).toEqual({ signers: {}, archivedThreads: {} })
    })

    it('loads existing state from file', () => {
      const existing: BoardManagerState = {
        signers: { 'sub1.bso': { privateKey: 'pk123' } },
        archivedThreads: { 'Qm123': { archivedTimestamp: 1000 } },
      }
      saveState(statePath, existing)
      const loaded = loadState(statePath)
      expect(loaded).toEqual(existing)
    })

    it('returns default state when file contains invalid JSON', async () => {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(statePath, 'not json')
      const state = loadState(statePath)
      expect(state).toEqual({ signers: {}, archivedThreads: {} })
    })
  })

  describe('saveState', () => {
    it('writes state as JSON', () => {
      const state: BoardManagerState = {
        signers: { 'board.bso': { privateKey: 'abc' } },
        archivedThreads: {},
      }
      saveState(statePath, state)
      const raw = readFileSync(statePath, 'utf-8')
      expect(JSON.parse(raw)).toEqual(state)
    })

    it('overwrites previous state', () => {
      const state1: BoardManagerState = {
        signers: {},
        archivedThreads: { 'Qm1': { archivedTimestamp: 100 } },
      }
      saveState(statePath, state1)

      const state2: BoardManagerState = {
        signers: {},
        archivedThreads: { 'Qm2': { archivedTimestamp: 200 } },
      }
      saveState(statePath, state2)

      const loaded = loadState(statePath)
      expect(loaded).toEqual(state2)
      expect(loaded.archivedThreads['Qm1']).toBeUndefined()
    })

    it('preserves both signers and archivedThreads', () => {
      const state: BoardManagerState = {
        signers: {
          'sub1.bso': { privateKey: 'key1' },
          'sub2.bso': { privateKey: 'key2' },
        },
        archivedThreads: {
          'QmA': { archivedTimestamp: 1000 },
          'QmB': { archivedTimestamp: 2000 },
        },
      }
      saveState(statePath, state)
      const loaded = loadState(statePath)
      expect(loaded.signers).toEqual(state.signers)
      expect(loaded.archivedThreads).toEqual(state.archivedThreads)
    })

    it('auto-creates missing parent directories', () => {
      const nestedPath = join(dir, 'a', 'b', 'c', 'state.json')
      const state: BoardManagerState = { signers: {}, archivedThreads: {} }
      saveState(nestedPath, state)

      expect(existsSync(nestedPath)).toBe(true)
      const loaded = loadState(nestedPath)
      expect(loaded).toEqual(state)
    })
  })

  describe('saveState atomic write', () => {
    it('does not leave a .tmp file after successful write', () => {
      const state: BoardManagerState = { signers: {}, archivedThreads: {} }
      saveState(statePath, state)
      expect(existsSync(statePath + '.tmp')).toBe(false)
      expect(existsSync(statePath)).toBe(true)
    })

    it('preserves original state when a leftover .tmp file exists', () => {
      const state: BoardManagerState = {
        signers: { 'x.bso': { privateKey: 'original' } },
        archivedThreads: {},
      }
      saveState(statePath, state)

      // Simulate a leftover .tmp from a crashed write
      writeFileSync(statePath + '.tmp', 'garbage')

      const loaded = loadState(statePath)
      expect(loaded.signers['x.bso'].privateKey).toBe('original')
    })

    it('overwrites leftover .tmp on next successful save', () => {
      writeFileSync(statePath + '.tmp', 'garbage')

      const state: BoardManagerState = { signers: {}, archivedThreads: {} }
      saveState(statePath, state)

      expect(existsSync(statePath + '.tmp')).toBe(false)
      expect(loadState(statePath)).toEqual(state)
    })
  })

  describe('acquireLock', () => {
    it('creates a lockfile at <state>.lock', async () => {
      const lock = await acquireLock(statePath)
      expect(existsSync(statePath + '.lock')).toBe(true)
      await lock.release()
    })

    it('throws when another holder in the same process is active', async () => {
      const lock = await acquireLock(statePath)
      await expect(acquireLock(statePath)).rejects.toThrow(/lock/i)
      await lock.release()
    })

    it('migrates a legacy old-format lock file (PID only, no hostname)', async () => {
      // Pre-rewrite daemons (and a brief intermediate version) wrote the lock as
      // a regular file containing just the PID. proper-lockfile's mkdir-based
      // strategy would fail with EEXIST against such a file, so acquireLock
      // detects the legacy format and removes it before locking.
      writeFileSync(statePath + '.lock', '999999')
      const lock = await acquireLock(statePath)
      expect(existsSync(statePath + '.lock')).toBe(true)
      await lock.release()
    })

    it('migrates a legacy pid+hostname-format lock file (regression for docker-restart bug)', async () => {
      // Reproduces the prod restart loop: container hostname is preserved across
      // restarts, and the node entrypoint deterministically lands at the same
      // PID, so the previous lock contents (`<own-pid>\n<own-hostname>`) used to
      // self-collide and wedge the daemon. The legacy migration path must drop
      // the file regardless of what's inside it.
      writeFileSync(statePath + '.lock', `${process.pid}\n${hostname()}`)
      const lock = await acquireLock(statePath)
      expect(existsSync(statePath + '.lock')).toBe(true)
      await lock.release()
    })

    it('treats a lock with stale mtime as released', async () => {
      // Simulate a daemon that acquired the lock and then crashed without
      // releasing. proper-lockfile considers any lock whose mtime is older than
      // the configured `stale` window (30s) to be abandoned.
      const lockPath = statePath + '.lock'
      mkdirSync(lockPath)
      const past = Date.now() / 1000 - 120 // 2 minutes ago
      utimesSync(lockPath, past, past)

      const lock = await acquireLock(statePath)
      expect(existsSync(lockPath)).toBe(true)
      await lock.release()
    })

    it('release() removes the lockfile', async () => {
      const lock = await acquireLock(statePath)
      expect(existsSync(statePath + '.lock')).toBe(true)
      await lock.release()
      expect(existsSync(statePath + '.lock')).toBe(false)
    })

    it('can re-acquire after release', async () => {
      const lock1 = await acquireLock(statePath)
      await lock1.release()
      const lock2 = await acquireLock(statePath)
      expect(existsSync(statePath + '.lock')).toBe(true)
      await lock2.release()
    })

    it('auto-creates parent directories', async () => {
      const nestedPath = join(dir, 'a', 'b', 'c', 'state.json')
      const lock = await acquireLock(nestedPath)
      expect(existsSync(nestedPath + '.lock')).toBe(true)
      await lock.release()
    })
  })

})
