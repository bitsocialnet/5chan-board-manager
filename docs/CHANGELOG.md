# Changelog

## [0.2.15](https://github.com/bitsocialnet/5chan-board-manager/compare/v0.2.14...v0.2.15) (2026-04-29)

## [0.2.14](https://github.com/bitsocialnet/5chan-board-manager/compare/v0.2.13...v0.2.14) (2026-04-29)

## [0.2.13](https://github.com/bitsocialnet/5chan-board-manager/compare/v0.2.12...v0.2.13) (2026-04-29)

### Bug Fixes

* **daemon:** surface log output and add heartbeat with crash-on-stale ([00a291e](https://github.com/bitsocialnet/5chan-board-manager/commit/00a291e7ed516d7749154f390d2d28651136cab8))

## [0.2.12](https://github.com/bitsocialnet/5chan-board-manager/compare/v0.2.11...v0.2.12) (2026-04-26)

## [0.2.11](https://github.com/bitsocialnet/5chan-board-manager/compare/v0.2.10...v0.2.11) (2026-04-25)

### Features

* **cli:** accept multiple addresses in `5chan board add` ([fbd0885](https://github.com/bitsocialnet/5chan-board-manager/commit/fbd0885d23e30c67f96507977a5d569aa23a5473))

## [0.2.10](https://github.com/bitsocialnet/5chan-board-manager/compare/v0.2.9...v0.2.10) (2026-04-25)

### Features

* **cli:** add `5chan logs` command for viewing daemon logs ([56bb753](https://github.com/bitsocialnet/5chan-board-manager/commit/56bb753eab35a6cf56fb3d0b99bc0f13ab0a1883))

### Bug Fixes

* **hot-reload:** swap fs.watch for chokidar to avoid Linux recursion race ([defe348](https://github.com/bitsocialnet/5chan-board-manager/commit/defe3487d6f5954aebd0c38124750d2c362bff51))

## [0.2.9](https://github.com/bitsocialnet/5chan-board-manager/compare/v0.2.8...v0.2.9) (2026-04-24)

## [0.2.8](https://github.com/bitsocialnet/5chan-board-manager/compare/v0.2.7...v0.2.8) (2026-04-23)

### Bug Fixes

* **preset:** replace captcha-canvas-v3 with spam-blocker challenge ([97a52b7](https://github.com/bitsocialnet/5chan-board-manager/commit/97a52b7865dad0d8db1f2dfdc6ec10802ef2c802))

## [0.2.7](https://github.com/bitsocialnet/5chan-board-manager/compare/v0.2.6...v0.2.7) (2026-04-23)

### Bug Fixes

* **docker:** use PKC_RPC_AUTH_KEY env var for bitsocial-cli ([21458cf](https://github.com/bitsocialnet/5chan-board-manager/commit/21458cf0894f2d4bd72def13bddef46b119e83e2))

## [0.2.6](https://github.com/bitsocialnet/5chan-board-manager/compare/v0.2.5...v0.2.6) (2026-04-23)

## [0.2.5](https://github.com/bitsocialnet/5chan-board-manager/compare/v0.2.4...v0.2.5) (2026-04-17)

## [0.2.4](https://github.com/bitsocialnet/5chan-board-manager/compare/v0.2.3...v0.2.4) (2026-04-17)

### Features

* **deps:** migrate from @plebbit/plebbit-js to @pkcprotocol/pkc-js ([7c05c39](https://github.com/bitsocialnet/5chan-board-manager/commit/7c05c39192d349be10c3ff3fc974b4a292c5d00b))

## [0.2.3](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.2.2...v0.2.3) (2026-02-27)

### Bug Fixes

* **ci:** separate cache scopes to eliminate redundant builds in publish job ([e076e25](https://github.com/bitsocialhq/5chan-board-manager/commit/e076e25daf28855085db4fd0298208d3e241c884))

## [0.2.2](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.2.1...v0.2.2) (2026-02-27)

### Features

* add `defaults set` CLI command with Zod schema validation ([085575f](https://github.com/bitsocialhq/5chan-board-manager/commit/085575fc7f7b9e69a4e0b58d3e73025ca120161e))

## [0.2.1](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.2.0...v0.2.1) (2026-02-27)

### Bug Fixes

* **ci:** update board config path to match per-board directory structure ([325f029](https://github.com/bitsocialhq/5chan-board-manager/commit/325f029084d8b2b8661da8638d99a30c36c05e62))

## [0.2.0](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.15...v0.2.0) (2026-02-27)

### ⚠ BREAKING CHANGES

* board config files moved from `boards/{address}.json`
to `boards/{address}/config.json`, and state files now live alongside
config in each board's directory instead of a separate stateDir.

- Replace flat board config files with per-board directories
- Co-locate state.json and lock files in each board directory
- Replace `stateDir` option with required `boardDir` in BoardManagerOptions
- Add `configDir` parameter to resolveBoardManagerOptions and startMultiBoardManager
- Remove env-paths dependency (no longer needed without defaultStateDir)
- Simplify address changes to a single directory rename

### refactor

* consolidate per-board config and state into per-board directories ([79a5ed9](https://github.com/bitsocialhq/5chan-board-manager/commit/79a5ed938c2a2f30a8a4c8fce187a4e8ede99e15))

### Bug Fixes

* **ci:** increase Docker build timeout to 30 minutes ([e2f8d2c](https://github.com/bitsocialhq/5chan-board-manager/commit/e2f8d2c26d869780070125bcdb468b61b81989a3))

## [0.1.15](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.14...v0.1.15) (2026-02-27)

### Bug Fixes

* store hostname in lock file to prevent infinite restart loop in Docker ([02339ab](https://github.com/bitsocialhq/5chan-board-manager/commit/02339ab6a026910317bd9b63b0cc4f53402a2a02))

## [0.1.14](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.13...v0.1.14) (2026-02-25)

### Bug Fixes

* **ci:** warm arm64 cache in build job so publish is a cache hit ([9bdeb88](https://github.com/bitsocialhq/5chan-board-manager/commit/9bdeb882af35eb0eab083115912798c19461c7f4))
* comment out sysctls in docker-compose.example.yml for rootless Docker compatibility ([96d98e9](https://github.com/bitsocialhq/5chan-board-manager/commit/96d98e9fd0ecb82925343eb1b7958ff73df0773b))
* install nano in Docker image so editor works out of the box ([3019f33](https://github.com/bitsocialhq/5chan-board-manager/commit/3019f33f9384a9284def21c301096f45ae281930))

## [0.1.13](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.12...v0.1.13) (2026-02-25)

### Bug Fixes

* **ci:** build Docker image once and share across test jobs ([f293cd5](https://github.com/bitsocialhq/5chan-board-manager/commit/f293cd5acdbdce213961af006dc459f389b46158))
* pre-configure RPC auth key in docker-compose so 5chan connects out of the box ([d78fe47](https://github.com/bitsocialhq/5chan-board-manager/commit/d78fe475e2fb9a6cf35f73d9188c7643b4b4c032))

## [0.1.12](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.11...v0.1.12) (2026-02-25)

### Bug Fixes

* **ci:** use dedicated compose file without sysctls for full-stack job ([f722954](https://github.com/bitsocialhq/5chan-board-manager/commit/f722954d1c4bbbc2a2708e37a8163a825995bb38))

## [0.1.11](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.10...v0.1.11) (2026-02-25)

### Reverts

* **ci:** restore heredoc indentation — YAML block scalar strips it ([6aa1b4e](https://github.com/bitsocialhq/5chan-board-manager/commit/6aa1b4e8994c07f26f009495e60db792d86e2c85))

## [0.1.10](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.9...v0.1.10) (2026-02-25)

### Bug Fixes

* **ci:** remove heredoc indentation producing invalid YAML ([161c5b0](https://github.com/bitsocialhq/5chan-board-manager/commit/161c5b0137e0746b8f482d6e3c51c825bab78080))

## [0.1.9](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.8...v0.1.9) (2026-02-25)

### Bug Fixes

* **ci:** neutralize sysctls in full-stack job for GitHub Actions ([2942abc](https://github.com/bitsocialhq/5chan-board-manager/commit/2942abcefc6421ac14c7977bd91fadebe1741987))

## [0.1.8](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.7...v0.1.8) (2026-02-25)

### Bug Fixes

* **docker:** increase UDP buffer limits to silence QUIC warning ([f18c580](https://github.com/bitsocialhq/5chan-board-manager/commit/f18c58005a8e7e87e43516e48b16c9cb7eb365c8))
* **docker:** limit DEBUG logging to daemon commands only ([a2225b8](https://github.com/bitsocialhq/5chan-board-manager/commit/a2225b839a70c9a05d1da5c19b38561df45887a3))
* **docker:** rename bitsocial container to 5chan-bitsocial-cli to avoid name conflicts ([6c7718f](https://github.com/bitsocialhq/5chan-board-manager/commit/6c7718fd9b2c6bbb6fa63f6617ac607034ffa8fd))
* **start:** wait gracefully when no boards configured instead of crashing ([bd3cb88](https://github.com/bitsocialhq/5chan-board-manager/commit/bd3cb8843403d9681c0c2f336ae6f220ff655ebf))

## [0.1.7](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.6...v0.1.7) (2026-02-25)

### Bug Fixes

* **defaults:** overwrite arrays in buildMissingObjectPatch instead of skipping them ([2c93da9](https://github.com/bitsocialhq/5chan-board-manager/commit/2c93da9c995fc8456987c3ddabb56dd2b09085bd))

## [0.1.6](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.5...v0.1.6) (2026-02-25)

### Bug Fixes

* **docker:** include preset files in Docker image ([7c6a559](https://github.com/bitsocialhq/5chan-board-manager/commit/7c6a559188e510c826030a651cda42e839506af1))

## [0.1.5](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.4...v0.1.5) (2026-02-25)

### Features

* add configurable userAgent to Plebbit RPC connection ([15c0a7e](https://github.com/bitsocialhq/5chan-board-manager/commit/15c0a7e81d7cb3414284c66851c123828ca23e95))

### Bug Fixes

* **ci:** pass RPC auth key for cross-container connections ([0a53751](https://github.com/bitsocialhq/5chan-board-manager/commit/0a53751ac31ce234a5e601e32718ad6dc08619c0))

## [0.1.4](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.3...v0.1.4) (2026-02-23)

### Bug Fixes

* **ci:** use quiet flag when extracting community address ([c409dfb](https://github.com/bitsocialhq/5chan-board-manager/commit/c409dfb63394fecc6fc10c5f2dc58a2d9cfbcac9))

## [0.1.3](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.2...v0.1.3) (2026-02-23)

### Bug Fixes

* **ci:** add packages:read permission for GHCR pulls ([a5fa4a6](https://github.com/bitsocialhq/5chan-board-manager/commit/a5fa4a607a8243e8f7a9a4e4c6834b536c900651))

## [0.1.2](https://github.com/bitsocialhq/5chan-board-manager/compare/v0.1.1...v0.1.2) (2026-02-23)

### Bug Fixes

* **ci:** add GHCR authentication to Docker Compose CI workflow ([610e237](https://github.com/bitsocialhq/5chan-board-manager/commit/610e23770d6a544f3a3d2e3dca553c7cbd6565b9))
* **ci:** trigger CI workflow on any .github/ changes ([e099498](https://github.com/bitsocialhq/5chan-board-manager/commit/e099498c25cf04cdddfb6ced4144fe06fea01763))

## 0.1.1 (2026-02-23)

### Features

* add `board edit` command with hot-reload restart ([c93ef29](https://github.com/bitsocialhq/5chan-board-manager/commit/c93ef2995c46d5107361fa31ecc9e6b54402c2db))
* **board:** add interactive defaults review with $EDITOR modify support ([17876da](https://github.com/bitsocialhq/5chan-board-manager/commit/17876dabb42da812aabb9e578f50dd65823e44af))
* **board:** apply preset defaults on board add ([aaeb8b6](https://github.com/bitsocialhq/5chan-board-manager/commit/aaeb8b6ed391eb2a43c25ef0f584d9331d1e4296))
* **board:** reject unknown flags with helpful error in add/edit commands ([bd91098](https://github.com/bitsocialhq/5chan-board-manager/commit/bd9109839238adbdb4ea9c22476a992332429fb1))
* **board:** simplify `board list` to addresses-only and add `board edit --interactive` ([c6df72e](https://github.com/bitsocialhq/5chan-board-manager/commit/c6df72ecca905eecf0c51f1586805854c31bce3a))
* **ci:** add Docker Compose integration tests that gate image publish ([8b8ad7b](https://github.com/bitsocialhq/5chan-board-manager/commit/8b8ad7ba3e99270e34c46de919d6bcc8962b97d5))
* **docker:** enable DEBUG logging by default in Docker image ([6c6408f](https://github.com/bitsocialhq/5chan-board-manager/commit/6c6408fe00b6610e9a1a547cf24843e73e7c5a93))
* handle board address changes automatically ([3235f90](https://github.com/bitsocialhq/5chan-board-manager/commit/3235f906b10c752ffde73a299ca5290be34faf59))
* **moderation:** add configurable reason strings for archive and purge ([797bc2b](https://github.com/bitsocialhq/5chan-board-manager/commit/797bc2bfe54fe2c56996e063295616e3453204c3))
* **preset:** add JSONC comments to preset file for interactive editing ([0336ff4](https://github.com/bitsocialhq/5chan-board-manager/commit/0336ff48652b697e72ae54b7d71d7571e3df20d4))

### Bug Fixes

* **board:** check for duplicate board before preset defaults flow ([bf4a4a1](https://github.com/bitsocialhq/5chan-board-manager/commit/bf4a4a12d5140d76627d053cc7733d002058631e))
* handle trailing commas in JSONC community defaults preset ([0704d8b](https://github.com/bitsocialhq/5chan-board-manager/commit/0704d8b24e8ad09e1bcd406365cc3db9c82ffc28))
* pin @oclif/core and @oclif/plugin-help to exact versions ([be3454e](https://github.com/bitsocialhq/5chan-board-manager/commit/be3454e193c820bf5d70c88456b4e5e486d30e54))
* **preset:** force JSON syntax highlighting when nano opens JSONC preset ([58fd70a](https://github.com/bitsocialhq/5chan-board-manager/commit/58fd70ac1793b825200ab1674590adb9c0503539))
* **tests:** make tests cross-platform for Windows CI ([c638668](https://github.com/bitsocialhq/5chan-board-manager/commit/c6386682e2a9a3fe3f56c65443c2a2a2fa5ac053))
* throw on startup when all boards fail in archiver manager ([93838a0](https://github.com/bitsocialhq/5chan-board-manager/commit/93838a0954e77a1bedfdca0de66252a0f266db6f))
* wait for subplebbitschange before accessing plebbit.subplebbits ([a868fb3](https://github.com/bitsocialhq/5chan-board-manager/commit/a868fb333d0486a336c436eccb51a0468090ed8c))

### Build System

* add conventional commits, commitlint, husky, and release-it ([eff956f](https://github.com/bitsocialhq/5chan-board-manager/commit/eff956fb39913ce1b4d18acc24378e69405c0aa1))
* add Docker image and CI release pipeline ([ea7a1ec](https://github.com/bitsocialhq/5chan-board-manager/commit/ea7a1ec532f08fed94df4ca31e8e2e706d3e895d))
* auto-generate CLI command docs from oclif ([a1f05ee](https://github.com/bitsocialhq/5chan-board-manager/commit/a1f05ee3c7b85056cc72cdad17ce2e76873a2055))
* **deps:** set deps to specific versions ([1122d2a](https://github.com/bitsocialhq/5chan-board-manager/commit/1122d2a7cf4b397fa9ee319b46d74ac118349ac3))
