import fs from 'node:fs'
import fsPromise from 'node:fs/promises'
import path from 'node:path'
import { EOL } from 'node:os'
import { formatWithOptions } from 'node:util'
import { createRequire } from 'node:module'
import {
  LOG_FILE_PREFIX,
  LOG_FILE_SUFFIX,
  LOG_FILE_CAPACITY,
  LOG_FILE_MAX_BYTES,
} from './defaults.js'

export interface PipeResult {
  logFilePath: string
  logFile: fs.WriteStream
  stdoutWrite: typeof process.stdout.write
  stderrWrite: typeof process.stderr.write
  restore: () => void
}

export interface EvacuationResult {
  logFilePath: string
  deletedLogFile?: string
  logfilesCapacity: number
}

export async function getNewLogfileByEvacuatingOldLogsIfNeeded(logPath: string): Promise<EvacuationResult> {
  try {
    await fsPromise.mkdir(logPath, { recursive: true })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== 'EEXIST') throw e
  }
  const entries = await fsPromise.readdir(logPath, { withFileTypes: true })
  const logFiles = entries.filter(
    entry => entry.isFile() && entry.name.startsWith(LOG_FILE_PREFIX) && entry.name.endsWith(LOG_FILE_SUFFIX),
  )
  let deletedLogFile: string | undefined
  if (logFiles.length >= LOG_FILE_CAPACITY) {
    const logFileToDelete = logFiles.map(f => f.name).sort()[0]!
    deletedLogFile = logFileToDelete
    await fsPromise.rm(path.join(logPath, logFileToDelete))
  }
  const newName = `${LOG_FILE_PREFIX}${new Date().toISOString().replace(/:/g, '-')}${LOG_FILE_SUFFIX}`
  return {
    logFilePath: path.join(logPath, newName),
    deletedLogFile,
    logfilesCapacity: LOG_FILE_CAPACITY,
  }
}

interface DebugModule {
  inspectOpts: { colors?: boolean; hideDate?: boolean; depth?: number }
  log: (...args: unknown[]) => void
}

function resolvePkcLoggerDebug(): DebugModule | null {
  try {
    const pkcLoggerPkg = createRequire(import.meta.url).resolve('@pkcprotocol/pkc-logger/package.json')
    const pkcLoggerRequire = createRequire(pkcLoggerPkg)
    return pkcLoggerRequire('debug') as DebugModule
  } catch {
    return null
  }
}

function resolveLocalDebug(): DebugModule | null {
  try {
    return createRequire(import.meta.url)('debug') as DebugModule
  } catch {
    return null
  }
}

export async function pipeDebugLogsToLogFile(logPath: string): Promise<PipeResult> {
  const { logFilePath } = await getNewLogfileByEvacuatingOldLogsIfNeeded(logPath)
  const logFile = fs.createWriteStream(logFilePath, { flags: 'a' })
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)

  const isLogFileOverLimit = (): boolean => logFile.bytesWritten > LOG_FILE_MAX_BYTES

  const writeTimestampedLine = (text: string, stream: 'stdout' | 'stderr'): void => {
    if (isLogFileOverLimit()) return
    if (!text || text.trim().length === 0) return
    const timestamp = `[${new Date().toISOString()}] [${stream}] `
    const lines = text.split('\n')
    const timestamped = lines.map((line, i) => (i === 0 ? timestamp + line : line)).join('\n')
    logFile.write(timestamped)
  }

  const asString = (data: unknown): string =>
    typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString()

  // Hijack debug modules so pkc-logger output is written directly to the log file
  // with a single [ISO] [stderr] timestamp, instead of going through stderr.write
  // (which would double-timestamp or pick up debug's own date prefix).
  const debugModules: DebugModule[] = []
  const pkcLoggerDebug = resolvePkcLoggerDebug()
  if (pkcLoggerDebug) debugModules.push(pkcLoggerDebug)
  const localDebug = resolveLocalDebug()
  if (localDebug && localDebug !== pkcLoggerDebug) debugModules.push(localDebug)

  const originalDebugLogs = debugModules.map(m => m.log)
  for (const mod of debugModules) {
    mod.inspectOpts.colors = true
    mod.inspectOpts.hideDate = true
    mod.log = (...args: unknown[]) => {
      const depth = mod.inspectOpts.depth ?? 10
      writeTimestampedLine(
        formatWithOptions({ depth, colors: true }, ...(args as [unknown, ...unknown[]])).trimStart() + EOL,
        'stderr',
      )
    }
  }

  // Tee stdout: write to original terminal AND log file
  process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
    const res = stdoutWrite(...args)
    writeTimestampedLine(asString(args[0]), 'stdout')
    return res
  }) as typeof process.stdout.write

  // Suppress stderr on terminal — everything goes to log file only.
  // Real errors bypass this via uncaughtException/unhandledRejection handlers that
  // write directly to the pre-hijack stderrWrite.
  process.stderr.write = ((...args: Parameters<typeof process.stderr.write>) => {
    writeTimestampedLine(asString(args[0]).trimStart(), 'stderr')
    return true
  }) as typeof process.stderr.write

  const writeErrorToTerminal = (err: unknown): void => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err)
    stderrWrite(msg + EOL)
  }

  const uncaughtExceptionHandler = (err: Error): void => {
    writeErrorToTerminal(err)
    console.error(err)
  }
  const unhandledRejectionHandler = (err: unknown): void => {
    writeErrorToTerminal(err)
    console.error(err)
  }
  process.on('uncaughtException', uncaughtExceptionHandler)
  process.on('unhandledRejection', unhandledRejectionHandler)

  const exitHandler = (): void => logFile.close()
  process.on('exit', exitHandler)

  const restore = (): void => {
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
    for (let i = 0; i < debugModules.length; i++) {
      debugModules[i]!.log = originalDebugLogs[i]!
    }
    process.off('uncaughtException', uncaughtExceptionHandler)
    process.off('unhandledRejection', unhandledRejectionHandler)
    process.off('exit', exitHandler)
  }

  return { logFilePath, logFile, stdoutWrite, stderrWrite, restore }
}
