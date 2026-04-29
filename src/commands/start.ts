import { Command, Flags } from '@oclif/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../config-manager.js'
import { startBoardManagers } from '../board-managers.js'
import { pipeDebugLogsToLogFile } from '../file-logger.js'
import { LOG_PATH } from '../defaults.js'

export default class Start extends Command {
  static override description = `Start board managers for all configured boards

Board managers enforce imageboard-style thread lifecycle rules on each board:
- Archive threads that exceed board capacity (perPage × pages)
- Archive threads that reach the bump limit
- Purge archived threads after the retention period expires
- Purge author-deleted threads and replies

The config directory is watched for changes; boards are hot-reloaded
(added, removed, or restarted) without requiring a full restart.

Daemon output is written to a rotated log file (default: ${LOG_PATH}).
View it with \`5chan logs\`. stderr is suppressed on the terminal; real
uncaught errors still reach the terminal.`

  static override examples = [
    '5chan start',
    '5chan start --config-dir /path/to/config',
    '5chan start --log-path /var/log/5chan',
  ]

  static override flags = {
    'config-dir': Flags.string({
      char: 'c',
      description: 'Path to config directory (overrides default)',
    }),
    'log-path': Flags.directory({
      description: 'Directory to store daemon log files',
      default: LOG_PATH,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Start)
    const configDir = flags['config-dir'] ?? this.config.configDir

    const skipFileLogging = process.env['VITEST'] === 'true'
    let logFilePath: string | undefined
    let logFile: Awaited<ReturnType<typeof pipeDebugLogsToLogFile>>['logFile'] | undefined
    let stdoutWrite: typeof process.stdout.write = process.stdout.write.bind(process.stdout)

    if (!skipFileLogging) {
      const piped = await pipeDebugLogsToLogFile(flags['log-path'])
      logFilePath = piped.logFilePath
      logFile = piped.logFile
      stdoutWrite = piped.stdoutWrite
      stdoutWrite(`To view logs, run: 5chan logs\n`)
      stdoutWrite(`For custom debug logging, restart with DEBUG env, e.g.: DEBUG='bitsocial:5chan-board-manager*,pkc*,pkc-js*' 5chan start\n`)
      stdoutWrite(`Daemon log file: ${logFilePath}\n`)
    }

    try {
      const config = loadConfig(configDir)

      if (config.boards.length === 0) {
        this.log('No boards configured. Waiting for boards to be added...')
        this.log('Use "5chan board add <address>" to add a board.')
      }

      this.log(`Starting board managers for ${config.boards.length} board(s)...`)
      this.log(`Config: ${configDir}`)
      this.log(`Watching config directory for changes`)

      const heartbeatPath = process.env['HEARTBEAT_FILE'] ?? join(flags['log-path'], 'heartbeat')
      const manager = await startBoardManagers(configDir, config, { heartbeatPath })

      const started = manager.boardManagers.size
      const failed = manager.errors.size
      this.log(`Started ${started} board manager(s)${failed > 0 ? `, ${failed} failed` : ''}`)
      for (const [address, err] of manager.errors) {
        this.warn(`FAILED: ${address} — ${err.message}`)
      }

      let shuttingDown = false

      const shutdown = async (): Promise<void> => {
        if (shuttingDown) return
        shuttingDown = true
        this.log('Shutting down...')
        await manager.stop()
        if (logFile) {
          await new Promise<void>(resolve => logFile!.end(() => resolve()))
        }
        process.exit(0)
      }

      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    } catch (err) {
      if (logFilePath) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        stdoutWrite(`\nDaemon failed to start: ${errorMsg}\n\n`)
        try {
          const logContent = readFileSync(logFilePath, 'utf-8')
          const lines = logContent.trimEnd().split('\n')
          const lastLines = lines.slice(-10).join('\n')
          stdoutWrite(`Last log lines:\n${lastLines}\n\n`)
        } catch {
          /* log file may not exist yet */
        }
        stdoutWrite(`Full log: ${logFilePath}\n`)
        stdoutWrite(`Or run: 5chan logs\n`)
      }
      throw err
    }
  }
}
