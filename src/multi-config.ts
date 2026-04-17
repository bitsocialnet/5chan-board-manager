import { join } from 'node:path'
import { loadConfig } from './config-manager.js'
import type { BoardManagerOptions, BoardConfig, ModerationReasons, MultiBoardConfig } from './types.js'

/**
 * Load and validate a multi-board config from a config directory.
 * Throws if no boards are configured.
 */
export function loadMultiConfig(configDir: string): MultiBoardConfig {
  const config = loadConfig(configDir)

  if (config.boards.length === 0) {
    throw new Error(`Config directory "${configDir}": no board config files found in boards/`)
  }

  return config
}

/**
 * Merge a board config with top-level defaults and rpcUrl
 * to produce BoardManagerOptions for startBoardManager().
 *
 * Only sets fields that are explicitly configured — undefined fields
 * let startBoardManager's built-in DEFAULTS remain the source of truth.
 */
export function resolveBoardManagerOptions(board: BoardConfig, config: MultiBoardConfig, configDir: string): BoardManagerOptions {
  const rpcUrl = config.rpcUrl ?? process.env.PKC_RPC_WS_URL ?? 'ws://localhost:9138'

  const boardReasons = board.moderationReasons
  const defaultReasons = config.defaults?.moderationReasons
  let moderationReasons: ModerationReasons | undefined
  if (boardReasons || defaultReasons) {
    moderationReasons = {
      archiveCapacity: boardReasons?.archiveCapacity ?? defaultReasons?.archiveCapacity,
      archiveBumpLimit: boardReasons?.archiveBumpLimit ?? defaultReasons?.archiveBumpLimit,
      purgeArchived: boardReasons?.purgeArchived ?? defaultReasons?.purgeArchived,
      purgeDeleted: boardReasons?.purgeDeleted ?? defaultReasons?.purgeDeleted,
    }
  }

  return {
    communityAddress: board.address,
    pkcRpcUrl: rpcUrl,
    boardDir: join(configDir, 'boards', board.address),
    userAgent: config.userAgent,
    perPage: board.perPage ?? config.defaults?.perPage,
    pages: board.pages ?? config.defaults?.pages,
    bumpLimit: board.bumpLimit ?? config.defaults?.bumpLimit,
    archivePurgeSeconds: board.archivePurgeSeconds ?? config.defaults?.archivePurgeSeconds,
    moderationReasons,
  }
}
