import { watch, mkdirSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import Logger from '@pkcprotocol/pkc-logger'
import { startBoardManager } from './board-manager.js'
import { loadConfig, globalConfigPath, renameBoardConfig } from './config-manager.js'
import { resolveBoardManagerOptions } from './multi-config.js'
import type { BoardManagerResult, MultiBoardConfig } from './types.js'

const log = Logger('5chan:board-manager')

export interface BoardManagers {
  readonly boardManagers: ReadonlyMap<string, BoardManagerResult>
  readonly errors: ReadonlyMap<string, Error>
  stop(): Promise<void>
}

/**
 * Start board managers that watch the config directory for changes.
 * Watches both boards/ directory and global.json for hot-reload.
 * On config change, diffs the old and new config, stops removed board managers,
 * and starts added board managers.
 */
export async function startBoardManagers(
  configDir: string,
  initialConfig: MultiBoardConfig,
): Promise<BoardManagers> {
  const boardManagers = new Map<string, BoardManagerResult>()
  const errors = new Map<string, Error>()
  let currentConfig = initialConfig
  let reloading = false
  let stopped = false

  function onAddressChange(oldAddress: string, newAddress: string): void {
    // Update boardManagers map key
    const manager = boardManagers.get(oldAddress)
    if (manager) {
      boardManagers.delete(oldAddress)
      boardManagers.set(newAddress, manager)
    }

    // Update errors map key
    const error = errors.get(oldAddress)
    if (error) {
      errors.delete(oldAddress)
      errors.set(newAddress, error)
    }

    // Update currentConfig.boards in-place so the next hot-reload diff
    // sees the new address and does not trigger a spurious remove+add
    const boardEntry = currentConfig.boards.find((b) => b.address === oldAddress)
    if (boardEntry) {
      boardEntry.address = newAddress
    }

    // Rename config file on disk
    try {
      renameBoardConfig(configDir, oldAddress, newAddress)
    } catch (err) {
      log.error(`failed to rename board config from ${oldAddress} to ${newAddress}: ${err}`)
    }

    log(`board address changed: ${oldAddress} → ${newAddress}`)
  }

  // Start initial board managers sequentially
  for (const board of initialConfig.boards) {
    const options = resolveBoardManagerOptions(board, initialConfig, configDir)
    try {
      log(`starting board manager for ${board.address}`)
      const result = await startBoardManager({ ...options, onAddressChange })
      boardManagers.set(board.address, result)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      log.error(`failed to start board manager for ${board.address}: ${error.message}`)
      errors.set(board.address, error)
    }
  }

  if (boardManagers.size === 0 && errors.size > 0) {
    throw new AggregateError(
      [...errors.values()],
      `All ${errors.size} board(s) failed to start`,
    )
  }

  async function handleConfigChange(): Promise<void> {
    if (reloading || stopped) return
    reloading = true

    try {
      let newConfig: MultiBoardConfig
      try {
        newConfig = loadConfig(configDir)
      } catch (err) {
        log.error(`failed to reload config: ${(err as Error).message}`)
        return
      }

      const { added, removed, changed } = diffConfigsWithGlobal(currentConfig, newConfig)

      if (added.length === 0 && removed.length === 0 && changed.length === 0) {
        currentConfig = newConfig
        return
      }

      // Stop removed board managers
      for (const address of removed) {
        const manager = boardManagers.get(address)
        if (manager) {
          try {
            log(`stopping board manager for removed board ${address}`)
            await manager.stop()
          } catch (err) {
            log.error(`failed to stop board manager for ${address}: ${err}`)
          }
          boardManagers.delete(address)
        }
        errors.delete(address)
      }

      // Restart changed board managers
      for (const board of changed) {
        const manager = boardManagers.get(board.address)
        if (manager) {
          try {
            log(`stopping board manager for changed board ${board.address}`)
            await manager.stop()
          } catch (err) {
            log.error(`failed to stop board manager for ${board.address}: ${err}`)
          }
          boardManagers.delete(board.address)
        }
        errors.delete(board.address)

        const options = resolveBoardManagerOptions(board, newConfig, configDir)
        try {
          log(`starting board manager for changed board ${board.address}`)
          const result = await startBoardManager({ ...options, onAddressChange })
          boardManagers.set(board.address, result)
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          log.error(`failed to start board manager for ${board.address}: ${error.message}`)
          errors.set(board.address, error)
        }
      }

      // Start added board managers
      for (const board of added) {
        const options = resolveBoardManagerOptions(board, newConfig, configDir)
        try {
          log(`starting board manager for added board ${board.address}`)
          const result = await startBoardManager({ ...options, onAddressChange })
          boardManagers.set(board.address, result)
          errors.delete(board.address)
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          log.error(`failed to start board manager for ${board.address}: ${error.message}`)
          errors.set(board.address, error)
        }
      }

      currentConfig = newConfig

      if (added.length > 0 || removed.length > 0 || changed.length > 0) {
        log(`config reloaded: +${added.length} added, -${removed.length} removed, ~${changed.length} changed, ${boardManagers.size} running`)
      }
    } finally {
      reloading = false
    }
  }

  // Watch config directory for changes with debounce
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  const watchers: FSWatcher[] = []

  function triggerReload(): void {
    if (stopped) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      handleConfigChange()
    }, 200)
  }

  // Watch boards/ directory — ensure it exists so the watcher works on first run
  const boardsDir = join(configDir, 'boards')
  mkdirSync(boardsDir, { recursive: true })
  watchers.push(watch(boardsDir, { recursive: true }, triggerReload))

  // Watch global.json
  const globalPath = globalConfigPath(configDir)
  try {
    watchers.push(watch(globalPath, triggerReload))
  } catch {
    log(`global.json does not exist yet, skipping watch`)
  }

  return {
    get boardManagers() {
      return boardManagers as ReadonlyMap<string, BoardManagerResult>
    },
    get errors() {
      return errors as ReadonlyMap<string, Error>
    },
    async stop() {
      stopped = true
      if (debounceTimer) clearTimeout(debounceTimer)
      for (const w of watchers) {
        w.close()
      }
      const results = await Promise.allSettled(
        [...boardManagers.entries()].map(async ([address, manager]) => {
          try {
            await manager.stop()
          } catch (err) {
            log.error(`error stopping board manager for ${address}: ${err}`)
            throw err
          }
        }),
      )
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failures.length > 0) {
        log.error(`${failures.length} board manager(s) failed to stop cleanly`)
      }
    },
  }
}

