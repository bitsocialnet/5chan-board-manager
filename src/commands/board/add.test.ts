import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../../board-validator.js', () => ({
  validateBoardAddress: vi.fn(),
}))

vi.mock('../../community-defaults.js', () => ({
  applyCommunityDefaultsToBoard: vi.fn(),
  BoardManagerSettingsSchema: { safeParse: vi.fn(() => ({ success: true, data: {} })) },
  CommunityDefaultsPresetBaseSchema: { safeParse: vi.fn(() => ({ success: true, data: {} })) },
  formatZodIssues: vi.fn(() => 'mock error'),
  getCommunityDefaultsPreset: vi.fn(),
  getParseCommunityEditOptions: vi.fn(),
  loadCommunityDefaultsPreset: vi.fn(),
  loadCommunityDefaultsPresetRaw: vi.fn(() => '{}'),
}))

vi.mock('../../preset-editor.js', () => ({
  flattenPreset: vi.fn(() => []),
  formatPresetDisplay: vi.fn(() => 'Preset defaults for "mock":'),
  openPresetInEditor: vi.fn(),
  parsePresetJsonc: vi.fn((raw: string) => JSON.parse(raw)),
}))

import { validateBoardAddress } from '../../board-validator.js'
import {
  applyCommunityDefaultsToBoard,
  getCommunityDefaultsPreset,
  loadCommunityDefaultsPreset,
} from '../../community-defaults.js'
import type { CommunityDefaultsPreset } from '../../community-defaults.js'
import { loadConfig } from '../../config-manager.js'
import BoardAdd from './add.js'

const mockValidate = vi.mocked(validateBoardAddress)
const mockApplyDefaults = vi.mocked(applyCommunityDefaultsToBoard)
const mockGetPreset = vi.mocked(getCommunityDefaultsPreset)
const mockLoadPreset = vi.mocked(loadCommunityDefaultsPreset)

interface RunCommandOptions {
  interactive?: boolean
  interactiveResult?: CommunityDefaultsPreset | 'skip'
}

const DEFAULT_PRESET: CommunityDefaultsPreset = {
  boardSettings: { features: { noUpvotes: true } },
  boardManagerSettings: {
    perPage: 15,
    pages: 10,
    bumpLimit: 300,
    archivePurgeSeconds: 172800,
  },
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'board-add-test-'))
}

function writeBoardConfig(dir: string, board: { address: string;[key: string]: unknown }): void {
  const boardDir = join(dir, 'boards', board.address)
  mkdirSync(boardDir, { recursive: true })
  writeFileSync(join(boardDir, 'config.json'), JSON.stringify(board))
}

async function runCommand(
  args: string[],
  configDir: string,
  options: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''

  const cmd = new BoardAdd(args, {} as never)
  Object.defineProperty(cmd, 'config', {
    value: {
      configDir,
      runHook: async () => ({ successes: [], failures: [] }),
    },
  })
  // Capture output
  cmd.log = (...logArgs: string[]) => {
    stdout += logArgs.join(' ') + '\n'
  }
  cmd.warn = ((...warnArgs: [string | Error]) => {
    stderr += String(warnArgs[0]) + '\n'
  }) as typeof cmd.warn
  ;(cmd as unknown as { isInteractive: () => boolean }).isInteractive = () => options.interactive ?? true
  ;(cmd as unknown as { promptInteractiveDefaults: (address: string, preset: CommunityDefaultsPreset, rawJsonc: string) => Promise<CommunityDefaultsPreset | 'skip'> }).promptInteractiveDefaults = async (
    _address: string,
    preset: CommunityDefaultsPreset,
    _rawJsonc: string,
  ) => options.interactiveResult ?? preset

  await cmd.run()

  return { stdout, stderr }
}

