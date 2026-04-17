import Logger from '@pkcprotocol/pkc-logger'
import { join } from 'node:path'
import { renameSync } from 'node:fs'
import { startBoardManager } from './board-manager.js'
import { resolveBoardManagerOptions } from './multi-config.js'
import type { BoardManagerResult, MultiBoardConfig, MultiBoardResult } from './types.js'

const log = Logger('5chan:board-manager:multi')

/**
 * Start board managers for all boards in the config.
 *
 * Boards are started sequentially to avoid overwhelming the RPC server.
 * If a board fails to start, the error is recorded and remaining boards continue.
 * If ALL boards fail, throws an AggregateError.
 */
export async function startMultiBoardManager(config: MultiBoardConfig, configDir: string): Promise<MultiBoardResult> {
  const boardManagers = new Map<string, BoardManagerResult>()
  const errors = new Map<string, Error>()
  let stopping = false

  function onAddressChange(oldAddress: string, newAddress: string): void {
    const manager = boardManagers.get(oldAddress)
    if (manager) {
      boardManagers.delete(oldAddress)
      boardManagers.set(newAddress, manager)
    }
    const error = errors.get(oldAddress)
    if (error) {
      errors.delete(oldAddress)
      errors.set(newAddress, error)
    }

    // Rename board directory
    renameSync(join(configDir, 'boards', oldAddress), join(configDir, 'boards', newAddress))

    log(`board address changed: ${oldAddress} → ${newAddress}`)
  }

  for (const board of config.boards) {
    if (stopping) {
      log(`skipping ${board.address} — shutdown requested`)
      break
    }

    const options = resolveBoardManagerOptions(board, config, configDir)
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

  return {
    boardManagers,
    errors,
    async stop() {
      stopping = true
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
