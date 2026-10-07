import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadConfig, loadGlobalConfig, loadBoardConfig, saveGlobalConfig,
  saveBoardConfig, deleteBoardConfig, updateBoardConfig, diffBoards,
  globalConfigPath, boardConfigPath, renameBoardConfig,
} from './config-manager.js'
import type { BoardConfig, GlobalConfig, MultiBoardConfig } from './types.js'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'config-manager-test-'))
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

describe('path helpers', () => {
  it('globalConfigPath returns global.json path', () => {
    expect(globalConfigPath('/foo/bar')).toBe(join('/foo/bar', 'global.json'))
  })

  it('boardConfigPath returns boards/{address}/config.json path', () => {
    expect(boardConfigPath('/foo/bar', 'test.bso')).toBe(join('/foo/bar', 'boards', 'test.bso', 'config.json'))
  })
})

describe('loadConfig', () => {
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

  it('returns default config with empty boards when directory is empty', () => {
    const dir = tmpDir()
    const config = loadConfig(dir)
    expect(config).toEqual({ boards: [] })
  })

  it('returns default config with empty boards when directory does not exist', () => {
    const config = loadConfig('/no/such/path/config-dir')
    expect(config).toEqual({ boards: [] })
  })

  it('loads global.json + single board file', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, { rpcUrl: 'ws://custom:9138' })
    writeBoardConfig(dir, { address: 'board.bso' })

    const config = loadConfig(dir)
    expect(config.rpcUrl).toBe('ws://custom:9138')
    expect(config.boards).toHaveLength(1)
    expect(config.boards[0].address).toBe('board.bso')
  })

  it('loads full config with all fields', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, {
      rpcUrl: 'ws://custom:9138',
      defaults: { perPage: 20, pages: 5, bumpLimit: 400, archivePurgeSeconds: 86400 },
    })
    writeBoardConfig(dir, { address: 'a.bso' })
    writeBoardConfig(dir, { address: 'b.bso', bumpLimit: 600 })

    const config = loadConfig(dir)
    expect(config.rpcUrl).toBe('ws://custom:9138')
    expect(config.defaults?.perPage).toBe(20)
    expect(config.boards).toHaveLength(2)
    expect(config.boards.find((b) => b.address === 'b.bso')?.bumpLimit).toBe(600)
  })

  it('returns empty boards when boards/ directory is missing', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, { rpcUrl: 'ws://x:9138' })
    const config = loadConfig(dir)
    expect(config.boards).toEqual([])
  })

  it('throws on invalid JSON in global.json', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'global.json'), '{ not valid }')
    expect(() => loadConfig(dir)).toThrow('Invalid JSON')
  })

  it('throws when global.json is not an object', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, [1, 2, 3])
    expect(() => loadConfig(dir)).toThrow('must contain a JSON object')
  })

  it('throws on directory name / address mismatch', () => {
    const dir = tmpDir()
    const wrongDir = join(dir, 'boards', 'wrong')
    mkdirSync(wrongDir, { recursive: true })
    writeFileSync(join(wrongDir, 'config.json'), JSON.stringify({ address: 'board.bso' }))
    expect(() => loadConfig(dir)).toThrow('directory name "wrong" does not match address "board.bso"')
  })

  it('throws when a numeric field is not a positive integer', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', perPage: -1 })
    expect(() => loadConfig(dir)).toThrow('perPage must be a positive integer')
  })

  it('throws when rpcUrl is not a string', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, { rpcUrl: 123 })
    expect(() => loadConfig(dir)).toThrow('"rpcUrl" must be a string')
  })

  it('throws when userAgent is not a string', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, { userAgent: 123 })
    expect(() => loadConfig(dir)).toThrow('"userAgent" must be a string')
  })

  it('accepts valid userAgent string', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, { userAgent: 'custom-agent:1.0' })
    writeBoardConfig(dir, { address: 'x.bso' })
    const config = loadConfig(dir)
    expect(config.userAgent).toBe('custom-agent:1.0')
  })

  it('throws when defaults is not an object', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, { defaults: 'bad' })
    expect(() => loadConfig(dir)).toThrow('"defaults" must be an object')
  })

  it('throws when board address is empty string', () => {
    const dir = tmpDir()
    const boardDir = join(dir, 'boards', 'some-dir')
    mkdirSync(boardDir, { recursive: true })
    writeFileSync(join(boardDir, 'config.json'), JSON.stringify({ address: '  ' }))
    expect(() => loadConfig(dir)).toThrow('address must be a non-empty string')
  })

  it('loads config with moderationReasons in defaults', () => {
    const dir = tmpDir()
    writeGlobalConfig(dir, { defaults: { moderationReasons: { archiveCapacity: 'custom' } } })
    writeBoardConfig(dir, { address: 'x.bso' })
    const config = loadConfig(dir)
    expect(config.defaults?.moderationReasons?.archiveCapacity).toBe('custom')
  })

  it('loads the no-archive moderation reasons', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', moderationReasons: { purgeCapacity: 'purge', lockBumpLimit: 'lock' } })
    const config = loadConfig(dir)
    expect(config.boards[0].moderationReasons).toEqual({ purgeCapacity: 'purge', lockBumpLimit: 'lock' })
  })

  it('rejects non-object moderationReasons', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', moderationReasons: 42 })
    expect(() => loadConfig(dir)).toThrow('moderationReasons must be an object')
  })

  it('rejects unknown keys in moderationReasons', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', moderationReasons: { badKey: 'val' } })
    expect(() => loadConfig(dir)).toThrow('moderationReasons has unknown key "badKey"')
  })

  it('rejects non-string values in moderationReasons', () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'x.bso', moderationReasons: { purgeDeleted: true } })
    expect(() => loadConfig(dir)).toThrow('moderationReasons.purgeDeleted must be a string')
  })
})

