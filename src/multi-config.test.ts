import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMultiConfig, resolveBoardManagerOptions } from './multi-config.js'
import type { BoardConfig, MultiBoardConfig } from './types.js'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'multi-config-test-'))
}

function writeGlobalConfig(dir: string, config: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'global.json'), JSON.stringify(config))
}

function writeBoardConfig(dir: string, board: unknown): void {
  const b = board as { address: string }
  const boardDir = join(dir, 'boards', b.address)
  mkdirSync(boardDir, { recursive: true })
  writeFileSync(join(boardDir, 'config.json'), JSON.stringify(board))
}

describe('loadMultiConfig', () => {
  const dirs: string[] = []

  function tmpDir(): string {
    const d = makeTmpDir()
    dirs.push(d)
    return d
  }

  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('loads a minimal valid config', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'board.bso' })
    const config = loadMultiConfig(dir)
    expect(config.boards).toHaveLength(1)
    expect(config.boards[0].address).toBe('board.bso')
    expect(config.rpcUrl).toBeUndefined()
    expect(config.defaults).toBeUndefined()
  })

  it('loads a full config with all fields', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, {
      rpcUrl: 'ws://custom:9138',
      defaults: { perPage: 20, pages: 5, bumpLimit: 400, archivePurgeSeconds: 86400 },
    })
    writeBoardConfig(dir, { address: 'a.bso' })
    writeBoardConfig(dir, { address: 'b.bso', bumpLimit: 600 })

    const config = loadMultiConfig(dir)
    expect(config.rpcUrl).toBe('ws://custom:9138')
    expect(config.defaults?.perPage).toBe(20)
    expect(config.boards).toHaveLength(2)
    expect(config.boards.find((b) => b.address === 'b.bso')?.bumpLimit).toBe(600)
  })

  it('throws when no board files exist', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, { rpcUrl: 'ws://x' })
    expect(() => loadMultiConfig(dir)).toThrow('no board config files found')
  })

  it('throws when boards/ directory is empty', () => {
    const dir = tmpDir()
    mkdirSync(join(dir, 'boards'), { recursive: true })
    expect(() => loadMultiConfig(dir)).toThrow('no board config files found')
  })

  it('throws when a board has no address', () => {
    const dir = tmpDir()
    const boardDir = join(dir, 'boards', 'noaddress')
    mkdirSync(boardDir, { recursive: true })
    writeFileSync(join(boardDir, 'config.json'), JSON.stringify({ perPage: 10 }))
    expect(() => loadMultiConfig(dir)).toThrow('address must be a non-empty string')
  })

  it('throws when a board has empty address', () => {
    const dir = tmpDir()
    const boardDir = join(dir, 'boards', 'some-dir')
    mkdirSync(boardDir, { recursive: true })
    writeFileSync(join(boardDir, 'config.json'), JSON.stringify({ address: '  ' }))
    expect(() => loadMultiConfig(dir)).toThrow('address must be a non-empty string')
  })

  it('throws when a numeric field is not a positive integer', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', perPage: -1 })
    expect(() => loadMultiConfig(dir)).toThrow('perPage must be a positive integer')
  })

  it('throws when a numeric field is a float', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', pages: 1.5 })
    expect(() => loadMultiConfig(dir)).toThrow('pages must be a positive integer')
  })

  it('throws when a numeric field is zero', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', bumpLimit: 0 })
    expect(() => loadMultiConfig(dir)).toThrow('bumpLimit must be a positive integer')
  })

  it('throws when a numeric field is a string', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', archivePurgeSeconds: '100' })
    expect(() => loadMultiConfig(dir)).toThrow('archivePurgeSeconds must be a positive integer')
  })

  it('throws when defaults has invalid numeric field', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, { defaults: { perPage: -5 } })
    writeBoardConfig(dir, { address: 'x.bso' })
    expect(() => loadMultiConfig(dir)).toThrow('perPage must be a positive integer')
  })

  it('throws when rpcUrl is not a string', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, { rpcUrl: 123 })
    writeBoardConfig(dir, { address: 'x.bso' })
    expect(() => loadMultiConfig(dir)).toThrow('"rpcUrl" must be a string')
  })

  it('throws when defaults is not an object', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, { defaults: 'bad' })
    writeBoardConfig(dir, { address: 'x.bso' })
    expect(() => loadMultiConfig(dir)).toThrow('"defaults" must be an object')
  })

  it('loads config with moderationReasons in defaults', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, { defaults: { moderationReasons: { archiveCapacity: 'custom' } } })
    writeBoardConfig(dir, { address: 'x.bso' })
    const config = loadMultiConfig(dir)
    expect(config.defaults?.moderationReasons?.archiveCapacity).toBe('custom')
  })

  it('loads config with moderationReasons on a board', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', moderationReasons: { purgeDeleted: 'board reason' } })
    const config = loadMultiConfig(dir)
    expect(config.boards[0].moderationReasons?.purgeDeleted).toBe('board reason')
  })

  it('rejects non-object moderationReasons', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', moderationReasons: 'bad' })
    expect(() => loadMultiConfig(dir)).toThrow('moderationReasons must be an object')
  })

  it('rejects unknown keys in moderationReasons', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', moderationReasons: { unknownKey: 'val' } })
    expect(() => loadMultiConfig(dir)).toThrow('moderationReasons has unknown key "unknownKey"')
  })

  it('rejects non-string values in moderationReasons', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', moderationReasons: { archiveCapacity: 123 } })
    expect(() => loadMultiConfig(dir)).toThrow('moderationReasons.archiveCapacity must be a string')
  })
})

