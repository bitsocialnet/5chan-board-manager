import { Args, Command, Flags } from '@oclif/core'
import { createInterface } from 'node:readline/promises'
import { loadConfig, saveBoardConfig } from '../../config-manager.js'
import { validateBoardAddress } from '../../board-validator.js'
import { isNonExistentFlagsError } from '../../parse-utils.js'
import {
  applyCommunityDefaultsToBoard,
  BoardManagerSettingsSchema,
  CommunityDefaultsPresetBaseSchema,
  formatZodIssues,
  getCommunityDefaultsPreset,
  getParseCommunityEditOptions,
  loadCommunityDefaultsPreset,
  loadCommunityDefaultsPresetRaw,
} from '../../community-defaults.js'
import type { CommunityDefaultsPreset } from '../../community-defaults.js'
import type { BoardConfig } from '../../types.js'
import { flattenPreset, formatPresetDisplay, openPresetInEditor, parsePresetJsonc } from '../../preset-editor.js'

type ApplyDefaultsDecision = 'apply' | 'skip' | 'interactive'

export default class BoardAdd extends Command {
  static override args = {
    address: Args.string({
      description: 'Board address to add',
      required: true,
    }),
  }

  static override description = `Add a board to the config

Preset defaults behavior:
  --apply-defaults              Apply all preset defaults silently (no prompts)
  --skip-apply-defaults         Skip preset defaults silently
  --interactive-apply-defaults  Review defaults, accept all, modify in $EDITOR, or skip (requires TTY)
  Interactive TTY (no flags)    Same as --interactive-apply-defaults: shows [A]ccept / [M]odify / [S]kip
  Non-interactive (no flags)    Errors; requires --apply-defaults or --skip-apply-defaults

When choosing [M]odify, the preset opens in your editor ($VISUAL > $EDITOR > vi/notepad).
Modified presets are validated before applying; invalid changes fail the command.

Note: "board add" only accepts 5chan settings flags (pagination, bump limits, archiving).
To set board settings (title, description, rules, etc.), use a WebUI or bitsocial-cli:
https://github.com/bitsocialhq/bitsocial-cli#bitsocial-community-edit-address`

  static override examples = [
    '5chan board add random.bso',
    '5chan board add tech.bso --bump-limit 500',
    '5chan board add flash.bso --per-page 30 --pages 1',
    '5chan board add my-board.bso --rpc-url ws://custom-host:9138',
    '5chan board add my-board.bso --apply-defaults',
    '5chan board add my-board.bso --skip-apply-defaults',
    '5chan board add my-board.bso --interactive-apply-defaults',
    '5chan board add my-board.bso --apply-defaults --defaults-preset ./my-preset.json',
  ]

  static override flags = {
    'rpc-url': Flags.string({
      description: 'PKC RPC WebSocket URL (for validation)',
      env: 'PKC_RPC_WS_URL',
      default: 'ws://localhost:9138',
    }),
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
    'apply-defaults': Flags.boolean({
      description: 'Apply preset defaults silently (no prompts)',
    }),
    'skip-apply-defaults': Flags.boolean({
      description: 'Skip applying preset defaults',
    }),
    'interactive-apply-defaults': Flags.boolean({
      description: 'Interactively review and modify preset defaults before applying',
    }),
    'defaults-preset': Flags.file({
      description: 'Path to a custom preset JSON file',
      exists: true,
    }),
  }

