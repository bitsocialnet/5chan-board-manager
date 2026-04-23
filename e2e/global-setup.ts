// Vitest globalSetup: spawns a Kubo IPFS daemon + an in-process PKCWsServer so
// e2e tests run with zero external prerequisites. Three quirks to know about:
//
//  1. `ipfs init --profile test` binds API/Gateway/Swarm to random ports (/tcp/0)
//     and disables MDNS/bootstrap. Kubo writes the actual API multiaddr to
//     `$IPFS_PATH/api` once "Daemon is ready" has been printed — we read that
//     file to discover which port to hand to pkc-js.
//  2. Kubo's HTTP pubsub endpoint is gated behind `--enable-pubsub-experiment`.
//     Without it pkc-js's challenge flow fails with "experimental pubsub feature
//     not enabled". `--enable-namesys-pubsub` is the matching flag for IPNS.
//  3. On first use PKCWsServer rewrites kubo's `Routing.DelegatedRouters` config
//     to match `pkcOptions.httpRoutersOptions` and then sends the daemon a
//     shutdown command, expecting the caller to restart it (bitsocial-cli has a
//     watchdog for this). Passing `httpRoutersOptions: []` tells pkc-js the
//     config is already correct, so the daemon stays up for the whole test run.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { path as kuboBinaryPath } from 'kubo'
import PKCRpc from '@pkcprotocol/pkc-js/rpc'

const E2E_RPC_PORT = 19138

function apiFileToHttpUrl(apiFileContent: string): string {
  // Kubo writes its API multiaddr as e.g. "/ip4/127.0.0.1/tcp/12345"; pkc-js needs "http://127.0.0.1:12345/api/v0"
  const match = apiFileContent.trim().match(/^\/ip4\/([\d.]+)\/tcp\/(\d+)$/)
  if (!match) throw new Error(`Unexpected kubo api multiaddr: ${apiFileContent}`)
  const [, host, port] = match
  return `http://${host}:${port}/api/v0`
}

async function startKubo(ipfsPath: string): Promise<{ process: ChildProcess; apiUrl: string }> {
  const env = { ...process.env, IPFS_PATH: ipfsPath }

  const init = spawnSync(kuboBinaryPath(), ['init', '--profile', 'test'], { env })
  if (init.status !== 0) {
    throw new Error(`ipfs init failed: ${init.stderr?.toString() ?? ''}`)
  }

  const daemon = spawn(kuboBinaryPath(), ['daemon', '--enable-pubsub-experiment', '--enable-namesys-pubsub'], { env })

  try {
    await new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null) => reject(new Error(`kubo exited before ready (code ${code})`))
      const onStdout = (chunk: Buffer) => {
        if (chunk.toString().includes('Daemon is ready')) {
          daemon.stdout?.off('data', onStdout)
          daemon.off('exit', onExit)
          resolve()
        }
      }
      daemon.stdout?.on('data', onStdout)
      daemon.on('exit', onExit)
    })

    const apiUrl = apiFileToHttpUrl(readFileSync(join(ipfsPath, 'api'), 'utf8'))
    return { process: daemon, apiUrl }
  } catch (err) {
    daemon.kill('SIGKILL')
    throw err
  }
}

async function stopKubo(daemon: ChildProcess): Promise<void> {
  if (daemon.exitCode !== null) return
  await new Promise<void>((resolve) => {
    daemon.once('exit', () => resolve())
    daemon.kill('SIGTERM')
    setTimeout(() => daemon.kill('SIGKILL'), 5_000).unref()
  })
}

export default async function setup(): Promise<() => Promise<void>> {
  if (process.env.PKC_RPC_WS_URL) {
    return async () => {}
  }

  const ipfsPath = mkdtempSync(join(tmpdir(), 'pkc-rpc-e2e-ipfs-'))
  const dataPath = mkdtempSync(join(tmpdir(), 'pkc-rpc-e2e-data-'))

  const kubo = await startKubo(ipfsPath)

  const server = await PKCRpc.PKCWsServer({
    port: E2E_RPC_PORT,
    pkcOptions: {
      dataPath,
      kuboRpcClientsOptions: [kubo.apiUrl],
      httpRoutersOptions: [],
    },
  })

  process.env.PKC_RPC_WS_URL = `ws://localhost:${E2E_RPC_PORT}`

  return async () => {
    await server.destroy()
    await stopKubo(kubo.process)
    rmSync(ipfsPath, { recursive: true, force: true })
    rmSync(dataPath, { recursive: true, force: true })
  }
}