describe('saveGlobalConfig', () => {
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

  it('writes global config as pretty-printed JSON', () => {
    const dir = tmpDir()
    const config: GlobalConfig = { rpcUrl: 'ws://test:9138' }
    saveGlobalConfig(dir, config)
    const written = readFileSync(join(dir, 'global.json'), 'utf-8')
    expect(JSON.parse(written)).toEqual(config)
    expect(written).toContain('\n')
    expect(written.endsWith('\n')).toBe(true)
  })

  it('creates parent directories', () => {
    const dir = tmpDir()
    const nested = join(dir, 'nested', 'deep')
    saveGlobalConfig(nested, { rpcUrl: 'ws://test:1234' })
    const written = readFileSync(join(nested, 'global.json'), 'utf-8')
    expect(JSON.parse(written)).toEqual({ rpcUrl: 'ws://test:1234' })
  })
})

describe('saveBoardConfig', () => {
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

  it('writes board config to boards/{address}/config.json', () => {
    const dir = tmpDir()
    const board: BoardConfig = { address: 'test.bso', bumpLimit: 500 }
    saveBoardConfig(dir, board)
    const written = readFileSync(join(dir, 'boards', 'test.bso', 'config.json'), 'utf-8')
    expect(JSON.parse(written)).toEqual(board)
    expect(written.endsWith('\n')).toBe(true)
  })

  it('creates boards/ directory if missing', () => {
    const dir = tmpDir()
    saveBoardConfig(dir, { address: 'new.bso' })
    expect(existsSync(join(dir, 'boards', 'new.bso', 'config.json'))).toBe(true)
  })

  it('overwrites existing board config', () => {
    const dir = tmpDir()
    saveBoardConfig(dir, { address: 'a.bso', bumpLimit: 300 })
    saveBoardConfig(dir, { address: 'a.bso', bumpLimit: 500 })
    const written = JSON.parse(readFileSync(join(dir, 'boards', 'a.bso', 'config.json'), 'utf-8'))
    expect(written.bumpLimit).toBe(500)
  })

  it('does not leave a .tmp file after successful write', () => {
    const dir = tmpDir()
    saveBoardConfig(dir, { address: 'a.bso' })
    const filePath = join(dir, 'boards', 'a.bso', 'config.json')
    expect(existsSync(filePath)).toBe(true)
    expect(existsSync(filePath + '.tmp')).toBe(false)
  })
})

describe('deleteBoardConfig', () => {
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

  it('deletes a board directory', () => {
    const dir = tmpDir()
    saveBoardConfig(dir, { address: 'a.bso' })
    expect(existsSync(join(dir, 'boards', 'a.bso'))).toBe(true)

    deleteBoardConfig(dir, 'a.bso')
    expect(existsSync(join(dir, 'boards', 'a.bso'))).toBe(false)
  })

  it('throws when board not found', () => {
    const dir = tmpDir()
    mkdirSync(join(dir, 'boards'), { recursive: true })
    expect(() => deleteBoardConfig(dir, 'missing.bso')).toThrow('Board "missing.bso" not found')
  })
})

