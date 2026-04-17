import { Args, Command, Flags } from '@oclif/core'
import { loadBoardConfig, boardConfigPath, saveBoardConfig, updateBoardConfig } from '../../config-manager.js'
import { isNonExistentFlagsError } from '../../parse-utils.js'
import { openInEditor } from '../../preset-editor.js'
import { BoardManagerSettingsSchema, formatZodIssues } from '../../community-defaults.js'
import type { BoardConfig } from '../../types.js'

/** Maps kebab-case CLI flag names to camelCase BoardConfig field names */
const RESETTABLE_FIELDS: Record<string, keyof Omit<BoardConfig, 'address'>> = {
  'per-page': 'perPage',
  'pages': 'pages',
  'bump-limit': 'bumpLimit',
  'archive-purge-seconds': 'archivePurgeSeconds',
  'moderation-reasons': 'moderationReasons',
}

export default class BoardEdit extends Command {
  static override args = {
    address: Args.string({
      description: 'Board address to edit',
      required: true,
    }),
  }

  static override description = `Edit 5chan settings for an existing board

This command configures how 5chan manages the board (pagination, bump limits, archiving).
Use --interactive (-i) to open the board config in $EDITOR for direct viewing/editing.
To edit board settings (title, description, rules, etc.), use a WebUI or bitsocial-cli:
https://github.com/bitsocialnet/bitsocial-cli#bitsocial-community-edit-address`

  static override examples = [
    '5chan board edit tech.bso --bump-limit 500',
    '5chan board edit flash.bso --per-page 30 --pages 1',
    '5chan board edit random.bso --reset per-page,bump-limit',
    '5chan board edit random.bso --per-page 20 --reset bump-limit',
    '5chan board edit random.bso --reset moderation-reasons',
    '5chan board edit random.bso --interactive',
    '5chan board edit random.bso -i',
  ]

  static override flags = {
    'per-page': Flags.integer({
      description: 'Posts per page',
    }),
    pages: Flags.integer({
      description: 'Number of pages',
    }),
    'bump-limit': Flags.integer({
      description: 'Bump limit for threads',
    }),
    'archive-purge-seconds': Flags.integer({
      description: 'Seconds after archiving before purge',
    }),
    reset: Flags.string({
      description: 'Comma-separated fields to reset to defaults (per-page, pages, bump-limit, archive-purge-seconds, moderation-reasons)',
    }),
    interactive: Flags.boolean({
      char: 'i',
      description: 'Open the board config in $EDITOR for interactive editing',
      exclusive: ['per-page', 'pages', 'bump-limit', 'archive-purge-seconds', 'reset'],
    }),
  }

  private async parseWithUnknownFlagCheck() {
    try {
      return await this.parse(BoardEdit)
    } catch (err) {
      if (isNonExistentFlagsError(err)) {
        this.error(
          `Unknown option${err.flags.length === 1 ? '' : 's'}: ${err.flags.join(', ')}\n\n` +
          '"board edit" only manages 5chan settings (pagination, bump limits, archiving).\n' +
          'Valid flags: --per-page, --pages, --bump-limit, --archive-purge-seconds, --reset, --interactive\n\n' +
          'To edit board settings (title, description, rules, etc.), use a WebUI or bitsocial-cli:\n' +
          'https://github.com/bitsocialnet/bitsocial-cli#bitsocial-community-edit-address'
        )
      }
      throw err
    }
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parseWithUnknownFlagCheck()
    const configDir = this.config.configDir

    const filePath = boardConfigPath(configDir, args.address)
    let board: BoardConfig
    try {
      board = loadBoardConfig(filePath)
    } catch {
      this.error(`Board "${args.address}" not found in config`)
    }

    if (flags.interactive) {
      await this.runInteractive(board, configDir)
      return
    }

    const updates: Partial<Omit<BoardConfig, 'address'>> = {}
    if (flags['per-page'] !== undefined) updates.perPage = flags['per-page']
    if (flags.pages !== undefined) updates.pages = flags.pages
    if (flags['bump-limit'] !== undefined) updates.bumpLimit = flags['bump-limit']
    if (flags['archive-purge-seconds'] !== undefined) updates.archivePurgeSeconds = flags['archive-purge-seconds']

    let resetFields: Array<keyof Omit<BoardConfig, 'address'>> | undefined
    if (flags.reset) {
      const names = flags.reset.split(',').map((s) => s.trim())
      resetFields = []
      for (const name of names) {
        const field = RESETTABLE_FIELDS[name]
        if (!field) {
          this.error(`Unknown field "${name}" in --reset. Valid fields: ${Object.keys(RESETTABLE_FIELDS).join(', ')}`)
        }
        resetFields.push(field)
      }
    }

    if (Object.keys(updates).length === 0 && (!resetFields || resetFields.length === 0)) {
      this.error('At least one flag (--per-page, --pages, --bump-limit, --archive-purge-seconds, --interactive) or --reset must be provided')
    }

    const updated = updateBoardConfig(board, updates, resetFields)
    saveBoardConfig(configDir, updated)

    this.log(`Updated board "${args.address}" in ${configDir}`)
  }

  private async runInteractive(board: BoardConfig, configDir: string): Promise<void> {
    const { address, ...settings } = board
    const json = JSON.stringify(settings, null, 2) + '\n'

    const edited = await openInEditor(json)

    let parsed: unknown
    try {
      parsed = JSON.parse(edited)
    } catch (err) {
      this.error(`Invalid JSON: ${(err as Error).message}`)
    }

    const result = BoardManagerSettingsSchema.safeParse(parsed)
    if (!result.success) {
      this.error(`Invalid config: ${formatZodIssues(result.error)}`)
    }

    const updated: BoardConfig = { address, ...result.data }
    saveBoardConfig(configDir, updated)

    this.log(`Updated board "${address}" in ${configDir}`)
  }
}
