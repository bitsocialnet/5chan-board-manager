import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const ENTRYPOINT = resolve(import.meta.dirname, '..', 'bin', 'docker-entrypoint.sh')

/**
 * Run the real entrypoint script with the given args and return the value of DEBUG.
 * We source the script inside a subshell with `exec` overridden to a no-op so it
 * doesn't replace the shell, then print the resulting DEBUG value.
 */
function getDebugAfterEntrypoint(args: string[], env: Record<string, string> = {}): string {
  const quotedArgs = args.map(a => `'${a}'`).join(' ')
  const result = execFileSync('bash', ['-c', `
    exec() { :; }
    set -- ${quotedArgs}
    . '${ENTRYPOINT}'
    printf '%s' "\${DEBUG:-}"
  `], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf-8',
  })
  return result
}

describe('docker-entrypoint.sh', () => {
  it('sets DEBUG=5chan:* for "5chan start" command', () => {
    expect(getDebugAfterEntrypoint(['5chan', 'start'])).toBe('5chan:*')
  })

  it('sets DEBUG=5chan:* for "bitsocial daemon" command', () => {
    expect(getDebugAfterEntrypoint(['bitsocial', 'daemon'])).toBe('5chan:*')
  })

  it('does not set DEBUG for "5chan board list" command', () => {
    expect(getDebugAfterEntrypoint(['5chan', 'board', 'list'])).toBe('')
  })

  it('does not set DEBUG for "5chan board add" command', () => {
    expect(getDebugAfterEntrypoint(['5chan', 'board', 'add'])).toBe('')
  })

  it('does not set DEBUG for "bitsocial community list" command', () => {
    expect(getDebugAfterEntrypoint(['bitsocial', 'community', 'list'])).toBe('')
  })

  it('preserves user-provided DEBUG override for daemon commands', () => {
    expect(getDebugAfterEntrypoint(['5chan', 'start'], { DEBUG: 'custom:*' })).toBe('custom:*')
  })

  it('preserves user-provided DEBUG override for bitsocial daemon', () => {
    expect(getDebugAfterEntrypoint(['bitsocial', 'daemon'], { DEBUG: 'pkc:*' })).toBe('pkc:*')
  })
})
