import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { platform, tmpdir } from 'node:os'
import stripJsonComments from 'strip-json-comments'
import type { CommunityDefaultsPreset } from './community-defaults.js'

export interface FlatPresetEntry {
  dotPath: string
  value: unknown
  section: 'boardSettings' | 'boardManagerSettings'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Flatten a preset into dot-path entries for display. */
export function flattenPreset(preset: CommunityDefaultsPreset): FlatPresetEntry[] {
  const entries: FlatPresetEntry[] = []

  function walkBoardSettings(obj: Record<string, unknown>, prefix: string): void {
    for (const [key, value] of Object.entries(obj)) {
      const dotPath = prefix ? `${prefix}.${key}` : key
      if (isPlainObject(value) && !Array.isArray(value)) {
        walkBoardSettings(value, dotPath)
      } else {
        entries.push({ dotPath, value, section: 'boardSettings' })
      }
    }
  }

  walkBoardSettings(preset.boardSettings as Record<string, unknown>, '')

  for (const [key, value] of Object.entries(preset.boardManagerSettings)) {
    if (value !== undefined) {
      entries.push({ dotPath: key, value, section: 'boardManagerSettings' })
    }
  }

  return entries
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    const len = value.length
    const noun = len === 1 ? 'item' : 'items'
    return `[Array: ${len} ${noun}]`
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    return `{Object: ${keys.join(', ')}}`
  }
  return String(value)
}

/** Build an aligned display of preset defaults. */
export function formatPresetDisplay(address: string, entries: FlatPresetEntry[]): string {
  const boardEntries = entries.filter((e) => e.section === 'boardSettings')
  const managerEntries = entries.filter((e) => e.section === 'boardManagerSettings')

  const allPaths = entries.map((e) => e.dotPath)
  const maxPathLen = allPaths.reduce((max, p) => Math.max(max, p.length), 0)

  const lines: string[] = []
  lines.push(`Preset defaults for "${address}":`)
  lines.push('')

  if (boardEntries.length > 0) {
    lines.push('  Board Settings (applied to community):')
    for (const entry of boardEntries) {
      const padded = entry.dotPath.padEnd(maxPathLen)
      lines.push(`    ${padded}  ${formatValue(entry.value)}`)
    }
  } else {
    lines.push('  Board Settings: (none)')
  }

  lines.push('')

  if (managerEntries.length > 0) {
    lines.push('  Board Manager Settings (config):')
    for (const entry of managerEntries) {
      const padded = entry.dotPath.padEnd(maxPathLen)
      lines.push(`    ${padded}  ${formatValue(entry.value)}`)
    }
  } else {
    lines.push('  Board Manager Settings: (none)')
  }

  return lines.join('\n')
}

/** Resolve the user's preferred editor. */
export function resolveEditor(): string {
  const visual = process.env['VISUAL']
  if (visual) return visual

  const editor = process.env['EDITOR']
  if (editor) return editor

  return platform() === 'win32' ? 'notepad' : 'vi'
}

export interface OpenInEditorOptions {
  filename?: string
  editorCommand?: string
}

/** Open content in the user's editor and return the edited content. */
export function openInEditor(
  content: string,
  options?: OpenInEditorOptions,
): Promise<string> {
  const editor = options?.editorCommand ?? resolveEditor()
  const filename = options?.filename ?? 'edit.json'
  const dir = mkdtempSync(join(tmpdir(), '5chan-edit-'))
  const filePath = join(dir, filename)

  writeFileSync(filePath, content, 'utf-8')

  return new Promise<string>((resolve, reject) => {
    const parts = editor.split(/\s+/)
    const cmd = parts[0]
    const editorArgs = parts.slice(1)

    const args = [...editorArgs, filePath]

    const child = spawn(cmd, args, { stdio: 'inherit' })

    child.on('error', (err) => {
      cleanup(filePath)
      reject(new Error(
        `Failed to launch editor "${editor}": ${err.message}\n` +
        'Install an editor (e.g. apt-get install nano) or set $EDITOR.',
      ))
    })

    child.on('close', (code) => {
      if (code !== 0) {
        cleanup(filePath)
        reject(new Error(`Editor exited with code ${code ?? 'unknown'}`))
        return
      }

      let edited: string
      try {
        edited = readFileSync(filePath, 'utf-8')
      } catch {
        cleanup(filePath)
        reject(new Error('File was deleted or became unreadable after editing'))
        return
      }

      cleanup(filePath)
      resolve(edited)
    })
  })
}

/** Open a preset JSONC in the user's editor and return the raw edited content. */
export function openPresetInEditor(
  rawJsonc: string,
  editorCommand?: string,
): Promise<string> {
  const editor = editorCommand ?? resolveEditor()

  // Nano doesn't recognise .jsonc — force JSON syntax highlighting
  const parts = editor.split(/\s+/)
  const basename = (parts[0].split('/').pop()) ?? ''
  const nanoEditor = basename === 'nano' ? `${editor} --syntax=json` : editor

  return openInEditor(rawJsonc, {
    filename: 'preset.jsonc',
    editorCommand: nanoEditor,
  })
}

/** Strip JSONC comments and parse. Works with both plain JSON and JSONC. */
export function parsePresetJsonc(rawContent: string): unknown {
  return JSON.parse(stripJsonComments(rawContent))
}

function cleanup(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch {
    // best-effort cleanup
  }
}