describe('board add command', () => {
  const dirs: string[] = []

  function tmpDir(): string {
    const d = makeTmpDir()
    dirs.push(d)
    return d
  }

  beforeEach(() => {
    mockValidate.mockReset()
    mockValidate.mockResolvedValue(undefined)
    mockApplyDefaults.mockReset()
    mockApplyDefaults.mockResolvedValue({ applied: true, changedFields: ['features'] })
    mockGetPreset.mockReset()
    mockGetPreset.mockResolvedValue(DEFAULT_PRESET)
    mockLoadPreset.mockReset()
    mockLoadPreset.mockResolvedValue({
      boardSettings: { features: { requirePostLink: true } },
      boardManagerSettings: {
        perPage: 25,
      },
    })
  })

  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('adds a board to an empty config', async () => {
    const dir = tmpDir()
    await runCommand(['new-board.bso'], dir)

    const config = loadConfig(dir)
    expect(config.boards).toHaveLength(1)
    expect(config.boards[0]).toEqual({
      address: 'new-board.bso',
      perPage: 15,
      pages: 10,
      bumpLimit: 300,
      archivePurgeSeconds: 172800,
    })
  })

  it('validates board address before adding', async () => {
    const dir = tmpDir()
    await runCommand(['board.bso', '--rpc-url', 'ws://test:9138'], dir)

    expect(mockValidate).toHaveBeenCalledWith('board.bso', 'ws://test:9138')
  })

  it('applies defaults by default in interactive mode', async () => {
    const dir = tmpDir()
    await runCommand(['board.bso'], dir)
    expect(mockApplyDefaults).toHaveBeenCalledWith(
      'board.bso',
      'ws://localhost:9138',
      await mockGetPreset.mock.results[0].value,
    )
  })

  it('adds a board with per-board overrides', async () => {
    const dir = tmpDir()
    await runCommand([
      'board.bso',
      '--per-page', '25',
      '--pages', '5',
      '--bump-limit', '500',
      '--archive-purge-seconds', '86400',
    ], dir)

    const config = loadConfig(dir)
    expect(config.boards[0]).toEqual({
      address: 'board.bso',
      perPage: 25,
      pages: 5,
      bumpLimit: 500,
      archivePurgeSeconds: 86400,
    })
  })

  it('does not overwrite existing boards', async () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'existing.bso' })

    await runCommand(['new.bso'], dir)

    const config = loadConfig(dir)
    expect(config.boards).toHaveLength(2)
    expect(config.boards.map((b) => b.address).sort()).toEqual(['existing.bso', 'new.bso'])
  })

  it('throws when board already exists', async () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'dup.bso' })

    await expect(runCommand(['dup.bso'], dir)).rejects.toThrow('already exists')
    expect(mockApplyDefaults).not.toHaveBeenCalled()
  })

  it('duplicate check runs before interactive prompt', async () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'dup.bso' })

    const promptSpy = vi.fn()
    const cmd = new BoardAdd(['dup.bso'], {} as never)
    Object.defineProperty(cmd, 'config', {
      value: {
        configDir: dir,
        runHook: async () => ({ successes: [], failures: [] }),
      },
    })
    cmd.log = () => {}
    ;(cmd as unknown as { isInteractive: () => boolean }).isInteractive = () => true
    ;(cmd as unknown as { promptInteractiveDefaults: typeof promptSpy }).promptInteractiveDefaults = promptSpy

    await expect(cmd.run()).rejects.toThrow('already exists')
    expect(promptSpy).not.toHaveBeenCalled()
    expect(mockGetPreset).not.toHaveBeenCalled()
  })

  it('errors when both apply and skip flags are provided', async () => {
    const dir = tmpDir()
    await expect(
      runCommand(['board.bso', '--apply-defaults', '--skip-apply-defaults'], dir),
    ).rejects.toThrow('Only one of --apply-defaults, --skip-apply-defaults, or --interactive-apply-defaults')
  })

  it('errors when apply and interactive flags are provided', async () => {
    const dir = tmpDir()
    await expect(
      runCommand(['board.bso', '--apply-defaults', '--interactive-apply-defaults'], dir),
    ).rejects.toThrow('Only one of --apply-defaults, --skip-apply-defaults, or --interactive-apply-defaults')
  })

  it('errors when skip and interactive flags are provided', async () => {
    const dir = tmpDir()
    await expect(
      runCommand(['board.bso', '--skip-apply-defaults', '--interactive-apply-defaults'], dir),
    ).rejects.toThrow('Only one of --apply-defaults, --skip-apply-defaults, or --interactive-apply-defaults')
  })

  it('errors when all three flags are provided', async () => {
    const dir = tmpDir()
    await expect(
      runCommand(['board.bso', '--apply-defaults', '--skip-apply-defaults', '--interactive-apply-defaults'], dir),
    ).rejects.toThrow('Only one of --apply-defaults, --skip-apply-defaults, or --interactive-apply-defaults')
  })

  it('errors when --interactive-apply-defaults is used in non-interactive mode', async () => {
    const dir = tmpDir()
    await expect(
      runCommand(['board.bso', '--interactive-apply-defaults'], dir, { interactive: false }),
    ).rejects.toThrow('--interactive-apply-defaults requires an interactive terminal (TTY)')
  })

  it('errors in non-interactive mode when no defaults decision flag is provided', async () => {
    const dir = tmpDir()
    await expect(runCommand(['board.bso'], dir, { interactive: false })).rejects.toThrow(
      'Non-interactive mode requires --apply-defaults or --skip-apply-defaults',
    )
  })

  it('skips applying defaults when --skip-apply-defaults is set', async () => {
    const dir = tmpDir()
    await runCommand(['board.bso', '--skip-apply-defaults'], dir, { interactive: false })
    expect(mockApplyDefaults).not.toHaveBeenCalled()
  })

  it('applies defaults in non-interactive mode when --apply-defaults is set', async () => {
    const dir = tmpDir()
    await runCommand(['board.bso', '--apply-defaults'], dir, { interactive: false })
    expect(mockApplyDefaults).toHaveBeenCalledOnce()
  })

  it('skips defaults when interactive prompt returns skip', async () => {
    const dir = tmpDir()
    await runCommand(['board.bso'], dir, { interactiveResult: 'skip' })
    expect(mockApplyDefaults).not.toHaveBeenCalled()
  })

  it('applies modified preset when interactive prompt returns modified values', async () => {
    const dir = tmpDir()
    const modifiedPreset: CommunityDefaultsPreset = {
      boardSettings: { features: { noUpvotes: false } },
      boardManagerSettings: {
        perPage: 50,
        pages: 5,
        bumpLimit: 100,
        archivePurgeSeconds: 86400,
      },
    }
    await runCommand(['board.bso'], dir, { interactiveResult: modifiedPreset })
    expect(mockApplyDefaults).toHaveBeenCalledWith(
      'board.bso',
      'ws://localhost:9138',
      modifiedPreset,
    )

    const config = loadConfig(dir)
    expect(config.boards[0].perPage).toBe(50)
    expect(config.boards[0].pages).toBe(5)
    expect(config.boards[0].bumpLimit).toBe(100)
    expect(config.boards[0].archivePurgeSeconds).toBe(86400)
  })

  it('loads custom preset file when --defaults-preset is provided', async () => {
    const dir = tmpDir()
    const presetPath = join(dir, 'preset.json')
    writeFileSync(presetPath, JSON.stringify({
      boardSettings: { features: { noUpvotes: true } },
      boardManagerSettings: { perPage: 25 },
    }))

    await runCommand(
      ['board.bso', '--apply-defaults', '--defaults-preset', presetPath],
      dir,
      { interactive: false },
    )

    expect(mockLoadPreset).toHaveBeenCalledWith(presetPath)

    const config = loadConfig(dir)
    expect(config.boards[0].perPage).toBe(25)
  })

  it('fails command and does not add board if applying defaults fails', async () => {
    const dir = tmpDir()
    writeBoardConfig(dir, { address: 'existing.bso' })

    mockApplyDefaults.mockRejectedValue(new Error('no moderator rights'))
    await expect(
      runCommand(['new.bso', '--apply-defaults'], dir, { interactive: false }),
    ).rejects.toThrow('no moderator rights')

    const config = loadConfig(dir)
    expect(config.boards).toHaveLength(1)
    expect(config.boards[0].address).toBe('existing.bso')
  })

  it('throws when validation fails', async () => {
    mockValidate.mockRejectedValue(new Error('Community not found'))
    const dir = tmpDir()

    await expect(runCommand(['bad.bso'], dir)).rejects.toThrow('Community not found')
  })

  it('prints confirmation message', async () => {
    const dir = tmpDir()
    const { stdout } = await runCommand(['board.bso'], dir)
    expect(stdout).toContain('Added board "board.bso"')
  })

  it('board config has no preset values when defaults are skipped', async () => {
    const dir = tmpDir()
    await runCommand(['board.bso', '--skip-apply-defaults'], dir, { interactive: false })

    const config = loadConfig(dir)
    expect(config.boards[0]).toEqual({ address: 'board.bso' })
  })

  it('cli flag overrides override interactive preset values', async () => {
    const dir = tmpDir()
    await runCommand(
      ['board.bso', '--per-page', '99'],
      dir,
      { interactiveResult: DEFAULT_PRESET },
    )

    const config = loadConfig(dir)
    expect(config.boards[0].perPage).toBe(99)
    expect(config.boards[0].pages).toBe(10)
  })

  it('creates board file in boards/ directory', async () => {
    const dir = tmpDir()
    await runCommand(['my-board.bso', '--skip-apply-defaults'], dir, { interactive: false })

    expect(existsSync(join(dir, 'boards', 'my-board.bso', 'config.json'))).toBe(true)
  })

  it('throws descriptive error for unknown flag', async () => {
    const dir = tmpDir()

    await expect(runCommand(['new.bso', '--title', 'My Board'], dir)).rejects.toThrow('Unknown option: --title')
  })

  it('mentions bitsocial-cli in unknown flag error', async () => {
    const dir = tmpDir()

    await expect(runCommand(['new.bso', '--title', 'My Board'], dir)).rejects.toThrow('bitsocial-cli')
  })

  it('mentions 5chan settings in unknown flag error', async () => {
    const dir = tmpDir()

    await expect(runCommand(['new.bso', '--title', 'My Board'], dir)).rejects.toThrow('5chan settings')
  })
})
