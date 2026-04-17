import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('./pkc-rpc.js', () => ({
  connectToPkcRpc: vi.fn(),
}))

import { connectToPkcRpc } from './pkc-rpc.js'
import {
  applyCommunityDefaultsToBoard,
  buildCommunityDefaultsPatch,
  buildMissingObjectPatch,
  loadCommunityDefaultsPreset,
  loadCommunityDefaultsPresetRaw,
  setParseCommunityEditOptionsOverrideForTests,
} from './community-defaults.js'
import type { PKCInstance, Community } from './types.js'

const mockConnect = vi.mocked(connectToPkcRpc)

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'community-defaults-test-'))
}

function createMockCommunity(overrides: Partial<Pick<Community, 'features' | 'settings'>> = {}): Community {
  const edit = vi.fn<Community['edit']>().mockResolvedValue(undefined)
  return {
    features: {},
    settings: {},
    edit,
    ...overrides,
  } as unknown as Community
}

function createMockPKCInstance(community: Community): PKCInstance {
  return {
    getCommunity: vi.fn<PKCInstance['getCommunity']>().mockResolvedValue(community),
    destroy: vi.fn<PKCInstance['destroy']>().mockResolvedValue(undefined),
  } as unknown as PKCInstance
}

describe('community defaults preset loading', () => {
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
    setParseCommunityEditOptionsOverrideForTests(undefined)
  })

  beforeEach(() => {
    setParseCommunityEditOptionsOverrideForTests((editOptions) => {
      const pseudonymityMode = (editOptions as { features?: { pseudonymityMode?: unknown } })
        .features?.pseudonymityMode
      if (
        pseudonymityMode !== undefined &&
        pseudonymityMode !== 'per-post' &&
        pseudonymityMode !== 'per-author'
      ) {
        throw new Error('Invalid value for features.pseudonymityMode')
      }
      return editOptions
    })
  })

  it('loads a valid preset json file', async () => {
    const dir = tmpDir()
    const presetPath = join(dir, 'preset.json')
    writeFileSync(presetPath, JSON.stringify({
      boardSettings: {
        features: { noUpvotes: true },
      },
      boardManagerSettings: {
        perPage: 15,
      },
    }))

    const preset = await loadCommunityDefaultsPreset(presetPath)
    expect(preset.boardSettings.features?.noUpvotes).toBe(true)
    expect(preset.boardManagerSettings.perPage).toBe(15)
  })

  it('loads a valid preset jsonc file with comments', async () => {
    const dir = tmpDir()
    const presetPath = join(dir, 'preset.jsonc')
    writeFileSync(presetPath, [
      '{',
      '  // Board settings comment',
      '  "boardSettings": {',
      '    "features": { "noUpvotes": true }',
      '  },',
      '  "boardManagerSettings": {',
      '    "perPage": 20 // inline comment',
      '  }',
      '}',
    ].join('\n'))

    const preset = await loadCommunityDefaultsPreset(presetPath)
    expect(preset.boardSettings.features?.noUpvotes).toBe(true)
    expect(preset.boardManagerSettings.perPage).toBe(20)
  })

  it('loads a valid preset jsonc file with trailing commas', async () => {
    const dir = tmpDir()
    const presetPath = join(dir, 'preset.jsonc')
    writeFileSync(presetPath, [
      '{',
      '  "boardSettings": {',
      '    "features": { "noUpvotes": true },',
      '  },',
      '  "boardManagerSettings": {',
      '    "perPage": 10,',
      '  },',
      '}',
    ].join('\n'))

    const preset = await loadCommunityDefaultsPreset(presetPath)
    expect(preset.boardSettings.features?.noUpvotes).toBe(true)
    expect(preset.boardManagerSettings.perPage).toBe(10)
  })

  it('throws when preset json is invalid', async () => {
    const dir = tmpDir()
    const presetPath = join(dir, 'bad.json')
    writeFileSync(presetPath, '{bad json')

    await expect(loadCommunityDefaultsPreset(presetPath)).rejects.toThrow('Invalid JSON')
  })

  it('loadCommunityDefaultsPresetRaw returns raw string with comments', () => {
    const dir = tmpDir()
    const presetPath = join(dir, 'preset.jsonc')
    const content = '// comment\n{"boardSettings": {}, "boardManagerSettings": {}}\n'
    writeFileSync(presetPath, content)

    const raw = loadCommunityDefaultsPresetRaw(presetPath)
    expect(raw).toBe(content)
    expect(raw).toContain('//')
  })

  it('throws when preset has invalid pseudonymity mode', async () => {
    const dir = tmpDir()
    const presetPath = join(dir, 'bad-shape.json')
    writeFileSync(presetPath, JSON.stringify({
      boardSettings: {
        features: { pseudonymityMode: 'wrong' },
      },
      boardManagerSettings: {},
    }))

    await expect(loadCommunityDefaultsPreset(presetPath)).rejects.toThrow('pseudonymityMode')
  })

  it('throws when preset has unsupported top-level keys', async () => {
    const dir = tmpDir()
    const presetPath = join(dir, 'bad-key.json')
    writeFileSync(presetPath, JSON.stringify({
      boardSettings: {},
      boardManagerSettings: {},
      title: 'x',
    }))

    await expect(loadCommunityDefaultsPreset(presetPath)).rejects.toThrow('Unrecognized key: "title"')
  })

  it('loads preset with moderationReasons in boardManagerSettings', async () => {
    const dir = tmpDir()
    const presetPath = join(dir, 'preset.json')
    writeFileSync(presetPath, JSON.stringify({
      boardSettings: {},
      boardManagerSettings: {
        moderationReasons: {
          archiveCapacity: 'custom capacity',
          purgeDeleted: 'custom purge',
        },
      },
    }))

    const preset = await loadCommunityDefaultsPreset(presetPath)
    expect(preset.boardManagerSettings.moderationReasons?.archiveCapacity).toBe('custom capacity')
    expect(preset.boardManagerSettings.moderationReasons?.purgeDeleted).toBe('custom purge')
  })
})

