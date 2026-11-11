import type { CommunityPageSortSetting } from '@pkcprotocol/pkc-js'
import type { CommunityDefaultsPreset } from './community-defaults.js'
import type { Community } from './types.js'

/** Registry name of the bump-order sort that owns the board's bump limit. */
export const ACTIVE_PAGE_SORT_NAME = '@pkcprotocol/active-page-sort'

type CommunitySettings = NonNullable<Community['settings']>

function isActivePageSort(entry: CommunityPageSortSetting): boolean {
  // Matched by registry name only: a `path:` entry may load the same file, but
  // nothing reliable says so from the path alone.
  return entry.name === ACTIVE_PAGE_SORT_NAME
}

/** Whether the settings name `@pkcprotocol/active-page-sort` in `pages.posts`. */
export function runsActivePageSort(settings: CommunitySettings | undefined): boolean {
  return settings?.pages?.posts?.some(isActivePageSort) ?? false
}

/**
 * Return `settings` with every `@pkcprotocol/active-page-sort` post sort carrying
 * `options.bumpLimit = String(bumpLimit)`, or `undefined` when nothing changes
 * (the sort is absent or already has that limit).
 *
 * The result is a whole settings object, because pkc-js replaces `settings`
 * wholesale on edit: sending only `pages` would wipe the challenges.
 */
export function withActivePageSortBumpLimit<T extends CommunitySettings>(
  settings: T | undefined,
  bumpLimit: number,
): T | undefined {
  const posts = settings?.pages?.posts
  if (!settings || !posts) return undefined

  const value = String(bumpLimit)
  let changed = false
  const updatedPosts = posts.map((entry) => {
    if (!isActivePageSort(entry) || entry.options?.bumpLimit === value) return entry
    changed = true
    return { ...entry, options: { ...entry.options, bumpLimit: value } }
  })
  if (!changed) return undefined

  return { ...settings, pages: { ...settings.pages, posts: updatedPosts } }
}

/**
 * The `updatedAt` a board record must pass to have been generated after an edit to the board's
 * post sorts that just returned. pkc-js applies the edit at once but regenerates the pages in a
 * later publish cycle, so until then they are still sorted by the old settings and capacity
 * archiving waits (`BoardManagerState.holdArchivingUntilUpdatedAt`). `updatedAt` is not
 * wall-clock time (it stays strictly increasing, so rapid publishes run it ahead of the clock).
 * Publish cycles do not overlap, so a record stamped past both the record current at the edit
 * and the edit's own second, plus one for a cycle already in flight, was generated after the edit.
 */
export function archivingHoldAfterSortEdit(updatedAtBeforeEdit: number): number {
  return Math.max(updatedAtBeforeEdit, Math.floor(Date.now() / 1000)) + 1
}

/**
 * Return the preset with its `@pkcprotocol/active-page-sort` entry carrying the
 * board's bump limit, so applying it writes the board's own limit the first time
 * instead of the preset's literal value (each `settings.pages` change regenerates
 * every CommentUpdate once).
 */
export function withPresetBumpLimit(preset: CommunityDefaultsPreset, bumpLimit: number): CommunityDefaultsPreset {
  const settings = withActivePageSortBumpLimit(preset.boardSettings.settings, bumpLimit)
  if (!settings) return preset
  return { ...preset, boardSettings: { ...preset.boardSettings, settings } }
}
