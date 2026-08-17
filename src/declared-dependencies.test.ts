import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `@pkcprotocol/pkc-logger` was imported across src/ for a long time while only
// ever resolving as a transitive dependency of pkc-js. It worked, right up until
// pkc-js stopped depending on it — at which point the package would fail to start
// with no signal from the type checker or the lock file. This guards the whole
// class: anything imported by shipped code has to be declared by us.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Matches a bare npm package name, so template-literal fragments are ignored. */
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

// Anchored to real module syntax. A loose /from ['"]…['"]/ also matches prose
// inside log messages and test fixtures (e.g. "renamed from 'old.bso'").
const IMPORT_PATTERNS = [
  /^\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /^\s*export\s[^'"]*?from\s*['"]([^'"]+)['"]/gm,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path))
    } else if (/\.(ts|js|mjs)$/.test(entry)) {
      found.push(path)
    }
  }
  return found
}

/** Package names imported by `files`, mapped to the files importing them. */
function importedPackages(files: string[]): Map<string, string[]> {
  const packages = new Map<string, string[]>()

  for (const file of files) {
    const contents = readFileSync(file, 'utf-8')

    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = pattern.exec(contents)) !== null) {
        const specifier = match[1]
        if (!specifier) continue
        if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue
        if (builtinModules.includes(specifier)) continue

        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]
        if (!name || !PACKAGE_NAME.test(name)) continue

        const importers = packages.get(name) ?? []
        importers.push(file.slice(repoRoot.length + 1))
        packages.set(name, importers)
      }
    }
  }

  return packages
}

function readPackageJson(): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))
}

describe('declared dependencies', () => {
  it('declares every package that shipped code imports', () => {
    const pkg = readPackageJson()
    const runtimeDeps = new Set(Object.keys(pkg.dependencies ?? {}))

    // Only code that ends up in the published package — tests may use devDeps.
    const shipped = [...sourceFiles(join(repoRoot, 'src')), ...sourceFiles(join(repoRoot, 'bin'))]
      .filter((file) => !/\.test\.(ts|js|mjs)$/.test(file))

    const undeclared = [...importedPackages(shipped)]
      .filter(([name]) => !runtimeDeps.has(name))
      .map(([name, importers]) => `${name} (imported by ${[...new Set(importers)].join(', ')})`)

    expect(undeclared).toEqual([])
  })

  it('declares pkc-logger rather than relying on pkc-js to pull it in', () => {
    const pkg = readPackageJson()
    expect(pkg.dependencies?.['@pkcprotocol/pkc-logger']).toBeDefined()
  })

  it('pins the declared pkc-logger to the version actually installed', () => {
    const pkg = readPackageJson()
    const declared = pkg.dependencies?.['@pkcprotocol/pkc-logger']
    const installed = createRequire(import.meta.url)('@pkcprotocol/pkc-logger/package.json') as { version: string }

    // Exact pins only, per this repo's convention — no ^ or ~.
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/)
    expect(declared).toBe(installed.version)
  })
})
