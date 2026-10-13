// Resolves the Kubo binary for the e2e suite. It used to come from the `kubo`
// npm package, whose postinstall downloads from dist.ipfs.tech during every
// `npm ci`; when that host became unreachable (2026-10) every install failed,
// including the unit-test, release and Docker builds that never run Kubo. Now
// only e2e setup fetches it, from the GitHub release, and checks it against the
// SHA-512 pinned below. Set KUBO_BINARY to use an existing binary instead.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KUBO_VERSION = 'v0.41.0'

// Published next to each asset as <asset>.sha512 on the GitHub release
const KUBO_SHA512: Record<string, string> = {
  'darwin-amd64': 'f4c8cd6037791fcad2aa5e79f39268141df2ffe91710956499e813b77d2ad49de84e9cb52426fb8e006a52f6cf9a5ea1dc1964acf860d4c3b7c9e756c4e59f54',
  'darwin-arm64': 'a44b7f00e21ac322dbe018bc56c7dbca6b3bde2404853041d6365439fe055bfaf97a9215c95c3b389d7e04c93233f00a65b14d5bdaa01d9854c039852831eb84',
  'linux-amd64': '5c0f3dba6d29d30e3f3cfdbf7f7b05c228167d21211207b9c17a106f5c846d33895cd42a618eed989073b48af4a870df7f1f6c86a052796b02ea79767b66e4ef',
  'linux-arm64': '443a205d97dad590a6828e6ce994421b4fd6fa55feb9173c79b7b533b9d2c39646f0bfe2b9bcc3c6e25fe7876eae335586fddcfeefd48b2beb48c522d9713032',
}

const GO_ARCH: Record<string, string> = { x64: 'amd64', arm64: 'arm64' }

export async function resolveKuboBinary(): Promise<string> {
  if (process.env.KUBO_BINARY) return process.env.KUBO_BINARY

  const target = `${process.platform}-${GO_ARCH[process.arch] ?? process.arch}`
  const expectedSha512 = KUBO_SHA512[target]
  if (!expectedSha512) {
    throw new Error(`No pinned Kubo ${KUBO_VERSION} build for ${target}; set KUBO_BINARY to a Kubo binary`)
  }

  const installDir = fileURLToPath(new URL(`../node_modules/.cache/kubo/${KUBO_VERSION}-${target}`, import.meta.url))
  const binary = join(installDir, 'kubo', 'ipfs')
  if (existsSync(binary)) return binary

  const asset = `kubo_${KUBO_VERSION}_${target}.tar.gz`
  const url = `https://github.com/ipfs/kubo/releases/download/${KUBO_VERSION}/${asset}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Downloading ${url} failed: HTTP ${response.status}`)
  const tarball = Buffer.from(await response.arrayBuffer())
  const actualSha512 = createHash('sha512').update(tarball).digest('hex')
  if (actualSha512 !== expectedSha512) {
    throw new Error(`SHA-512 mismatch for ${url}: expected ${expectedSha512}, got ${actualSha512}`)
  }

  // Unpack beside the final directory and rename it into place, so an
  // interrupted run never leaves a partial binary that the cache check accepts
  mkdirSync(dirname(installDir), { recursive: true })
  const staging = mkdtempSync(`${installDir}.tmp-`)
  try {
    writeFileSync(join(staging, asset), tarball)
    const tar = spawnSync('tar', ['-xzf', asset], { cwd: staging })
    if (tar.status !== 0) throw new Error(`Unpacking ${asset} failed: ${tar.stderr?.toString() ?? ''}`)
    rmSync(join(staging, asset))
    renameSync(staging, installDir)
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    throw err
  }
  return binary
}