describe('resolveBoardManagerOptions', () => {
  const envBackup = process.env.PKC_RPC_WS_URL

  afterEach(() => {
    if (envBackup === undefined) {
      delete process.env.PKC_RPC_WS_URL
    } else {
      process.env.PKC_RPC_WS_URL = envBackup
    }
  })

  it('uses config rpcUrl over env var and default', () => {
    process.env.PKC_RPC_WS_URL = 'ws://env:9138'
    const board: BoardConfig = { address: 'a.bso' }
    const config: MultiBoardConfig = {
      rpcUrl: 'ws://config:9138',
      boards: [board],
    }
    const opts = resolveBoardManagerOptions(board, config, '/test/config')
    expect(opts.pkcRpcUrl).toBe('ws://config:9138')
  })

  it('falls back to env var when rpcUrl not in config', () => {
    process.env.PKC_RPC_WS_URL = 'ws://env:9138'
    const board: BoardConfig = { address: 'a.bso' }
    const config: MultiBoardConfig = { boards: [board] }
    const opts = resolveBoardManagerOptions(board, config, '/test/config')
    expect(opts.pkcRpcUrl).toBe('ws://env:9138')
  })

  it('falls back to default when neither config nor env var set', () => {
    delete process.env.PKC_RPC_WS_URL
    const board: BoardConfig = { address: 'a.bso' }
    const config: MultiBoardConfig = { boards: [board] }
    const opts = resolveBoardManagerOptions(board, config, '/test/config')
    expect(opts.pkcRpcUrl).toBe('ws://localhost:9138')
  })

  it('per-board values override defaults', () => {
    const board: BoardConfig = { address: 'a.bso', bumpLimit: 500, perPage: 30 }
    const config: MultiBoardConfig = {
      defaults: { bumpLimit: 300, perPage: 15, pages: 5 },
      boards: [board],
    }
    const opts = resolveBoardManagerOptions(board, config, '/test/config')
    expect(opts.bumpLimit).toBe(500)
    expect(opts.perPage).toBe(30)
    expect(opts.pages).toBe(5)
  })

  it('leaves unset fields as undefined so startArchiver uses its own defaults', () => {
    const board: BoardConfig = { address: 'a.bso' }
    const config: MultiBoardConfig = { boards: [board] }
    const opts = resolveBoardManagerOptions(board, config, '/test/config')
    expect(opts.perPage).toBeUndefined()
    expect(opts.pages).toBeUndefined()
    expect(opts.bumpLimit).toBeUndefined()
    expect(opts.archivePurgeSeconds).toBeUndefined()
    expect(opts.boardDir).toBe(join('/test/config', 'boards', 'a.bso'))
  })

  it('computes boardDir from configDir and board address', () => {
    const board: BoardConfig = { address: 'a.bso' }
    const config: MultiBoardConfig = { boards: [board] }
    const opts = resolveBoardManagerOptions(board, config, '/test/config')
    expect(opts.boardDir).toBe(join('/test/config', 'boards', 'a.bso'))
  })

  it('sets communityAddress from board address', () => {
    const board: BoardConfig = { address: 'my-board.bso' }
    const config: MultiBoardConfig = { boards: [board] }
    const opts = resolveBoardManagerOptions(board, config, '/test/config')
    expect(opts.communityAddress).toBe('my-board.bso')
  })

  it('merges moderationReasons per-field: board overrides default', () => {
    const board: BoardConfig = {
      address: 'a.bso',
      moderationReasons: { archiveCapacity: 'board override' },
    }
    const config: MultiBoardConfig = {
      defaults: {
        moderationReasons: {
          archiveCapacity: 'default capacity',
          archiveBumpLimit: 'default bump',
        },
      },
      boards: [board],
    }
    const opts = resolveBoardManagerOptions(board, config, '/test/config')
    expect(opts.moderationReasons?.archiveCapacity).toBe('board override')
    expect(opts.moderationReasons?.archiveBumpLimit).toBe('default bump')
  })

  it('returns undefined moderationReasons when neither board nor defaults set it', () => {
    const board: BoardConfig = { address: 'a.bso' }
    const config: MultiBoardConfig = { boards: [board] }
    const opts = resolveBoardManagerOptions(board, config, '/test/config')
    expect(opts.moderationReasons).toBeUndefined()
  })

  it('passes userAgent from config', () => {
    const board: BoardConfig = { address: 'a.bso' }
    const config: MultiBoardConfig = {
      userAgent: 'custom-agent:2.0',
      boards: [board],
    }
    const opts = resolveBoardManagerOptions(board, config, '/test/config')
    expect(opts.userAgent).toBe('custom-agent:2.0')
  })

  it('leaves userAgent undefined when not set in config', () => {
    const board: BoardConfig = { address: 'a.bso' }
    const config: MultiBoardConfig = { boards: [board] }
    const opts = resolveBoardManagerOptions(board, config, '/test/config')
    expect(opts.userAgent).toBeUndefined()
  })
})