describe('updateBoardConfig', () => {
  it('updates a single field on an existing board', () => {
    const board: BoardConfig = { address: 'a.bso', bumpLimit: 300 }
    const result = updateBoardConfig(board, { bumpLimit: 500 })
    expect(result.bumpLimit).toBe(500)
  })

  it('adds a new field to an existing board', () => {
    const board: BoardConfig = { address: 'a.bso' }
    const result = updateBoardConfig(board, { perPage: 25 })
    expect(result.perPage).toBe(25)
  })

  it('updates multiple fields at once', () => {
    const board: BoardConfig = { address: 'a.bso' }
    const result = updateBoardConfig(board, { perPage: 25, pages: 3 })
    expect(result.perPage).toBe(25)
    expect(result.pages).toBe(3)
  })

  it('resets a field to undefined', () => {
    const board: BoardConfig = { address: 'a.bso', bumpLimit: 500 }
    const result = updateBoardConfig(board, {}, ['bumpLimit'])
    expect(Object.hasOwn(result, 'bumpLimit')).toBe(false)
  })

  it('resets multiple fields', () => {
    const board: BoardConfig = { address: 'a.bso', perPage: 25, pages: 3, bumpLimit: 500, archivePurgeSeconds: 86400 }
    const result = updateBoardConfig(board, {}, ['perPage', 'bumpLimit'])
    expect(Object.hasOwn(result, 'perPage')).toBe(false)
    expect(Object.hasOwn(result, 'bumpLimit')).toBe(false)
    expect(result.pages).toBe(3)
    expect(result.archivePurgeSeconds).toBe(86400)
  })

  it('allows setting one field and resetting another simultaneously', () => {
    const board: BoardConfig = { address: 'a.bso', perPage: 25, bumpLimit: 300 }
    const result = updateBoardConfig(board, { perPage: 30 }, ['bumpLimit'])
    expect(result.perPage).toBe(30)
    expect(Object.hasOwn(result, 'bumpLimit')).toBe(false)
  })

  it('throws when setting and resetting the same field', () => {
    const board: BoardConfig = { address: 'a.bso' }
    expect(() => updateBoardConfig(board, { perPage: 25 }, ['perPage'])).toThrow(
      'Cannot set and reset the same field "perPage"',
    )
  })

  it('does not mutate the original board', () => {
    const board: BoardConfig = { address: 'a.bso', bumpLimit: 300 }
    const result = updateBoardConfig(board, { bumpLimit: 500 })
    expect(board.bumpLimit).toBe(300)
    expect(result.bumpLimit).toBe(500)
  })

  it('preserves address field', () => {
    const board: BoardConfig = { address: 'a.bso' }
    const result = updateBoardConfig(board, { bumpLimit: 500 })
    expect(result.address).toBe('a.bso')
  })

  it('updates moderationReasons on a board', () => {
    const board: BoardConfig = { address: 'a.bso' }
    const result = updateBoardConfig(board, { moderationReasons: { archiveCapacity: 'custom' } })
    expect(result.moderationReasons?.archiveCapacity).toBe('custom')
  })

  it('resets moderationReasons on a board', () => {
    const board: BoardConfig = { address: 'a.bso', moderationReasons: { archiveCapacity: 'val' } }
    const result = updateBoardConfig(board, {}, ['moderationReasons'])
    expect(Object.hasOwn(result, 'moderationReasons')).toBe(false)
  })
})

