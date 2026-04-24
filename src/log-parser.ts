export type LogStream = 'stdout' | 'stderr'

export interface LogEntry {
  timestamp: Date | null
  stream: LogStream | null
  lines: string[]
}

const TIMESTAMP_RE = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] /
const TIMESTAMP_STREAM_RE = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[(stdout|stderr)\] /
const RELATIVE_RE = /^(\d+)([smhd])$/

const RELATIVE_MULTIPLIERS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

export function extractTimestamp(line: string): Date | null {
  const match = line.match(TIMESTAMP_RE)
  if (!match) return null
  return new Date(match[1]!)
}

export function extractStream(line: string): LogStream | null {
  const match = line.match(TIMESTAMP_STREAM_RE)
  if (!match) return null
  return match[1] as LogStream
}

export function parseLogEntries(content: string): LogEntry[] {
  const lines = content.split('\n')
  const entries: LogEntry[] = []
  for (const line of lines) {
    const timestamp = extractTimestamp(line)
    if (timestamp !== null) {
      const stream = extractStream(line)
      entries.push({ timestamp, stream, lines: [line] })
    } else if (entries.length > 0) {
      entries[entries.length - 1]!.lines.push(line)
    } else {
      entries.push({ timestamp: null, stream: null, lines: [line] })
    }
  }
  return entries
}

export function filterByTimeRange(entries: LogEntry[], since?: Date, until?: Date): LogEntry[] {
  return entries.filter(entry => {
    if (entry.timestamp === null) {
      return !since
    }
    if (since && entry.timestamp < since) return false
    if (until && entry.timestamp > until) return false
    return true
  })
}

export function filterByStream(entries: LogEntry[], stream: LogStream): LogEntry[] {
  return entries.filter(entry => entry.stream === stream)
}

export function tailEntries(entries: LogEntry[], tailValue: string): LogEntry[] {
  if (tailValue === 'all') return entries
  const n = parseInt(tailValue, 10)
  if (isNaN(n) || n < 0) {
    throw new Error(`Invalid --tail value: "${tailValue}". Must be a non-negative integer or "all".`)
  }
  if (n === 0) return []
  return entries.slice(-n)
}

export function parseTimestamp(value: string): Date {
  const relativeMatch = value.match(RELATIVE_RE)
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1]!, 10)
    const unit = relativeMatch[2]!
    const multiplier = RELATIVE_MULTIPLIERS[unit]!
    return new Date(Date.now() - amount * multiplier)
  }
  const date = new Date(value)
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: "${value}". Use ISO 8601 format (e.g. 2026-01-02T13:23:37Z) or relative time (e.g. 30s, 42m, 2h, 1d)`)
  }
  return date
}

export function renderEntries(entries: LogEntry[]): string {
  return entries.map(e => e.lines.join('\n')).join('\n')
}
