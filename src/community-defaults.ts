import { connectToPkcRpc } from './pkc-rpc.js'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import stripJsonComments from 'strip-json-comments'
import { z } from 'zod'
import type { Community } from './types.js'

type CommunityEditOptions = Parameters<Community['edit']>[0]
type ParseCommunityEditOptionsFn = (editOptions: CommunityEditOptions) => CommunityEditOptions

export const ModerationReasonsSchema = z.object({
  archiveCapacity: z.string().optional(),
  archiveBumpLimit: z.string().optional(),
  purgeArchived: z.string().optional(),
  purgeDeleted: z.string().optional(),
}).strict()

export const BoardManagerSettingsSchema = z.object({
  perPage: z.number().int().positive().optional(),
  pages: z.number().int().positive().optional(),
  bumpLimit: z.number().int().positive().optional(),
  archivePurgeSeconds: z.number().int().positive().optional(),
  moderationReasons: ModerationReasonsSchema.optional(),
}).strict()

export const CommunityDefaultsPresetBaseSchema = z.object({
  boardSettings: z.record(z.string(), z.unknown()),
  boardManagerSettings: BoardManagerSettingsSchema,
}).strict()

export interface CommunityDefaultsPreset {
  boardSettings: CommunityEditOptions
  boardManagerSettings: z.infer<typeof BoardManagerSettingsSchema>
}

export type BoardManagerDefaults = z.infer<typeof BoardManagerSettingsSchema>

export interface ApplyCommunityDefaultsResult {
  applied: boolean
  changedFields: string[]
}

const COMMUNITY_DEFAULTS_PRESET_PATH = fileURLToPath(
  new URL('./presets/community-defaults.jsonc', import.meta.url),
)
const require = createRequire(import.meta.url)
let parseCommunityEditOptionsPromise: Promise<ParseCommunityEditOptionsFn> | undefined
let communityDefaultsPresetPromise: Promise<CommunityDefaultsPreset> | undefined
let parseCommunityEditOptionsOverride: ParseCommunityEditOptionsFn | undefined

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function getParseCommunityEditOptions(): Promise<ParseCommunityEditOptionsFn> {
  if (parseCommunityEditOptionsOverride) {
    return parseCommunityEditOptionsOverride
  }

  if (!parseCommunityEditOptionsPromise) {
    parseCommunityEditOptionsPromise = (async () => {
      const pkcEntrypointPath = require.resolve('@pkcprotocol/pkc-js')
      const schemaUtilModulePath = join(dirname(pkcEntrypointPath), 'schema', 'schema-util.js')
      const schemaUtilModule = (await import(pathToFileURL(schemaUtilModulePath).href)) as {
        parseCommunityEditOptionsSchemaWithPKCErrorIfItFails?: ParseCommunityEditOptionsFn
      }

      if (!schemaUtilModule.parseCommunityEditOptionsSchemaWithPKCErrorIfItFails) {
        throw new Error(
          `Failed to load parseCommunityEditOptionsSchemaWithPKCErrorIfItFails from "${schemaUtilModulePath}"`,
        )
      }

      return schemaUtilModule.parseCommunityEditOptionsSchemaWithPKCErrorIfItFails
    })()
  }

  return parseCommunityEditOptionsPromise
}

/** Test hook to avoid loading the full pkc-js schema module inside Vitest's runtime. */
export function setParseCommunityEditOptionsOverrideForTests(
  parser: ParseCommunityEditOptionsFn | undefined,
): void {
  parseCommunityEditOptionsOverride = parser
}

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

export async function loadCommunityDefaultsPreset(
  presetPath = COMMUNITY_DEFAULTS_PRESET_PATH,
): Promise<CommunityDefaultsPreset> {
  let raw: string
  try {
    raw = readFileSync(presetPath, 'utf-8')
  } catch (err) {
    throw new Error(
      `Failed to read community defaults preset "${presetPath}": ${(err as Error).message}`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonComments(raw, { trailingCommas: true }))
  } catch (err) {
    throw new Error(
      `Invalid JSON in community defaults preset "${presetPath}": ${(err as Error).message}`,
    )
  }

  const baseResult = CommunityDefaultsPresetBaseSchema.safeParse(parsed)
  if (!baseResult.success) {
    throw new Error(
      `Invalid community defaults preset "${presetPath}": ${formatZodIssues(baseResult.error)}`,
    )
  }

  const parseCommunityEditOptions = await getParseCommunityEditOptions()
  let boardSettings: CommunityEditOptions
  try {
    boardSettings = parseCommunityEditOptions(baseResult.data.boardSettings as CommunityEditOptions)
  } catch (err) {
    throw new Error(
      `Invalid community defaults preset "${presetPath}": ${(err as Error).message}`,
    )
  }

  return {
    boardSettings,
    boardManagerSettings: baseResult.data.boardManagerSettings,
  }
}

export function loadCommunityDefaultsPresetRaw(presetPath?: string): string {
  const resolvedPath = presetPath ?? COMMUNITY_DEFAULTS_PRESET_PATH
  return readFileSync(resolvedPath, 'utf-8')
}

export async function getCommunityDefaultsPreset(): Promise<CommunityDefaultsPreset> {
  if (!communityDefaultsPresetPromise) {
    communityDefaultsPresetPromise = loadCommunityDefaultsPreset()
  }
  return communityDefaultsPresetPromise
}

export function buildMissingObjectPatch(
  currentValue: unknown,
  defaults: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (currentValue !== undefined && !isPlainObject(currentValue)) {
    return undefined
  }

  const currentObject = isPlainObject(currentValue) ? currentValue : undefined
  const patch: Record<string, unknown> = {}

  for (const [key, defaultValue] of Object.entries(defaults)) {
    const existingValue = currentObject?.[key]

    if (isPlainObject(defaultValue)) {
      if (existingValue === undefined) {
        patch[key] = structuredClone(defaultValue)
        continue
      }

      if (isPlainObject(existingValue)) {
        const nestedPatch = buildMissingObjectPatch(existingValue, defaultValue)
        if (nestedPatch !== undefined) {
          patch[key] = nestedPatch
        }
      }

      continue
    }

    if (Array.isArray(defaultValue)) {
      if (JSON.stringify(existingValue) !== JSON.stringify(defaultValue)) {
        patch[key] = structuredClone(defaultValue)
      }
      continue
    }

    if (existingValue === undefined) {
      patch[key] = structuredClone(defaultValue)
    }
  }

  return Object.keys(patch).length > 0 ? patch : undefined
}

export function buildCommunityDefaultsPatch(
  community: Community,
  preset: CommunityDefaultsPreset,
): { patch: CommunityEditOptions | undefined; changedFields: string[] } {
  const boardSettings = preset.boardSettings as Record<string, unknown>
  const patch = buildMissingObjectPatch(community, boardSettings)
  const changedFields = patch ? Object.keys(patch) : []

  return {
    patch: patch ? (patch as CommunityEditOptions) : undefined,
    changedFields,
  }
}

export async function applyCommunityDefaultsToBoard(
  address: string,
  rpcUrl: string,
  preset: CommunityDefaultsPreset,
): Promise<ApplyCommunityDefaultsResult> {
  const pkc = await connectToPkcRpc(rpcUrl)

  try {
    const community = await pkc.getCommunity({ address })
    const { patch, changedFields } = buildCommunityDefaultsPatch(community, preset)
    if (!patch) {
      return { applied: false, changedFields: [] }
    }

    await community.edit(patch)

    return { applied: true, changedFields }
  } finally {
    await pkc.destroy()
  }
}
