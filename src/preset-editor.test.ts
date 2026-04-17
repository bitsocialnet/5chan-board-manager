import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { flattenPreset, formatPresetDisplay, resolveEditor, openInEditor, openPresetInEditor, parsePresetJsonc } from './preset-editor.js'
import type { FlatPresetEntry } from './preset-editor.js'
import type { CommunityDefaultsPreset } from './community-defaults.js'

const SIMPLE_PRESET: CommunityDefaultsPreset = {
  boardSettings: {
    features: {
      noUpvotes: true,
      noDownvotes: true,
    },
  },
  boardManagerSettings: {
    perPage: 15,
    pages: 10,
  },
}

const PRESET_WITH_CHALLENGES: CommunityDefaultsPreset = {
  boardSettings: {
    features: {
      noUpvotes: true,
      pseudonymityMode: 'per-post',
    },
    settings: {
      challenges: [
        { name: 'fail', description: 'Blocks excessive failures.' },
        { name: 'captcha-canvas-v3', description: 'Post captcha.' },
      ],
    },
  },
  boardManagerSettings: {
    perPage: 15,
    bumpLimit: 300,
  },
}

describe('flattenPreset', () => {
  it('flattens a simple preset into dot-path entries', () => {
    const entries = flattenPreset(SIMPLE_PRESET)

    expect(entries).toEqual([
      { dotPath: 'features.noUpvotes', value: true, section: 'boardSettings' },
      { dotPath: 'features.noDownvotes', value: true, section: 'boardSettings' },
      { dotPath: 'perPage', value: 15, section: 'boardManagerSettings' },
      { dotPath: 'pages', value: 10, section: 'boardManagerSettings' },
    ])
  })

  it('preserves arrays as leaf values without further flattening', () => {
    const entries = flattenPreset(PRESET_WITH_CHALLENGES)

    const challengesEntry = entries.find((e) => e.dotPath === 'settings.challenges')
    expect(challengesEntry).toBeDefined()
    expect(challengesEntry!.section).toBe('boardSettings')
    expect(Array.isArray(challengesEntry!.value)).toBe(true)
    expect((challengesEntry!.value as unknown[]).length).toBe(2)
  })

  it('handles empty boardSettings', () => {
    const entries = flattenPreset({
      boardSettings: {},
      boardManagerSettings: { perPage: 15 },
    })

    const boardEntries = entries.filter((e) => e.section === 'boardSettings')
    const managerEntries = entries.filter((e) => e.section === 'boardManagerSettings')

    expect(boardEntries).toHaveLength(0)
    expect(managerEntries).toHaveLength(1)
  })

  it('handles empty boardManagerSettings', () => {
    const entries = flattenPreset({
      boardSettings: { features: { noUpvotes: true } },
      boardManagerSettings: {},
    })

    const boardEntries = entries.filter((e) => e.section === 'boardSettings')
    const managerEntries = entries.filter((e) => e.section === 'boardManagerSettings')

    expect(boardEntries).toHaveLength(1)
    expect(managerEntries).toHaveLength(0)
  })

  it('skips undefined boardManagerSettings values', () => {
    const entries = flattenPreset({
      boardSettings: {},
      boardManagerSettings: { perPage: 15, pages: undefined },
    })

    expect(entries).toEqual([
      { dotPath: 'perPage', value: 15, section: 'boardManagerSettings' },
    ])
  })
})

describe('formatPresetDisplay', () => {
  it('formats display with both sections', () => {
    const entries: FlatPresetEntry[] = [
      { dotPath: 'features.noUpvotes', value: true, section: 'boardSettings' },
      { dotPath: 'features.noDownvotes', value: true, section: 'boardSettings' },
      { dotPath: 'perPage', value: 15, section: 'boardManagerSettings' },
    ]

    const output = formatPresetDisplay('board.bso', entries)

    expect(output).toContain('Preset defaults for "board.bso"')
    expect(output).toContain('Board Settings (applied to community)')
    expect(output).toContain('features.noUpvotes')
    expect(output).toContain('true')
    expect(output).toContain('Board Manager Settings (config)')
    expect(output).toContain('perPage')
    expect(output).toContain('15')
  })

  it('shows "(none)" for empty sections', () => {
    const entries: FlatPresetEntry[] = [
      { dotPath: 'perPage', value: 15, section: 'boardManagerSettings' },
    ]

    const output = formatPresetDisplay('board.bso', entries)

    expect(output).toContain('Board Settings: (none)')
    expect(output).toContain('Board Manager Settings (config)')
  })

  it('shows array summary for complex values', () => {
    const entries: FlatPresetEntry[] = [
      { dotPath: 'settings.challenges', value: [{ name: 'fail' }, { name: 'captcha' }], section: 'boardSettings' },
    ]

    const output = formatPresetDisplay('board.bso', entries)
    expect(output).toContain('[Array: 2 items]')
  })

  it('shows object summary for object values', () => {
    const entries: FlatPresetEntry[] = [
      { dotPath: 'options', value: { width: '280', height: '96' }, section: 'boardSettings' },
    ]

    const output = formatPresetDisplay('board.bso', entries)
    expect(output).toContain('{Object: width, height}')
  })

  it('shows singular "item" for single-element arrays', () => {
    const entries: FlatPresetEntry[] = [
      { dotPath: 'settings.challenges', value: [{ name: 'fail' }], section: 'boardSettings' },
    ]

    const output = formatPresetDisplay('board.bso', entries)
    expect(output).toContain('[Array: 1 item]')
  })
})

