import { describe, it, expect } from 'vitest'
import { runsActivePageSort, withActivePageSortBumpLimit, withPresetBumpLimit } from './page-sorts.js'
import type { CommunityDefaultsPreset } from './community-defaults.js'
import type { CommunityPageSortSetting } from '@pkcprotocol/pkc-js'

const challenges = [{ name: 'fail', options: { error: 'no' } }]

function settings(postOptions: Record<string, string> | undefined) {
  return {
    challenges,
    fetchThumbnailUrls: true,
    pages: {
      posts: [
        { name: '@pkcprotocol/active-page-sort', ...(postOptions ? { options: postOptions } : {}), preloaded: true },
        { name: 'new' },
      ] as CommunityPageSortSetting[],
      replies: [{ name: 'old', preloaded: true }],
    },
  }
}

describe('runsActivePageSort', () => {
  it('finds the sort by registry name', () => {
    expect(runsActivePageSort(settings({}))).toBe(true)
  })

  it('ignores path entries, settings without pages, and missing settings', () => {
    expect(runsActivePageSort({ pages: { posts: [{ path: '/x/active-page-sort/dist/index.js' }] } })).toBe(false)
    expect(runsActivePageSort({ challenges })).toBe(false)
    expect(runsActivePageSort(undefined)).toBe(false)
  })
})

describe('withActivePageSortBumpLimit', () => {
  it('sets the limit as a string and keeps every other setting and option', () => {
    expect(withActivePageSortBumpLimit(settings({ noBumpKeywords: 'sage', bumpLimit: '300' }), 500)).toEqual({
      challenges,
      fetchThumbnailUrls: true,
      pages: {
        posts: [
          { name: '@pkcprotocol/active-page-sort', options: { noBumpKeywords: 'sage', bumpLimit: '500' }, preloaded: true },
          { name: 'new' },
        ],
        replies: [{ name: 'old', preloaded: true }],
      },
    })
  })

  it('adds options when the entry has none', () => {
    const updated = withActivePageSortBumpLimit(settings(undefined), 300)
    expect(updated?.pages.posts[0]).toEqual({ name: '@pkcprotocol/active-page-sort', options: { bumpLimit: '300' }, preloaded: true })
  })

  it('returns undefined when the limit already matches', () => {
    expect(withActivePageSortBumpLimit(settings({ bumpLimit: '300' }), 300)).toBeUndefined()
  })

  it('returns undefined when the sort is not configured', () => {
    expect(withActivePageSortBumpLimit({ challenges }, 300)).toBeUndefined()
    expect(withActivePageSortBumpLimit({ pages: { posts: [{ path: '/x/index.js', options: { bumpLimit: '1' } }] } }, 300)).toBeUndefined()
    expect(withActivePageSortBumpLimit(undefined, 300)).toBeUndefined()
  })

  it('does not mutate its input', () => {
    const input = settings({ bumpLimit: '300' })
    withActivePageSortBumpLimit(input, 500)
    expect(input.pages.posts[0].options).toEqual({ bumpLimit: '300' })
  })
})

describe('withPresetBumpLimit', () => {
  const preset: CommunityDefaultsPreset = {
    boardSettings: { features: { noUpvotes: true }, settings: settings({ noBumpKeywords: 'sage', bumpLimit: '300' }) },
    boardManagerSettings: { bumpLimit: 300 },
  }

  it('writes the board\'s limit into the preset\'s sort entry', () => {
    const updated = withPresetBumpLimit(preset, 500)
    expect(updated.boardSettings.features).toEqual({ noUpvotes: true })
    expect(updated.boardSettings.settings?.pages?.posts?.[0].options).toEqual({ noBumpKeywords: 'sage', bumpLimit: '500' })
    expect(updated.boardSettings.settings?.challenges).toEqual(challenges)
  })

  it('returns the preset unchanged when there is nothing to write', () => {
    expect(withPresetBumpLimit(preset, 300)).toBe(preset)
    const withoutSort: CommunityDefaultsPreset = { boardSettings: { settings: { challenges } }, boardManagerSettings: {} }
    expect(withPresetBumpLimit(withoutSort, 500)).toBe(withoutSort)
  })
})
