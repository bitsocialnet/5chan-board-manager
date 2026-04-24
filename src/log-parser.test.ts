import { describe, it, expect } from 'vitest'
import {
  extractTimestamp,
  extractStream,
  parseLogEntries,
  filterByTimeRange,
  filterByStream,
  tailEntries,
  parseTimestamp,
  renderEntries,
} from './log-parser.js'

const T1 = '2026-04-24T10:00:00.000Z'
const T2 = '2026-04-24T10:05:00.000Z'
const T3 = '2026-04-24T10:10:00.000Z'

describe('extractTimestamp', () => {
  it('parses a valid timestamped line', () => {
    expect(extractTimestamp(`[${T1}] [stdout] hello`)?.toISOString()).toBe(T1)
  })

  it('returns null for a continuation line without timestamp', () => {
    expect(extractTimestamp('   at Object.<anonymous> (/app/dist/foo.js:1)')).toBeNull()
  })

  it('returns null for a malformed timestamp', () => {
    expect(extractTimestamp('[2026-04-24] hello')).toBeNull()
  })

  it('returns null for a line with timestamp but no trailing space', () => {
    expect(extractTimestamp(`[${T1}]hello`)).toBeNull()
  })
})

describe('extractStream', () => {
  it('returns stdout for stdout-marked lines', () => {
    expect(extractStream(`[${T1}] [stdout] hi`)).toBe('stdout')
  })

  it('returns stderr for stderr-marked lines', () => {
    expect(extractStream(`[${T1}] [stderr] oops`)).toBe('stderr')
  })

  it('returns null when the stream marker is missing', () => {
    expect(extractStream(`[${T1}] hi`)).toBeNull()
  })

  it('returns null when the stream marker is unknown', () => {
    expect(extractStream(`[${T1}] [debug] hi`)).toBeNull()
  })
})

describe('parseLogEntries', () => {
  it('parses a single one-line entry', () => {
    const entries = parseLogEntries(`[${T1}] [stdout] hello`)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.stream).toBe('stdout')
    expect(entries[0]!.timestamp?.toISOString()).toBe(T1)
    expect(entries[0]!.lines).toEqual([`[${T1}] [stdout] hello`])
  })

  it('attaches continuation lines to the previous entry', () => {
    const content = [
      `[${T1}] [stderr] Error: boom`,
      '    at stack line 1',
      '    at stack line 2',
      `[${T2}] [stdout] ok`,
    ].join('\n')
    const entries = parseLogEntries(content)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.lines).toHaveLength(3)
    expect(entries[1]!.stream).toBe('stdout')
  })

  it('handles mixed stdout and stderr entries', () => {
    const content = [
      `[${T1}] [stdout] a`,
      `[${T2}] [stderr] b`,
      `[${T3}] [stdout] c`,
    ].join('\n')
    const entries = parseLogEntries(content)
    expect(entries).toHaveLength(3)
    expect(entries.map(e => e.stream)).toEqual(['stdout', 'stderr', 'stdout'])
  })

  it('preserves leading lines that have no timestamp as a legacy entry', () => {
    const content = [
      'legacy header line',
      `[${T1}] [stdout] real`,
    ].join('\n')
    const entries = parseLogEntries(content)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.timestamp).toBeNull()
    expect(entries[0]!.stream).toBeNull()
    expect(entries[1]!.stream).toBe('stdout')
  })

  it('returns an empty legacy entry for empty input', () => {
    expect(parseLogEntries('')).toEqual([{ timestamp: null, stream: null, lines: [''] }])
  })
})

