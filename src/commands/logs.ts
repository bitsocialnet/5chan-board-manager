import { Flags, Command } from '@oclif/core'
import fs from 'node:fs'
import fsPromise from 'node:fs/promises'
import path from 'node:path'
import { LOG_PATH, LOG_FILE_PREFIX, LOG_FILE_SUFFIX } from '../defaults.js'
import {
  parseLogEntries,
  filterByTimeRange,
  filterByStream,
  tailEntries,
  parseTimestamp,
  renderEntries,
  type LogStream,
} from '../log-parser.js'

export default class Logs extends Command {
  static override description = 'View the latest 5chan daemon log file. By default dumps the full log and exits. Use --follow to stream new output in real-time (like tail -f).'

  static override flags = {
    follow: Flags.boolean({
      char: 'f',
      description: 'Follow log output in real-time (like tail -f)',
      default: false,
    }),
    tail: Flags.string({
      char: 'n',
      description: 'Number of log entries to show from the end. Use "all" to show everything.',
      default: 'all',
    }),
    since: Flags.string({
      description: 'Show logs since timestamp (ISO 8601, e.g. 2026-01-02T13:23:37Z) or relative time (e.g. 30s, 42m, 2h, 1d)',
      required: false,
    }),
    until: Flags.string({
      description: 'Show logs before timestamp (ISO 8601, e.g. 2026-01-02T13:23:37Z) or relative time (e.g. 30s, 42m, 2h, 1d)',
      required: false,
    }),
    logPath: Flags.directory({
      description: 'Specify the directory containing log files',
      required: false,
    }),
    stdout: Flags.boolean({
      description: 'Show only stdout log entries',
      default: false,
      exclusive: ['stderr'],
    }),
    stderr: Flags.boolean({
      description: 'Show only stderr log entries (output of pkc-logger library)',
      default: false,
      exclusive: ['stdout'],
    }),
  }

  static override examples = [
    '5chan logs',
    '5chan logs -f',
    '5chan logs -n 50',
    '5chan logs --since 5m',
    '5chan logs --since 2026-01-02T13:23:37Z --until 2026-01-02T14:00:00Z',
    '5chan logs --since 1h -f',
    '5chan logs --stdout',
    '5chan logs --stderr',
    '5chan logs --stdout -f',
  ]

  async _findLatestLogFile(logPath: string): Promise<string> {
    let entries
    try {
      entries = await fsPromise.readdir(logPath, { withFileTypes: true })
    } catch {
      this.error(`Log directory does not exist: ${logPath}\nHave you started the daemon yet?`)
    }
    const logFiles = entries
      .filter(entry => entry.isFile() && entry.name.startsWith(LOG_FILE_PREFIX) && entry.name.endsWith(LOG_FILE_SUFFIX))
      .map(entry => entry.name)
      .sort()
    if (logFiles.length === 0) {
      this.error(`No log files found in ${logPath}\nHave you started the daemon yet?`)
    }
    return path.join(logPath, logFiles[logFiles.length - 1]!)
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Logs)
    const logPath = flags.logPath ?? LOG_PATH
    const latestLogFile = await this._findLatestLogFile(logPath)

    let since: Date | undefined
    let until: Date | undefined
    try {
      since = flags.since ? parseTimestamp(flags.since) : undefined
      until = flags.until ? parseTimestamp(flags.until) : undefined
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }

    const streamFilter: LogStream | undefined = flags.stdout ? 'stdout' : flags.stderr ? 'stderr' : undefined