describe('diffBoards', () => {
  it('detects added boards', () => {
    const oldConfig: MultiBoardConfig = { boards: [{ address: 'a.bso' }] }
    const newConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso' }, { address: 'b.bso' }],
    }
    const diff = diffBoards(oldConfig, newConfig)
    expect(diff.added).toHaveLength(1)
    expect(diff.added[0].address).toBe('b.bso')
    expect(diff.removed).toHaveLength(0)
  })

  it('detects removed boards', () => {
    const oldConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso' }, { address: 'b.bso' }],
    }
    const newConfig: MultiBoardConfig = { boards: [{ address: 'a.bso' }] }
    const diff = diffBoards(oldConfig, newConfig)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toEqual(['b.bso'])
  })

  it('detects both added and removed boards', () => {
    const oldConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso' }, { address: 'b.bso' }],
    }
    const newConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso' }, { address: 'c.bso' }],
    }
    const diff = diffBoards(oldConfig, newConfig)
    expect(diff.added).toHaveLength(1)
    expect(diff.added[0].address).toBe('c.bso')
    expect(diff.removed).toEqual(['b.bso'])
  })

  it('returns empty diff when configs are identical', () => {
    const config: MultiBoardConfig = {
      boards: [{ address: 'a.bso' }, { address: 'b.bso' }],
    }
    const diff = diffBoards(config, config)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
  })

  it('handles empty old config', () => {
    const oldConfig: MultiBoardConfig = { boards: [] }
    const newConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso' }],
    }
    const diff = diffBoards(oldConfig, newConfig)
    expect(diff.added).toHaveLength(1)
    expect(diff.removed).toHaveLength(0)
  })

  it('handles empty new config', () => {
    const oldConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso' }],
    }
    const newConfig: MultiBoardConfig = { boards: [] }
    const diff = diffBoards(oldConfig, newConfig)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toEqual(['a.bso'])
  })

  it('preserves board config details in added boards', () => {
    const oldConfig: MultiBoardConfig = { boards: [] }
    const newConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso', bumpLimit: 500, perPage: 30 }],
    }
    const diff = diffBoards(oldConfig, newConfig)
    expect(diff.added[0]).toEqual({ address: 'a.bso', bumpLimit: 500, perPage: 30 })
  })

  it('detects changed boards when a field is modified', () => {
    const oldConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso', bumpLimit: 300 }],
    }
    const newConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso', bumpLimit: 500 }],
    }
    const diff = diffBoards(oldConfig, newConfig)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]).toEqual({ address: 'a.bso', bumpLimit: 500 })
  })

  it('detects changed boards when a no-archive moderation reason changes', () => {
    const oldConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso', moderationReasons: { lockBumpLimit: 'old lock' } }],
    }
    const newConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso', moderationReasons: { lockBumpLimit: 'new lock' } }],
    }
    expect(diffBoards(oldConfig, newConfig).changed).toHaveLength(1)
  })

  it('detects changed boards when a field is added', () => {
    const oldConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso' }],
    }
    const newConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso', perPage: 25 }],
    }
    const diff = diffBoards(oldConfig, newConfig)
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0].perPage).toBe(25)
  })

  it('detects changed boards when a field is removed', () => {
    const oldConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso', bumpLimit: 300 }],
    }
    const newConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso' }],
    }
    const diff = diffBoards(oldConfig, newConfig)
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]).toEqual({ address: 'a.bso' })
  })

  it('returns empty changed when board configs are identical', () => {
    const config: MultiBoardConfig = {
      boards: [{ address: 'a.bso', bumpLimit: 300 }],
    }
    const diff = diffBoards(config, { ...config, boards: [{ address: 'a.bso', bumpLimit: 300 }] })
    expect(diff.changed).toHaveLength(0)
  })

  it('separates added, removed, and changed correctly', () => {
    const oldConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso', perPage: 10 }, { address: 'b.bso' }],
    }
    const newConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso', perPage: 20 }, { address: 'c.bso' }],
    }
    const diff = diffBoards(oldConfig, newConfig)
    expect(diff.added).toHaveLength(1)
    expect(diff.added[0].address).toBe('c.bso')
    expect(diff.removed).toEqual(['b.bso'])
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]).toEqual({ address: 'a.bso', perPage: 20 })
  })

  it('detects moderationReasons changes', () => {
    const oldConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso', moderationReasons: { archiveCapacity: 'old' } }],
    }
    const newConfig: MultiBoardConfig = {
      boards: [{ address: 'a.bso', moderationReasons: { archiveCapacity: 'new' } }],
    }
    const diff = diffBoards(oldConfig, newConfig)
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0].moderationReasons?.archiveCapacity).toBe('new')
  })

  it('no change when moderationReasons are identical', () => {
    const reasons = { archiveCapacity: 'same' }
    const config: MultiBoardConfig = {
      boards: [{ address: 'a.bso', moderationReasons: reasons }],
    }
    const diff = diffBoards(config, { ...config, boards: [{ address: 'a.bso', moderationReasons: { ...reasons } }] })
    expect(diff.changed).toHaveLength(0)
  })
})

describe('renameBoardConfig', () => {
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

  it('renames config file and updates address field', () => {
    const dir = tmpDir()
    saveBoardConfig(dir, { address: 'old.bso', bumpLimit: 500, perPage: 20 })
    expect(existsSync(boardConfigPath(dir, 'old.bso'))).toBe(true)

    renameBoardConfig(dir, 'old.bso', 'new.bso')

    expect(existsSync(boardConfigPath(dir, 'old.bso'))).toBe(false)
    expect(existsSync(boardConfigPath(dir, 'new.bso'))).toBe(true)

    const newConfig = loadBoardConfig(boardConfigPath(dir, 'new.bso'))
    expect(newConfig.address).toBe('new.bso')
    expect(newConfig.bumpLimit).toBe(500)
    expect(newConfig.perPage).toBe(20)
  })

  it('throws on conflict when new address already exists', () => {
    const dir = tmpDir()
    saveBoardConfig(dir, { address: 'old.bso' })
    saveBoardConfig(dir, { address: 'existing.bso' })

    expect(() => renameBoardConfig(dir, 'old.bso', 'existing.bso')).toThrow(
      'Board config for "existing.bso" already exists, cannot rename from "old.bso"'
    )

    // Old config should still exist
    expect(existsSync(boardConfigPath(dir, 'old.bso'))).toBe(true)
  })

  it('preserves moderationReasons through rename', () => {
    const dir = tmpDir()
    saveBoardConfig(dir, { address: 'a.bso', moderationReasons: { archiveCapacity: 'custom reason' } })

    renameBoardConfig(dir, 'a.bso', 'b.bso')

    const config = loadBoardConfig(boardConfigPath(dir, 'b.bso'))
    expect(config.moderationReasons?.archiveCapacity).toBe('custom reason')
  })
})