describe('resolveEditor', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('prefers $VISUAL over $EDITOR', () => {
    process.env['VISUAL'] = 'code'
    process.env['EDITOR'] = 'vim'

    expect(resolveEditor()).toBe('code')
  })

  it('falls back to $EDITOR when $VISUAL is unset', () => {
    delete process.env['VISUAL']
    process.env['EDITOR'] = 'nano'

    expect(resolveEditor()).toBe('nano')
  })

  it('falls back to vi on non-win32 when both are unset', () => {
    delete process.env['VISUAL']
    delete process.env['EDITOR']

    // On Linux (our CI/test env), should return 'vi'
    const result = resolveEditor()
    expect(['vi', 'notepad']).toContain(result)
  })
})

describe('openInEditor', () => {
  it('writes content and returns edited content', async () => {
    const content = '{"perPage": 15, "pages": 10}\n'

    // Use 'true' as a no-op editor that doesn't modify the file
    const result = await openInEditor(content, { editorCommand: 'true' })

    expect(result).toBe(content)
  })

  it('uses custom filename', async () => {
    const content = '{"key": "value"}\n'

    const result = await openInEditor(content, { filename: 'custom.json', editorCommand: 'true' })

    expect(result).toBe(content)
  })

  it('throws when editor command fails', async () => {
    await expect(openInEditor('{}', { editorCommand: 'false' })).rejects.toThrow('Editor exited with code 1')
  })

  it('throws when editor command is not found', async () => {
    await expect(
      openInEditor('{}', { editorCommand: 'nonexistent-editor-command-xyz' }),
    ).rejects.toThrow('Failed to launch editor')
  })

  it('includes actionable guidance when editor is not found', async () => {
    await expect(
      openInEditor('{}', { editorCommand: 'nonexistent-editor-command-xyz' }),
    ).rejects.toThrow('Install an editor (e.g. apt-get install nano) or set $EDITOR.')
  })
})

describe('openPresetInEditor', () => {
  const mockSpawn = vi.fn()
  let originalSpawn: typeof import('node:child_process').spawn

  beforeEach(async () => {
    const cp = await import('node:child_process')
    originalSpawn = cp.spawn
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes raw JSONC to temp file and returns edited content', async () => {
    const rawJsonc = '// comment\n{"boardSettings": {"features": {"noUpvotes": true}}, "boardManagerSettings": {"perPage": 15}}\n'

    // Use a no-op "editor" that doesn't modify the file (true command)
    const result = await openPresetInEditor(rawJsonc, 'true')

    expect(result).toBe(rawJsonc)
    const parsed = parsePresetJsonc(result)
    expect(parsed).toEqual({
      boardSettings: { features: { noUpvotes: true } },
      boardManagerSettings: { perPage: 15 },
    })
  })

  it('throws when editor command fails', async () => {
    await expect(openPresetInEditor('{}', 'false')).rejects.toThrow('Editor exited with code 1')
  })

  it('throws when editor command is not found', async () => {
    await expect(
      openPresetInEditor('{}', 'nonexistent-editor-command-xyz'),
    ).rejects.toThrow('Failed to launch editor')
  })

  it.skipIf(process.platform === 'win32')('injects --syntax=json when editor is nano', async () => {
    const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    // Create a fake "nano" script that dumps all its args into the target file (last arg)
    const dir = mkdtempSync(join(tmpdir(), '5chan-nano-test-'))
    const fakeNano = join(dir, 'nano')
    writeFileSync(
      fakeNano,
      '#!/bin/sh\neval file=\\${$#}\nprintf "%s\\n" "$@" > "$file"\n',
      'utf-8',
    )
    chmodSync(fakeNano, 0o755)

    const result = await openPresetInEditor('original-content', fakeNano)

    // The script wrote all args (including --syntax=json and the filepath) into the file
    expect(result).toContain('--syntax=json')
  })
})

describe('parsePresetJsonc', () => {
  it('parses plain JSON', () => {
    const result = parsePresetJsonc('{"key": "value"}')
    expect(result).toEqual({ key: 'value' })
  })

  it('strips single-line // comments', () => {
    const jsonc = `{
      // this is a comment
      "key": "value"
    }`
    const result = parsePresetJsonc(jsonc)
    expect(result).toEqual({ key: 'value' })
  })

  it('strips inline comments', () => {
    const jsonc = '{"key": "value" // inline comment\n}'
    const result = parsePresetJsonc(jsonc)
    expect(result).toEqual({ key: 'value' })
  })

  it('throws on invalid JSON after stripping comments', () => {
    expect(() => parsePresetJsonc('// comment\n{bad json')).toThrow()
  })

  it('round-trips JSONC content through editor', async () => {
    const rawJsonc = '// Board preset\n{\n  // A comment\n  "boardSettings": {},\n  "boardManagerSettings": {}\n}\n'

    // 'true' is a no-op editor
    const editedContent = await openPresetInEditor(rawJsonc, 'true')
    const parsed = parsePresetJsonc(editedContent)

    expect(parsed).toEqual({ boardSettings: {}, boardManagerSettings: {} })
  })
})