    if (!flags.follow) {
      const content = await fsPromise.readFile(latestLogFile, 'utf-8')
      const entries = parseLogEntries(content)
      const filtered = filterByTimeRange(entries, since, until)
      const streamFiltered = streamFilter ? filterByStream(filtered, streamFilter) : filtered
      let tailed
      try {
        tailed = tailEntries(streamFiltered, flags.tail)
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err))
      }
      const output = renderEntries(tailed)
      if (output) process.stdout.write(output + '\n')
      return
    }

    // Follow mode
    let currentLogFile = latestLogFile
    const existingContent = await fsPromise.readFile(currentLogFile, 'utf-8')
    const entries = parseLogEntries(existingContent)
    const filtered = filterByTimeRange(entries, since, until)
    const streamFiltered = streamFilter ? filterByStream(filtered, streamFilter) : filtered
    let tailed
    try {
      tailed = tailEntries(streamFiltered, flags.tail)
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    const initialOutput = renderEntries(tailed)
    if (initialOutput) process.stdout.write(initialOutput + '\n')

    const stat = await fsPromise.stat(currentLogFile)
    let position = stat.size
    let pendingBuffer = ''

    const readNewData = async (): Promise<void> => {
      try {
        const currentStat = await fsPromise.stat(currentLogFile)
        if (currentStat.size > position) {
          const fd = await fsPromise.open(currentLogFile, 'r')
          const buf = new Uint8Array(currentStat.size - position)
          const { bytesRead } = await fd.read(buf, 0, buf.length, position)
          await fd.close()
          position += bytesRead
          const chunk = pendingBuffer + new TextDecoder().decode(buf.subarray(0, bytesRead))
          const lastNewline = chunk.lastIndexOf('\n')
          if (lastNewline === -1) {
            pendingBuffer = chunk
            return
          }
          pendingBuffer = chunk.slice(lastNewline + 1)
          const completeText = chunk.slice(0, lastNewline + 1)
          if (!since && !until && !streamFilter) {
            process.stdout.write(completeText)
          } else {
            const newEntries = parseLogEntries(completeText.replace(/\n$/, ''))
            const filteredNew = filterByTimeRange(newEntries, since, until)
            const streamFilteredNew = streamFilter ? filterByStream(filteredNew, streamFilter) : filteredNew
            const output = renderEntries(streamFilteredNew)
            if (output) process.stdout.write(output + '\n')
          }
        }
      } catch {
        /* file may have been rotated or deleted */
      }
    }

    const checkForNewLogFile = async (): Promise<void> => {
      try {
        const newestFile = await this._findLatestLogFile(logPath)
        if (newestFile === currentLogFile) return

        if (pendingBuffer) {
          if (!since && !until && !streamFilter) {
            process.stdout.write(pendingBuffer + '\n')
          } else {
            const pbEntries = parseLogEntries(pendingBuffer)
            const pbFiltered = filterByTimeRange(pbEntries, since, until)
            const pbStreamFiltered = streamFilter ? filterByStream(pbFiltered, streamFilter) : pbFiltered
            const pbOutput = renderEntries(pbStreamFiltered)
            if (pbOutput) process.stdout.write(pbOutput + '\n')
          }
        }

        fs.unwatchFile(currentLogFile, readNewData)
        currentLogFile = newestFile
        pendingBuffer = ''
        process.stderr.write(`\n--- switched to new log file: ${path.basename(newestFile)} ---\n\n`)

        const newContent = await fsPromise.readFile(currentLogFile, 'utf-8')
        if (newContent) {
          if (!since && !until && !streamFilter) {
            process.stdout.write(newContent)
          } else {
            const newEntries = parseLogEntries(newContent.replace(/\n$/, ''))
            const filteredNew = filterByTimeRange(newEntries, since, until)
            const streamFilteredNew = streamFilter ? filterByStream(filteredNew, streamFilter) : filteredNew
            const output = renderEntries(streamFilteredNew)
            if (output) process.stdout.write(output + '\n')
          }
        }

        const newStat = await fsPromise.stat(currentLogFile)
        position = newStat.size
        fs.watchFile(currentLogFile, { interval: 300 }, readNewData)
      } catch {
        /* directory listing failed or file disappeared — retry next cycle */
      }
    }

    fs.watchFile(currentLogFile, { interval: 300 }, readNewData)
    const newFileCheckInterval = setInterval(checkForNewLogFile, 3000)

    const cleanup = (): void => {
      clearInterval(newFileCheckInterval)
      fs.unwatchFile(currentLogFile, readNewData)
      process.exit(0)
    }
    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)

    await new Promise<void>(() => {})
  }
}