describe('filterByTimeRange', () => {
  const entries = parseLogEntries([
    `[${T1}] [stdout] a`,
    `[${T2}] [stderr] b`,
    `[${T3}] [stdout] c`,
  ].join('\n'))

  it('includes equal-to-since entries', () => {
    expect(filterByTimeRange(entries, new Date(T2))).toHaveLength(2)
  })

  it('excludes strictly-less-than-since entries', () => {
    expect(filterByTimeRange(entries, new Date(T3))).toHaveLength(1)
  })

  it('includes equal-to-until entries', () => {
    expect(filterByTimeRange(entries, undefined, new Date(T2))).toHaveLength(2)
  })

  it('excludes strictly-greater-than-until entries', () => {
    expect(filterByTimeRange(entries, undefined, new Date(T1))).toHaveLength(1)
  })

  it('applies both since and until', () => {
    const filtered = filterByTimeRange(entries, new Date(T2), new Date(T2))
    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.timestamp?.toISOString()).toBe(T2)
  })

  it('excludes legacy no-timestamp entries when since is set', () => {
    const withLegacy = parseLogEntries(`legacy\n[${T1}] [stdout] a`)
    expect(filterByTimeRange(withLegacy, new Date(T1))).toHaveLength(1)
  })

  it('includes legacy no-timestamp entries when since is not set', () => {
    const withLegacy = parseLogEntries(`legacy\n[${T1}] [stdout] a`)
    expect(filterByTimeRange(withLegacy)).toHaveLength(2)
  })
})

describe('filterByStream', () => {
  const entries = parseLogEntries([
    `[${T1}] [stdout] a`,
    `[${T2}] [stderr] b`,
    `[${T3}] [stdout] c`,
  ].join('\n'))

  it('keeps only stdout entries', () => {
    expect(filterByStream(entries, 'stdout').map(e => e.lines[0])).toEqual([
      `[${T1}] [stdout] a`,
      `[${T3}] [stdout] c`,
    ])
  })

  it('keeps only stderr entries', () => {
    expect(filterByStream(entries, 'stderr')).toHaveLength(1)
  })
})

describe('tailEntries', () => {
  const entries = parseLogEntries([
    `[${T1}] [stdout] a`,
    `[${T2}] [stdout] b`,
    `[${T3}] [stdout] c`,
  ].join('\n'))

  it('returns all entries when tailValue is "all"', () => {
    expect(tailEntries(entries, 'all')).toHaveLength(3)
  })

  it('returns last N entries for a positive integer', () => {
    expect(tailEntries(entries, '2').map(e => e.lines[0])).toEqual([
      `[${T2}] [stdout] b`,
      `[${T3}] [stdout] c`,
    ])
  })

  it('returns empty array for "0"', () => {
    expect(tailEntries(entries, '0')).toEqual([])
  })

  it('throws on invalid input', () => {
    expect(() => tailEntries(entries, 'abc')).toThrow(/Invalid --tail value/)
  })

  it('throws on negative input', () => {
    expect(() => tailEntries(entries, '-1')).toThrow(/Invalid --tail value/)
  })
})

describe('parseTimestamp', () => {
  it('parses relative seconds', () => {
    const now = Date.now()
    const parsed = parseTimestamp('30s').getTime()
    expect(parsed).toBeLessThanOrEqual(now)
    expect(parsed).toBeGreaterThan(now - 35_000)
  })

  it('parses relative minutes', () => {
    const now = Date.now()
    const parsed = parseTimestamp('5m').getTime()
    expect(parsed).toBeLessThanOrEqual(now - 5 * 60_000 + 1000)
    expect(parsed).toBeGreaterThan(now - 5 * 60_000 - 1000)
  })

  it('parses relative hours', () => {
    const now = Date.now()
    const parsed = parseTimestamp('2h').getTime()
    expect(parsed).toBeLessThanOrEqual(now - 2 * 3_600_000 + 1000)
    expect(parsed).toBeGreaterThan(now - 2 * 3_600_000 - 1000)
  })

  it('parses relative days', () => {
    const now = Date.now()
    const parsed = parseTimestamp('1d').getTime()
    expect(parsed).toBeLessThanOrEqual(now - 86_400_000 + 1000)
    expect(parsed).toBeGreaterThan(now - 86_400_000 - 1000)
  })

  it('parses an ISO 8601 timestamp', () => {
    expect(parseTimestamp(T1).toISOString()).toBe(T1)
  })

  it('throws on invalid input', () => {
    expect(() => parseTimestamp('not-a-date')).toThrow(/Invalid timestamp/)
  })
})

describe('renderEntries', () => {
  it('joins multi-line entries correctly', () => {
    const entries = parseLogEntries([
      `[${T1}] [stderr] Error: boom`,
      '    at stack line 1',
      `[${T2}] [stdout] ok`,
    ].join('\n'))
    expect(renderEntries(entries)).toBe(
      `[${T1}] [stderr] Error: boom\n    at stack line 1\n[${T2}] [stdout] ok`,
    )
  })
})
