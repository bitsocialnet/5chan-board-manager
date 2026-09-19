import { it, expect, vi } from 'vitest'
import { createServer, createConnection, type Socket } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { saveBoardConfig, saveGlobalConfig } from '../src/config-manager.js'
import {
  RPC_URL, createPkcRpc, createTestCommunity, publishThread, waitForThreadInPages,
  waitForThreadArchived, waitForArchivedInState, readStateFile,
} from './helpers.js'

// Drop only the manager's transport; the test's control connection and the
// real community keep running so threads can accumulate during the outage.
async function createRpcProxy() {
  const target = new URL(RPC_URL)
  const sockets = new Set<Socket>()
  const server = createServer((downstream) => {
    const upstream = createConnection({ host: target.hostname, port: Number(target.port) })
    sockets.add(downstream)
    sockets.add(upstream)
    downstream.on('error', () => upstream.destroy())
    upstream.on('error', () => downstream.destroy())
    downstream.on('close', () => { sockets.delete(downstream); upstream.destroy() })
    upstream.on('close', () => { sockets.delete(upstream); downstream.destroy() })
    downstream.pipe(upstream).pipe(downstream)
  })
  const listen = (port: number) => new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  await listen(0)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing proxy address')
  const url = new URL(RPC_URL)
  url.hostname = '127.0.0.1'
  url.port = String(address.port)
  return {
    url: url.href,
    async disconnect() {
      for (const socket of sockets) socket.destroy()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    reconnect: () => listen(address.port),
  }
}

function startDaemon(configDir: string) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../bin/run.js', import.meta.url)), 'start',
    '--config-dir', configDir, '--log-path', configDir,
  ], { env: { ...process.env, VITEST: 'true', DEBUG: '', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-20_000) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  return { child, exited, output: () => output }
}

async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 12_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

it('exits on RPC loss and resumes capacity archiving with fresh subscriptions after restart', async () => {
  const pkc = await createPkcRpc()
  const { sub, address } = await createTestCommunity(pkc)
  const dir = mkdtempSync(join(tmpdir(), 'board-manager-rpc-recovery-'))
  const statePath = join(dir, 'boards', address, 'state.json')
  const proxy = await createRpcProxy()
  const daemons: ReturnType<typeof startDaemon>[] = []
  const launch = () => { const daemon = startDaemon(dir); daemons.push(daemon); return daemon }
  try {
    saveGlobalConfig(dir, { rpcUrl: proxy.url })
    saveBoardConfig(dir, { address, perPage: 1, pages: 2 })
    const first = await publishThread(pkc, address, 'Before outage 1')
    await waitForThreadInPages(sub, first.cid)
    const second = await publishThread(pkc, address, 'Before outage 2')
    await waitForThreadInPages(sub, second.cid)

    const initial = launch()
    await vi.waitFor(() => expect(initial.output()).toContain('Started 1 board manager(s)'), { timeout: 30_000 })
    const signer = readStateFile(statePath).signers[address]

    await proxy.disconnect()
    await vi.waitFor(() => expect(initial.child.exitCode).toBe(1), { timeout: 15_000 })
    expect(initial.output()).toContain('RPC session lost or unavailable')
    expect(await initial.exited).toBe(1)

    // Docker's restart policy retries during an outage. This process must also
    // terminate, rather than holding the state lock and waiting indefinitely.
    const unavailable = launch()
    await vi.waitFor(() => expect(unavailable.child.exitCode).toBe(1), { timeout: 40_000 })
    expect(await unavailable.exited).toBe(1)

    const third = await publishThread(pkc, address, 'Arrived during outage')
    await waitForThreadInPages(sub, third.cid)
    await proxy.reconnect()
    const recovered = launch()
    await vi.waitFor(() => expect(recovered.output()).toContain('Started 1 board manager(s)'), { timeout: 40_000 })
    await waitForArchivedInState(statePath, first.cid)
    await waitForThreadArchived(sub, first.cid)
    expect(readStateFile(statePath).signers[address]).toEqual(signer)

    // Verify later notifications too, not just a one-time startup snapshot.
    const fourth = await publishThread(pkc, address, 'After recovery')
    await waitForThreadInPages(sub, fourth.cid)
    await waitForArchivedInState(statePath, second.cid)
    await waitForThreadArchived(sub, second.cid)
    expect(recovered.child.exitCode).toBeNull()
    await stopDaemon(recovered.child)
    expect(await recovered.exited).toBe(0)
  } finally {
    await Promise.all(daemons.map(({ child }) => stopDaemon(child)))
    await proxy.disconnect()
    await sub.stop()
    await pkc.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
})