describe('buildMissingObjectPatch', () => {
  it('fills only missing nested values', () => {
    const patch = buildMissingObjectPatch(
      {
        noImages: false,
        nested: { keep: 1 },
      },
      {
        noImages: true,
        noVideos: true,
        nested: { keep: 2, add: 3 },
      },
    )

    expect(patch).toEqual({
      noVideos: true,
      nested: { add: 3 },
    })
  })

  it('overwrites arrays when they differ from existing value', () => {
    const patch = buildMissingObjectPatch(
      { items: [1, 2, 3] },
      { items: [4, 5, 6] },
    )

    expect(patch).toEqual({ items: [4, 5, 6] })
  })

  it('skips arrays when they are identical to existing value', () => {
    const patch = buildMissingObjectPatch(
      { items: [1, 2, 3] },
      { items: [1, 2, 3] },
    )

    expect(patch).toBeUndefined()
  })

  it('returns undefined when nothing is missing', () => {
    const patch = buildMissingObjectPatch(
      {
        noImages: false,
        nested: { keep: 1, add: 3 },
      },
      {
        noImages: true,
        nested: { keep: 2, add: 3 },
      },
    )

    expect(patch).toBeUndefined()
  })
})

describe('buildCommunityDefaultsPatch', () => {
  it('builds patch only for missing boardSettings values', () => {
    const community = createMockCommunity({
      features: { noUpvotes: false },
      settings: { challenges: [{ name: 'captcha' }] },
    })

    const { patch, changedFields } = buildCommunityDefaultsPatch(community, {
      boardSettings: {
        features: { noUpvotes: true, noDownvotes: true },
        settings: { challenges: [{ name: 'captcha-v2' }], fetchThumbnailUrls: false },
      },
      boardManagerSettings: {},
    })

    expect(changedFields).toEqual(['features', 'settings'])
    expect(patch).toEqual({
      features: { noDownvotes: true },
      settings: { challenges: [{ name: 'captcha-v2' }], fetchThumbnailUrls: false },
    })
  })
})

describe('applyCommunityDefaultsToBoard', () => {
  beforeEach(() => {
    mockConnect.mockReset()
  })

  it('applies defaults and edits community when patch is non-empty', async () => {
    const community = createMockCommunity({
      features: { noUpvotes: false },
      settings: {},
    })
    const instance = createMockPKCInstance(community)
    mockConnect.mockResolvedValue(instance)

    const result = await applyCommunityDefaultsToBoard('board.bso', 'ws://localhost:9138', {
      boardSettings: {
        features: { noUpvotes: true, noDownvotes: true },
        settings: { fetchThumbnailUrls: false },
      },
      boardManagerSettings: {},
    })

    expect(result.applied).toBe(true)
    expect(result.changedFields).toEqual(['features', 'settings'])
    expect(community.edit).toHaveBeenCalledWith({
      features: { noDownvotes: true },
      settings: { fetchThumbnailUrls: false },
    })
    expect(instance.destroy).toHaveBeenCalledOnce()
  })

  it('returns no-op when all defaults already exist', async () => {
    const community = createMockCommunity({
      features: { noUpvotes: false, noDownvotes: true },
      settings: { fetchThumbnailUrls: false },
    })
    const instance = createMockPKCInstance(community)
    mockConnect.mockResolvedValue(instance)

    const result = await applyCommunityDefaultsToBoard('board.bso', 'ws://localhost:9138', {
      boardSettings: {
        features: { noUpvotes: true, noDownvotes: true },
        settings: { fetchThumbnailUrls: false },
      },
      boardManagerSettings: {},
    })

    expect(result).toEqual({ applied: false, changedFields: [] })
    expect(community.edit).not.toHaveBeenCalled()
    expect(instance.destroy).toHaveBeenCalledOnce()
  })

  it('destroys PKC instance even when community lookup fails', async () => {
    const destroy = vi.fn<PKCInstance['destroy']>().mockResolvedValue(undefined)
    const getCommunity = vi.fn<PKCInstance['getCommunity']>().mockRejectedValue(new Error('lookup failed'))
    const instance = { getCommunity, destroy } as unknown as PKCInstance
    mockConnect.mockResolvedValue(instance)

    await expect(applyCommunityDefaultsToBoard('board.bso', 'ws://localhost:9138', {
      boardSettings: {},
      boardManagerSettings: {},
    })).rejects.toThrow('lookup failed')
    expect(destroy).toHaveBeenCalledOnce()
  })
})