  protected isInteractive(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY)
  }

  protected resolveApplyDefaultsDecision(
    applyDefaultsFlag: boolean,
    skipApplyDefaultsFlag: boolean,
    interactiveApplyDefaultsFlag: boolean,
  ): ApplyDefaultsDecision {
    const flagCount = [applyDefaultsFlag, skipApplyDefaultsFlag, interactiveApplyDefaultsFlag]
      .filter(Boolean).length

    if (flagCount > 1) {
      this.error(
        'Only one of --apply-defaults, --skip-apply-defaults, or --interactive-apply-defaults may be used',
      )
    }

    if (applyDefaultsFlag) return 'apply'
    if (skipApplyDefaultsFlag) return 'skip'
    if (interactiveApplyDefaultsFlag) {
      if (!this.isInteractive()) {
        this.error('--interactive-apply-defaults requires an interactive terminal (TTY)')
      }
      return 'interactive'
    }

    if (!this.isInteractive()) {
      this.error(
        'Non-interactive mode requires --apply-defaults or --skip-apply-defaults',
      )
    }

    return 'interactive'
  }

  protected async promptInteractiveDefaults(
    address: string,
    preset: CommunityDefaultsPreset,
    rawJsonc: string,
  ): Promise<CommunityDefaultsPreset | 'skip'> {
    const entries = flattenPreset(preset)
    const display = formatPresetDisplay(address, entries)
    this.log(display)
    this.log('')

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      for (;;) {
        const answer = (await rl.question(
          '[A]ccept all / [M]odify / [S]kip (A): ',
        )).trim().toLowerCase()

        if (answer === '' || answer === 'a' || answer === 'accept') return preset
        if (answer === 's' || answer === 'skip') return 'skip'
        if (answer === 'm' || answer === 'modify') {
          rl.close()
          return this.openAndValidatePreset(rawJsonc)
        }

        this.log('Please answer "a", "m", or "s".')
      }
    } finally {
      rl.close()
    }
  }

  protected async openAndValidatePreset(
    rawJsonc: string,
  ): Promise<CommunityDefaultsPreset> {
    const rawContent = await openPresetInEditor(rawJsonc)

    let parsed: unknown
    try {
      parsed = parsePresetJsonc(rawContent)
    } catch (err) {
      this.error(`Invalid JSON in edited preset: ${(err as Error).message}`)
    }

    const baseResult = CommunityDefaultsPresetBaseSchema.safeParse(parsed)
    if (!baseResult.success) {
      this.error(`Invalid preset structure: ${formatZodIssues(baseResult.error)}`)
    }

    const bmResult = BoardManagerSettingsSchema.safeParse(baseResult.data.boardManagerSettings)
    if (!bmResult.success) {
      this.error(`Invalid boardManagerSettings: ${formatZodIssues(bmResult.error)}`)
    }

    const parseCommunityEditOptions = await getParseCommunityEditOptions()
    try {
      parseCommunityEditOptions(baseResult.data.boardSettings as Parameters<typeof parseCommunityEditOptions>[0])
    } catch (err) {
      this.error(`Invalid boardSettings: ${(err as Error).message}`)
    }

    return {
      boardSettings: baseResult.data.boardSettings as CommunityDefaultsPreset['boardSettings'],
      boardManagerSettings: bmResult.data,
    }
  }

  private async parseWithUnknownFlagCheck() {
    try {
      return await this.parse(BoardAdd)
    } catch (err) {
      if (isNonExistentFlagsError(err)) {
        this.error(
          `Unknown option${err.flags.length === 1 ? '' : 's'}: ${err.flags.join(', ')}\n\n` +
          '"board add" only manages 5chan settings (pagination, bump limits, archiving).\n' +
          'Valid flags: --per-page, --pages, --bump-limit, --archive-purge-seconds,\n' +
          '  --apply-defaults, --skip-apply-defaults, --interactive-apply-defaults, --defaults-preset, --rpc-url\n\n' +
          'To set board settings (title, description, rules, etc.), use a WebUI or bitsocial-cli:\n' +
          'https://github.com/bitsocialhq/bitsocial-cli#bitsocial-community-edit-address'
        )
      }
      throw err
    }
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parseWithUnknownFlagCheck()
    const configDir = this.config.configDir

    await validateBoardAddress(args.address, flags['rpc-url'])

    // Early duplicate check — fail before interactive prompts or RPC edits
    const config = loadConfig(configDir)
    if (config.boards.some((b) => b.address === args.address)) {
      this.error(`Board "${args.address}" already exists in config`)
    }

    const basePresetRaw = loadCommunityDefaultsPresetRaw(
      flags['defaults-preset'] ?? undefined,
    )
    const basePreset = flags['defaults-preset']
      ? await loadCommunityDefaultsPreset(flags['defaults-preset'])
      : await getCommunityDefaultsPreset()

    const decision = this.resolveApplyDefaultsDecision(
      flags['apply-defaults'],
      flags['skip-apply-defaults'],
      flags['interactive-apply-defaults'],
    )

    let preset: CommunityDefaultsPreset | undefined

    if (decision === 'apply') {
      preset = basePreset
    } else if (decision === 'interactive') {
      const result = await this.promptInteractiveDefaults(args.address, basePreset, basePresetRaw)
      preset = result === 'skip' ? undefined : result
    }

    if (preset) {
      const applyResult = await applyCommunityDefaultsToBoard(args.address, flags['rpc-url'], preset)
      if (applyResult.applied) {
        this.log(
          `Applied board settings defaults (${applyResult.changedFields.join(', ')}) to "${args.address}"`,
        )
      } else {
        this.log(`Board settings defaults already present on "${args.address}"`)
      }
    } else {
      this.log(`Skipped applying preset defaults to "${args.address}"`)
    }

    const board: BoardConfig = { address: args.address }
    if (preset) {
      const boardManagerDefaults = preset.boardManagerSettings
      if (boardManagerDefaults.perPage !== undefined) board.perPage = boardManagerDefaults.perPage
      if (boardManagerDefaults.pages !== undefined) board.pages = boardManagerDefaults.pages
      if (boardManagerDefaults.bumpLimit !== undefined) board.bumpLimit = boardManagerDefaults.bumpLimit
      if (boardManagerDefaults.archivePurgeSeconds !== undefined) {
        board.archivePurgeSeconds = boardManagerDefaults.archivePurgeSeconds
      }
      if (boardManagerDefaults.moderationReasons !== undefined) {
        board.moderationReasons = boardManagerDefaults.moderationReasons
      }
    }
    if (flags['per-page'] !== undefined) board.perPage = flags['per-page']
    if (flags.pages !== undefined) board.pages = flags.pages
    if (flags['bump-limit'] !== undefined) board.bumpLimit = flags['bump-limit']
    if (flags['archive-purge-seconds'] !== undefined) board.archivePurgeSeconds = flags['archive-purge-seconds']

    saveBoardConfig(configDir, board)

    this.log(`Added board "${args.address}" to ${configDir}`)
  }
}