/**
 * Diff two configs, treating global config changes (rpcUrl, defaults)
 * as triggering all existing boards to be "changed" (restart needed).
 */
function diffConfigsWithGlobal(
  oldConfig: MultiBoardConfig,
  newConfig: MultiBoardConfig,
): { added: MultiBoardConfig['boards']; removed: string[]; changed: MultiBoardConfig['boards'] } {
  const oldAddresses = new Set(oldConfig.boards.map((b) => b.address))
  const newAddresses = new Set(newConfig.boards.map((b) => b.address))
  const oldByAddress = new Map(oldConfig.boards.map((b) => [b.address, b]))

  const added = newConfig.boards.filter((b) => !oldAddresses.has(b.address))
  const removed = oldConfig.boards
    .filter((b) => !newAddresses.has(b.address))
    .map((b) => b.address)

  // Check if global settings changed
  const globalChanged =
    oldConfig.rpcUrl !== newConfig.rpcUrl ||
    oldConfig.userAgent !== newConfig.userAgent ||
    JSON.stringify(oldConfig.defaults) !== JSON.stringify(newConfig.defaults)

  const changed: MultiBoardConfig['boards'] = []
  for (const newBoard of newConfig.boards) {
    const oldBoard = oldByAddress.get(newBoard.address)
    if (!oldBoard) continue // added, not changed

    if (globalChanged) {
      // Global config changed — restart all existing boards
      changed.push(newBoard)
    } else if (boardConfigChanged(oldBoard, newBoard)) {
      changed.push(newBoard)
    }
  }

  return { added, removed, changed }
}

function boardConfigChanged(a: MultiBoardConfig['boards'][number], b: MultiBoardConfig['boards'][number]): boolean {
  return (
    a.perPage !== b.perPage ||
    a.pages !== b.pages ||
    a.bumpLimit !== b.bumpLimit ||
    a.archivePurgeSeconds !== b.archivePurgeSeconds ||
    a.moderationReasons?.archiveCapacity !== b.moderationReasons?.archiveCapacity ||
    a.moderationReasons?.archiveBumpLimit !== b.moderationReasons?.archiveBumpLimit ||
    a.moderationReasons?.purgeArchived !== b.moderationReasons?.purgeArchived ||
    a.moderationReasons?.purgeDeleted !== b.moderationReasons?.purgeDeleted
  )
}
