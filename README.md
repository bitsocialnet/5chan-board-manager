# 5chan Board Manager

A CLI tool that implements 4chan-style thread auto-archiving and purging for 5chan boards.

### Feature 1: Thread limit / auto-archive

- After each board update, determine thread positions in active sort
- Filter out pinned threads (they're exempt)
- Count non-pinned threads; any beyond position `per_page × pages` → archive via `createCommentModeration({ commentModeration: { archived: true } })`
- Archived threads are read-only (pkc-js already enforces this)

### Feature 2: Bump limit

- Track reply counts for active threads
- When a thread reaches `bump_limit` replies → archive it via `createCommentModeration({ commentModeration: { archived: true } })`

### Feature 3: Delayed purge

- Track when threads were archived
- After `archive_purge_seconds` has elapsed since archiving → purge via `createCommentModeration({ commentModeration: { purged: true } })`

### Feature 4: Author-deleted comment purging

- On each update, scan comments and replies for `deleted === true`
- Purge via `createCommentModeration({ commentModeration: { purged: true } })`
- Duplicate purge moderations (if the board hasn't processed prior purge yet) are harmless no-ops

### Config Directory Layout

Config and state are stored per-board under `~/.config/5chan/`, managed via `5chan board add/edit/remove` or manual editing:

```
~/.config/5chan/
├── global.json                    # shared settings (rpcUrl, defaults)
└── boards/
    ├── random.bso/
    │   ├── config.json            # { "address": "random.bso" }
    │   ├── state.json             # auto-created (signers, archivedThreads)
    │   └── state.json.lock        # transient lock file
    ├── tech.bso/
    │   └── config.json            # { "address": "tech.bso", "bumpLimit": 500 }
    ├── flash.bso/
    │   └── config.json            # { "address": "flash.bso", "perPage": 30, "pages": 1 }
    └── custom.bso/
        └── config.json            # { "address": "custom.bso", "moderationReasons": { ... } }
```

**global.json** (optional):
```json
{
  "rpcUrl": "ws://localhost:9138",
  "defaults": {
    "perPage": 15,
    "pages": 10,
    "bumpLimit": 300,
    "archivePurgeSeconds": 172800,
    "moderationReasons": {
      "archiveCapacity": "5chan board manager: thread archived — exceeded board capacity",
      "archiveBumpLimit": "5chan board manager: thread archived — reached bump limit",
      "purgeArchived": "5chan board manager: thread purged — archive retention expired",
      "purgeDeleted": "5chan board manager: content purged — author-deleted"
    }
  }
}
```

**Minimal config:** a single directory `boards/my-board.bso/config.json` containing `{ "address": "my-board.bso" }`

All fields except each board's `address` are optional:
- `rpcUrl` — falls back to `PKC_RPC_WS_URL` env var, then `ws://localhost:9138`
- `defaults` — applied to all boards unless overridden per-board
- Per-board fields (`perPage`, `pages`, `bumpLimit`, `archivePurgeSeconds`, `moderationReasons`) override `defaults`
- `moderationReasons` — optional object with `archiveCapacity`, `archiveBumpLimit`, `purgeArchived`, `purgeDeleted` string fields. Per-board values override defaults per-field (not the whole object). These reason strings are passed to `createCommentModeration()` so PKC clients can display why a thread was archived or purged.
- Board directory names must match the address field in `config.json`



## Installation

Docker is the only supported install path. The published image
(`ghcr.io/bitsocialnet/5chan-board-manager:latest`) is built and tested with the
bitsocial-cli version the default preset assumes, including the
`@bitsocial/spam-blocker-challenge` that the preset references. Running 5chan
outside Docker — or against a bitsocial-cli you manage yourself — is possible
but unsupported; you will have to keep the challenge and auth-key wiring in
sync by hand (see [Standalone](#standalone-bitsocial-cli-already-running) below).

### Docker Compose (recommended)

#### Full stack (with bitsocial-cli)

If you **don't** already have [bitsocial-cli](https://github.com/bitsocialnet/bitsocial-cli) running, use the full stack compose file which boots both bitsocial-cli (PKC RPC server) and 5chan together.:

```bash
wget -O docker-compose.yml https://raw.githubusercontent.com/bitsocialnet/5chan-board-manager/master/docker-compose.example.yml
docker compose up -d

# Install the spam-blocker challenge referenced by the default preset
# (skip this only if you also remove spam-blocker entries from your preset
# or always use --skip-apply-defaults):
docker compose exec bitsocial bitsocial challenge install @bitsocial/spam-blocker-challenge

# Now add boards via 5chan board add (see Config Directory Layout above)
```

See [`docker-compose.example.yml`](docker-compose.example.yml) for the full configuration.

#### Quick usage (Docker, full stack)

Use this flow to create a new board with `bitsocial-cli` and immediately add it to 5chan.

> **Note:** The compose file ships with a pre-configured RPC auth key so both containers can connect out of the box. For production, replace it with your own random string:
> ```bash
> sed -i "s/TFCh0joRU60KwlfVaprP2uenw7NCdAwsBCF5UDoVg/$(openssl rand -base64 32 | tr -d '/+=')/g" docker-compose.yml
> ```

> **Note:** The container starts gracefully even with no boards configured — it waits for boards to be added and picks them up automatically via config hot-reload.

```bash
wget -O docker-compose.yml https://raw.githubusercontent.com/bitsocialnet/5chan-board-manager/master/docker-compose.example.yml
docker compose up -d

# Install the spam-blocker challenge referenced by the default preset
docker compose exec bitsocial bitsocial challenge install @bitsocial/spam-blocker-challenge

# Create a community (copy the created address from output)
docker compose exec bitsocial bitsocial community create \
  --title "My Board title" \
  --description "My Board description"

# Add the created community to 5chan board manager
docker compose exec -it 5chan 5chan board add <community-address>

# Verify it was added
docker compose exec 5chan 5chan board list

# You can load the board now by its address in 5chan or any other web ui
```

#### Standalone (bitsocial-cli already running)

If you **already** have bitsocial-cli running separately (on the host, in another compose stack, etc.), use the standalone compose file which only runs 5chan:

```bash
cp docker-compose.standalone.example.yml docker-compose.yml
# Edit PKC_RPC_WS_URL in docker-compose.yml — replace YOUR-AUTH-KEY with
# your bitsocial-cli auth key (find it with: docker logs <bitsocial-container> 2>&1 | grep "secret auth key")
docker compose up -d
```

Set `PKC_RPC_WS_URL` to the address of your existing instance, **including the auth key** as a path segment:

- **bitsocial-cli on the host (no container):** Use `ws://host.docker.internal:9138/YOUR-AUTH-KEY`. The example compose file includes `extra_hosts: ["host.docker.internal:host-gateway"]` so this works on Linux, macOS, and Windows.
- **bitsocial-cli in another Docker container/network:** Use the container or service name, e.g. `ws://bitsocial:9138/YOUR-AUTH-KEY`, and make sure both containers share the same Docker network.

**You must install the spam-blocker challenge on your bitsocial-cli instance**, because the default preset (`src/presets/community-defaults.jsonc`) references it and `5chan board add --apply-defaults` will be rejected by the PKC RPC server if the challenge is missing:

```bash
bitsocial challenge install @bitsocial/spam-blocker-challenge
```

If you do not want this dependency, remove both `@bitsocial/spam-blocker-challenge` entries from your preset (they are marked optional in the file) or use `--skip-apply-defaults`.

See [`docker-compose.standalone.example.yml`](docker-compose.standalone.example.yml) for the configuration.

### Running commands inside Docker

Use `docker compose exec` to run additional `5chan` CLI commands inside the running container:

```bash
# Add a board
docker compose exec 5chan 5chan board add random.bso

# List configured boards
docker compose exec 5chan 5chan board list

# Edit a board's config
docker compose exec 5chan 5chan board edit random.bso --bump-limit 500

# Open a board's config in $EDITOR for interactive editing
docker compose exec 5chan 5chan board edit random.bso -i

# Reset a board field to global default
docker compose exec 5chan 5chan board edit random.bso --reset per-page

# Reset moderation reasons to defaults
docker compose exec 5chan 5chan board edit random.bso --reset moderation-reasons

# Set global defaults for all boards
docker compose exec 5chan 5chan defaults set --per-page 20 --bump-limit 500

# Open global defaults in $EDITOR for interactive editing
docker compose exec 5chan 5chan defaults set -i

# Remove a board
docker compose exec 5chan 5chan board remove random.bso
```

The container auto-reloads when files in the config directory change, so boards added/edited via `5chan board add/edit` take effect immediately without restarting.

### Build locally

```bash
docker build -t 5chan-board-manager .
docker run -d -v /path/to/data:/data 5chan-board-manager
```

### Data paths

| Container path | Description |
|---|---|
| `/data/5chan/global.json` | Global config (optional — rpcUrl, defaults) |
| `/data/5chan/boards/<address>/config.json` | Per-board config (created by `5chan board add`) |
| `/data/5chan/boards/<address>/state.json` | Per-board state (auto-created: signers, archived threads) |

### Board creation and defaults preset

If you are not using the Docker quick usage flow above, create the board with `bitsocial community create` first, then add it to 5chan with `5chan board add`.

Run `5chan board add --help` for full details on preset defaults flags (`--apply-defaults`, `--skip-apply-defaults`, `--interactive-apply-defaults`). In interactive terminals, defaults are shown with an `[A]ccept / [M]odify / [S]kip` prompt; choosing Modify opens the preset in `$EDITOR` as an annotated JSONC file with `//` comments explaining each field.

Preset JSONC is validated with Zod. Both plain JSON and JSONC (with `//` comments) are accepted as preset files.

`boardSettings` must follow pkc-js `CommunityEditOptions`:
https://github.com/pkcprotocol/pkc-js?tab=readme-ov-file#communityeditcommunityeditoptions

Bundled preset JSONC defaults:
[`src/presets/community-defaults.jsonc`](src/presets/community-defaults.jsonc)

`boardSettings` is merged into `community.edit()` with "missing only" semantics (only absent values are applied). `boardManagerSettings` is used as default values for `board add` config fields, and explicit CLI flags override these defaults.

The bundled preset file is `src/presets/community-defaults.jsonc`.

## Commands

<!-- commands -->
* [`5chan board add ADDRESS`](#5chan-board-add-address)
* [`5chan board edit ADDRESS`](#5chan-board-edit-address)
* [`5chan board list`](#5chan-board-list)
* [`5chan board remove ADDRESS`](#5chan-board-remove-address)
* [`5chan defaults set`](#5chan-defaults-set)
* [`5chan help [COMMAND]`](#5chan-help-command)
* [`5chan logs`](#5chan-logs)
* [`5chan start`](#5chan-start)

## `5chan board add ADDRESS`

Add a board to the config

```
USAGE
  $ 5chan board add ADDRESS [--rpc-url <value>] [--per-page <value>] [--pages <value>] [--bump-limit <value>]
    [--archive-purge-seconds <value>] [--apply-defaults] [--skip-apply-defaults] [--interactive-apply-defaults]
    [--defaults-preset <value>]

ARGUMENTS
  ADDRESS  Board address to add

FLAGS
  --apply-defaults                 Apply preset defaults silently (no prompts)
  --archive-purge-seconds=<value>  Seconds after archiving before purge
  --bump-limit=<value>             Bump limit for threads
  --defaults-preset=<value>        Path to a custom preset JSON file
  --interactive-apply-defaults     Interactively review and modify preset defaults before applying
  --pages=<value>                  Number of pages
  --per-page=<value>               Posts per page
  --rpc-url=<value>                [default: ws://localhost:9138, env: PKC_RPC_WS_URL] PKC RPC WebSocket URL (for
                                   validation)
  --skip-apply-defaults            Skip applying preset defaults

DESCRIPTION
  Add a board to the config

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
  https://github.com/bitsocialnet/bitsocial-cli#bitsocial-community-edit-address

EXAMPLES
  $ 5chan board add random.bso

  $ 5chan board add tech.bso --bump-limit 500

  $ 5chan board add flash.bso --per-page 30 --pages 1

  $ 5chan board add my-board.bso --rpc-url ws://custom-host:9138

  $ 5chan board add my-board.bso --apply-defaults

  $ 5chan board add my-board.bso --skip-apply-defaults

  $ 5chan board add my-board.bso --interactive-apply-defaults

  $ 5chan board add my-board.bso --apply-defaults --defaults-preset ./my-preset.json
```

_See code: [src/commands/board/add.ts](https://github.com/bitsocialnet/5chan-board-manager/blob/v0.2.10/src/commands/board/add.ts)_

## `5chan board edit ADDRESS`

Edit 5chan settings for an existing board

```
USAGE
  $ 5chan board edit ADDRESS [-i | --per-page <value> | --pages <value> | --bump-limit <value> |
    --archive-purge-seconds <value> | --reset <value>]

ARGUMENTS
  ADDRESS  Board address to edit

FLAGS
  -i, --interactive                    Open the board config in $EDITOR for interactive editing
      --archive-purge-seconds=<value>  Seconds after archiving before purge
      --bump-limit=<value>             Bump limit for threads
      --pages=<value>                  Number of pages
      --per-page=<value>               Posts per page
      --reset=<value>                  Comma-separated fields to reset to defaults (per-page, pages, bump-limit,
                                       archive-purge-seconds, moderation-reasons)

DESCRIPTION
  Edit 5chan settings for an existing board

  This command configures how 5chan manages the board (pagination, bump limits, archiving).
  Use --interactive (-i) to open the board config in $EDITOR for direct viewing/editing.
  To edit board settings (title, description, rules, etc.), use a WebUI or bitsocial-cli:
  https://github.com/bitsocialnet/bitsocial-cli#bitsocial-community-edit-address

EXAMPLES
  $ 5chan board edit tech.bso --bump-limit 500

  $ 5chan board edit flash.bso --per-page 30 --pages 1

  $ 5chan board edit random.bso --reset per-page,bump-limit

  $ 5chan board edit random.bso --per-page 20 --reset bump-limit

  $ 5chan board edit random.bso --reset moderation-reasons

  $ 5chan board edit random.bso --interactive

  $ 5chan board edit random.bso -i
```

_See code: [src/commands/board/edit.ts](https://github.com/bitsocialnet/5chan-board-manager/blob/v0.2.10/src/commands/board/edit.ts)_

## `5chan board list`

List all board addresses

```
USAGE
  $ 5chan board list

DESCRIPTION
  List all board addresses

EXAMPLES
  $ 5chan board list
```

_See code: [src/commands/board/list.ts](https://github.com/bitsocialnet/5chan-board-manager/blob/v0.2.10/src/commands/board/list.ts)_

## `5chan board remove ADDRESS`

Remove a board from the config

```
USAGE
  $ 5chan board remove ADDRESS

ARGUMENTS
  ADDRESS  Community address to remove

DESCRIPTION
  Remove a board from the config

EXAMPLES
  $ 5chan board remove random.bso
```

_See code: [src/commands/board/remove.ts](https://github.com/bitsocialnet/5chan-board-manager/blob/v0.2.10/src/commands/board/remove.ts)_

## `5chan defaults set`

Set global default settings for all boards

```
USAGE
  $ 5chan defaults set [-i | --per-page <value> | --pages <value> | --bump-limit <value> | --archive-purge-seconds
    <value> | --reset <value>]

FLAGS
  -i, --interactive                    Open defaults in $EDITOR for interactive editing
      --archive-purge-seconds=<value>  Seconds after archiving before purge
      --bump-limit=<value>             Bump limit for threads
      --pages=<value>                  Number of pages
      --per-page=<value>               Posts per page
      --reset=<value>                  Comma-separated fields to remove from defaults (per-page, pages, bump-limit,
                                       archive-purge-seconds, moderation-reasons)

DESCRIPTION
  Set global default settings for all boards

  Defaults in global.json apply to every board unless overridden per-board.
  Use --interactive (-i) to open the defaults object in $EDITOR for direct editing.

EXAMPLES
  $ 5chan defaults set --per-page 20

  $ 5chan defaults set --bump-limit 500 --pages 10

  $ 5chan defaults set --reset per-page,bump-limit

  $ 5chan defaults set --per-page 20 --reset bump-limit

  $ 5chan defaults set --interactive

  $ 5chan defaults set -i
```

_See code: [src/commands/defaults/set.ts](https://github.com/bitsocialnet/5chan-board-manager/blob/v0.2.10/src/commands/defaults/set.ts)_

## `5chan help [COMMAND]`

Display help for 5chan.

```
USAGE
  $ 5chan help [COMMAND...] [-n]

ARGUMENTS
  [COMMAND...]  Command to show help for.

FLAGS
  -n, --nested-commands  Include all nested commands in the output.

DESCRIPTION
  Display help for 5chan.
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v6.2.37/src/commands/help.ts)_

## `5chan logs`

View the latest 5chan daemon log file. By default dumps the full log and exits. Use --follow to stream new output in real-time (like tail -f).

```
USAGE
  $ 5chan logs [-f] [-n <value>] [--since <value>] [--until <value>] [--logPath <value>] [--stdout |
    --stderr]

FLAGS
  -f, --follow           Follow log output in real-time (like tail -f)
  -n, --tail=<value>     [default: all] Number of log entries to show from the end. Use "all" to show everything.
      --logPath=<value>  Specify the directory containing log files
      --since=<value>    Show logs since timestamp (ISO 8601, e.g. 2026-01-02T13:23:37Z) or relative time (e.g. 30s,
                         42m, 2h, 1d)
      --stderr           Show only stderr log entries (output of pkc-logger library)
      --stdout           Show only stdout log entries
      --until=<value>    Show logs before timestamp (ISO 8601, e.g. 2026-01-02T13:23:37Z) or relative time (e.g. 30s,
                         42m, 2h, 1d)

DESCRIPTION
  View the latest 5chan daemon log file. By default dumps the full log and exits. Use --follow to stream new output in
  real-time (like tail -f).

EXAMPLES
  $ 5chan logs

  $ 5chan logs -f

  $ 5chan logs -n 50

  $ 5chan logs --since 5m

  $ 5chan logs --since 2026-01-02T13:23:37Z --until 2026-01-02T14:00:00Z

  $ 5chan logs --since 1h -f

  $ 5chan logs --stdout

  $ 5chan logs --stderr

  $ 5chan logs --stdout -f
```

_See code: [src/commands/logs.ts](https://github.com/bitsocialnet/5chan-board-manager/blob/v0.2.10/src/commands/logs.ts)_

## `5chan start`

Start board managers for all configured boards

```
USAGE
  $ 5chan start [-c <value>] [--log-path <value>]

FLAGS
  -c, --config-dir=<value>  Path to config directory (overrides default)
      --log-path=<value>    [default: /home/runner/.local/state/5chan] Directory to store daemon log files

DESCRIPTION
  Start board managers for all configured boards

  Board managers enforce imageboard-style thread lifecycle rules on each board:
  - Archive threads that exceed board capacity (perPage × pages)
  - Archive threads that reach the bump limit
  - Purge archived threads after the retention period expires
  - Purge author-deleted threads and replies

  The config directory is watched for changes; boards are hot-reloaded
  (added, removed, or restarted) without requiring a full restart.

  Daemon output is written to a rotated log file (default: /home/runner/.local/state/5chan).
  View it with `5chan logs`. stderr is suppressed on the terminal; real
  uncaught errors still reach the terminal.

EXAMPLES
  $ 5chan start

  $ 5chan start --config-dir /path/to/config

  $ 5chan start --log-path /var/log/5chan
```

_See code: [src/commands/start.ts](https://github.com/bitsocialnet/5chan-board-manager/blob/v0.2.10/src/commands/start.ts)_
<!-- commandsstop -->

## Config Hot-Reload

`5chan start` watches the config directory (`boards/` and `global.json`) using `fs.watch()` with a 200ms debounce. When any config file changes:

1. Loads and validates the new config
2. Diffs old vs new boards
3. Stops board managers for removed boards
4. Restarts board managers for boards with changed config
5. Starts board managers for added boards
6. Logs the delta: `config reloaded: +N added, -N removed, ~N changed, M running`

This means you can add, edit, or remove boards while the board manager is running — either by editing config files directly or by running `5chan board add/edit/remove` in another terminal. When global config changes (rpcUrl, defaults), all running boards are restarted.

## File Locking

Each board manager acquires a PID-based lock file (`{statePath}.lock`) to prevent concurrent board managers on the same board. On startup:

1. Attempts to create lock file exclusively (`wx` flag)
2. If lock exists, reads the PID and checks if it's still alive (`process.kill(pid, 0)`)
3. If alive — throws `Another board manager (PID N) is already running`
4. If stale — removes the old lock and retries

The lock is released when the board manager stops.

## Author-Deleted Comment Purging

The board manager detects comments and replies that were deleted by their author (where `comment.deleted === true`) and purges them via `createCommentModeration({ commentModeration: { purged: true } })`. Once purged, the comment is removed from the board and won't appear in future listings. If a purge hasn't been processed yet, the next cycle may re-publish a redundant purge moderation, which is a harmless no-op.

## Auto Mod Signer Management

On startup for each board (using the internally-created PKC instance):

1. Check state JSON for a signer private key for this board address
2. If none exists, create one via `pkc.createSigner()` and save to state JSON
3. Check board roles via `community.roles` for the signer's address
4. If not a mod, auto-add via `community.edit()` (works because we run on `LocalCommunity` or `RpcLocalCommunity` — we own the board)

Logged via `pkc-logger` when creating signer or adding mod role.

## Address Change Handling

When bitsocial-cli changes a board's address (e.g., from a hash like `12D3KooW...` to a named address like `random.bso`), the board manager detects the change automatically via the pkc-js `update` event and migrates all associated files:

1. Signer key is moved to the new address in the state file
2. Board directory is renamed from `boards/{oldAddress}/` to `boards/{newAddress}/` (with updated `address` field in `config.json`)
3. Lock file is re-acquired for the new address
4. Internal maps are updated so moderation continues uninterrupted

The mod signer carries over to the new address — no need to re-assign the moderator role. If the migration fails (e.g., lock conflict on the new address), the board manager logs the error and continues operating under the old address.

## State Persistence

State is stored as `state.json` inside each board's directory (`boards/{address}/state.json`), alongside the board's `config.json`.

```json
{
  "signers": {
    "<boardAddress>": { "privateKey": "..." }
  },
  "archivedThreads": {
    "<commentCid>": { "archivedTimestamp": 1234567890 }
  }
}
```

- **`signers`**: maps board address → mod signer private key (auto-created if missing)
- **`archivedThreads`**: maps comment CID → archive metadata (entries removed on purge)
- State writes use atomic temp-then-rename to prevent corruption
- Loaded on startup, written on archive, entries removed on purge

## Cold Start

The script may start long after the board has been running. On first run, many threads may need locking/purging at once. No rate limiting is needed — same-node publishing has no pubsub overhead. The first cycle may be heavier; steady-state handles a few threads per update.

## Idempotency

Before archiving, checks the thread's `archived` property. Skips if already archived (pkc-js throws on duplicate moderation actions).

## Logging

Uses `pkc-logger` (same logger as the pkc-js ecosystem). Key events logged:

- Board manager start/stop
- Threads archived (with CID and reason: capacity vs bump limit)
- Threads purged
- Author-deleted comments purged
- Config hot-reload events
- Mod role auto-added
- Errors

**Daemon log file.** When `5chan start` runs, stdout and stderr are captured to a
rotated log file under `$XDG_STATE_HOME/5chan/log/` (inside Docker: `/data/5chan/log/`).
Each entry is prefixed with `[ISO-timestamp] [stdout|stderr]`. At most 5 files are
retained; the oldest is deleted on each restart. Each file is capped at 20MB.

stderr is suppressed on the terminal — only real uncaught errors reach it. Use
`5chan logs` (or `5chan logs -f`) to view daemon output:

```bash
docker compose exec 5chan 5chan logs        # dump latest log
docker compose exec 5chan 5chan logs -f     # stream live
docker compose exec 5chan 5chan logs --stderr -f   # only pkc-logger output
```

**Docker:** Debug logging (`DEBUG=5chan:*`) is enabled by default in the Docker image.
Because stderr is no longer teed to the terminal, `docker logs` will be quieter than
before — use `5chan logs` to see the full debug stream. To silence the log file as
well, override the variable to empty:

```bash
docker run -e DEBUG= 5chan-board-manager
```

Or in `docker-compose.yml`:

```yaml
environment:
  DEBUG: ""
```

To broaden the captured namespaces (e.g. to include pkc-js events), widen `DEBUG`:

```yaml
environment:
  DEBUG: "5chan:*,pkc*,pkc-js*"
```

## 4chan Board Behavior Reference

### Board capacity

Total thread capacity = `per_page × pages`. Both are **configurable per board**.

| Setting | Range | Description |
|---------|-------|-------------|
| `per_page` | 15–30 | Threads per index page (e.g., /b/ = 15, /v/ = 20, /f/ = 30) |
| `pages` | 1–10 | Number of index pages (e.g., /f/ = 1, most boards = 10) |

Capacity examples: /b/ = 150, /v/ = 200, /f/ = 30.

### Thread lifecycle

1. **New thread created** → sits at top of page 1
2. **Bumped by replies** → moves back to top of page 1
3. **Sinks gradually** as newer threads get replies
4. **Falls off last page** → archived (read-only, ~48h)
5. **Purged** → permanently deleted from 4chan's servers

### Bumping

A reply moves the thread to the top of page 1. This is equivalent to PKC's **"active sort"**, which orders threads by `lastReplyTimestamp`.

### Bump limit

Configurable per board (300–500+). After N replies, new replies no longer bump the thread, but it still accepts replies until it falls off the last page.

Examples: /b/ = 300, /3/ = 310, /v/ = 500.

### Pinned (sticky) threads

Sit at top of page 1, exempt from thread limit and archiving. "Pinned" and "sticky" are the same thing.

### Archive vs purge

- **Archived** = locked/read-only, still visible for ~48 hours
- **Purged** = permanently deleted from 4chan's servers
- Not all boards have archives (`is_archived` flag in API)

### Third-party archives

External services (archive.4plebs.org, desuarchive.org) independently scrape and preserve threads before purge.

### Other per-board settings from 4chan API

`image_limit`, `max_filesize`, `max_comment_chars`, `cooldowns`, `spoilers`, `country_flags`, `user_ids`, `forced_anon`, etc.

## Testing

Unit tests run under Vitest:

```bash
npm test
```

End-to-end tests run the real board manager against a real PKC RPC server:

```bash
npm run test:e2e
```

The e2e suite spawns its own Kubo (IPFS) daemon on random ports and an in-process PKC RPC server on port `19138`. All state is written to temp directories that are removed at teardown. No `bitsocial-cli` or docker-compose stack needs to be running — Kubo is provided by the `kubo` npm package installed as a devDependency.

To point the suite at an externally-running RPC instead (e.g. a long-lived docker-compose stack), set `PKC_RPC_WS_URL` before invoking the script — when set, global-setup skips spawning and uses the provided URL verbatim:

```bash
PKC_RPC_WS_URL=ws://localhost:9138/YOUR-AUTH-KEY npm run test:e2e
```

## Differences from 4chan

| Behavior | 4chan | This module |
|----------|------|-------------|
| **Bump limit** | Threads past bump limit still accept replies — they just stop rising in the catalog | Threads are **archived** (no more replies) because pkc-js has no "stop bumping without archiving" mechanism |
| **Sage** | Replying with `sage` in the email field prevents the thread from being bumped | Not supported — PKC has no equivalent mechanism, so all replies bump the thread |
| **Image limit** | Per-thread image limit (e.g., 150 images on /b/) after which no more images can be posted | Not implemented — pkc-js has its own file-size constraints but no per-thread image count limit |

## PKC-js Implementation

### Architecture

External module using pkc-js's public API:

- No pkc-js core modifications needed
- Uses `pkc.createCommentModeration()` for both archiving and purging
- Listens to board `update` events (via `community.on('update', ...)`) to detect new posts
- Gets thread positions from board post feeds (`community.posts.pageCids.active`), or falls back to sorting preloaded pages by `lastReplyTimestamp` descending (then `postNumber`)

### Configurable settings

Uses 4chan field names for interoperability.

| Setting | Default | 4chan range | Description |
|---------|---------|-------------|-------------|
| `per_page` | 15 | 15–30 | Threads per index page |
| `pages` | 10 | 1–10 | Number of index pages |
| `bump_limit` | 300 | 300–500 | Max replies before thread is archived |
| `archive_purge_seconds` | 172800 (48h) | ~48h | Seconds before archived posts are purged (no 4chan equivalent, 4chan uses ~48h) |
| `moderationReasons` | (see below) | — | Reason strings passed to `createCommentModeration()`. Fields: `archiveCapacity`, `archiveBumpLimit`, `purgeArchived`, `purgeDeleted` |

**Max active threads** = `per_page × pages` (default: 150)

### API note

Cannot do `community.posts.getPage("active")`. Must either:

1. Use `community.posts.pageCids.active` to get the CID, then fetch that page
2. Or fall back to sorting preloaded pages by `lastReplyTimestamp` descending, then `postNumber` (approximates active sort without needing `pageCids.active`)

### Board record size constraint

The entire board IPFS record is capped at 1MB (`MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS`). `community.posts.pages.hot` is preloaded into the record with whatever space remains after the rest of the record (title, description, roles, challenges, etc.).

- If the preloaded page has **no `nextCid`**, it contains all posts — no pagination needed
- If `nextCid` **is present**, additional pages must be fetched via `community.posts.getPage({ cid: nextCid })`
- `community.posts.pageCids.active` provides the CID of the first active-sorted page, which is the sort order the board manager needs

Reference: `pkc-js/src/community/community-client-manager.ts`, `pkc-js/src/runtime/node/community/local-community.ts`

### Module flow

```
1. Create PKC instance internally from the provided pkcRpcUrl
2. Load state JSON; get or create signer for this board via `pkc.createSigner()`
3. Get board (`LocalCommunity` or `RpcLocalCommunity`)
4. Check board roles via `community.roles`; if missing, call `community.edit()` to add as mod
5. Acquire file lock to prevent concurrent board managers on same board
6. Call `community.update()`
7. On each 'update' event:
   a. Determine thread source (three scenarios):
      1. pageCids.active exists → fetch via getPage(), paginate via nextCid
      2. Only pages.hot exists → use preloaded page, sort by lastReplyTimestamp desc then postNumber
      3. Neither exists → no posts, return early
   b. Walk through pages to build full ordered list of threads
   c. Filter out pinned threads
   d. For each non-pinned thread beyond position (per_page * pages):
      - Skip if already archived
      - createCommentModeration({ archived: true }) and publish
      - Record archivedTimestamp in state file
   e. For each thread with replyCount >= bump_limit:
      - Skip if already archived
      - createCommentModeration({ archived: true }) and publish
      - Record archivedTimestamp in state file
   f. For each archived thread where (now - archivedAt) > archive_purge_seconds:
      - createCommentModeration({ purged: true }) and publish
      - Remove from state file
   g. For each author-deleted comment/reply:
      - createCommentModeration({ purged: true }) and publish
```

### Key pkc-js APIs used

| API | Purpose |
|-----|---------|
| `pkc.createCommentModeration()` | Archive and purge threads |
| `commentModeration.publish()` | Publish the moderation action |
| `community.posts.pageCids.active` | Get active sort page CID |
| `community.posts.pages.hot` | Preloaded first page (for calculating active sort) |
| `community.on('update', ...)` | Listen for new posts/updates |
| `page.nextCid` | Paginate through multi-page feeds |

### Key pkc-js source files (reference only, not modified)

| File | Relevant code |
|------|--------------|
| `src/pkc/pkc.ts` | `createCommentModeration()` definition |
| `src/publications/comment-moderation/schema.ts` | ModeratorOptionsSchema with `archived`, `purged` fields |
| `src/runtime/node/community/local-community.ts` | Existing archived check that blocks replies |
| `src/runtime/node/community/db-handler.ts` | `queryPostsWithActiveScore()` — active sort CTE |
| `src/pages/util.ts` | Sort type definitions and scoring functions |
