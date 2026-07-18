// Regression guard for the repository test entrypoint.
//
// `bunfig.toml` intentionally scopes low-level `bun test` discovery to the
// backend. The documented repository gate must therefore dispatch backend,
// shared, and frontend explicitly; otherwise a local `bun run test` can be
// green while two workspaces were never executed.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface RootPackageJson {
  scripts?: Record<string, string>
}

const root = resolve(import.meta.dir, '..', '..', '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as RootPackageJson
const backendPkg = JSON.parse(
  readFileSync(resolve(root, 'packages', 'backend', 'package.json'), 'utf8'),
) as RootPackageJson
const ciWorkflow = readFileSync(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8')
const hardenedBackendCommand = 'bun test --isolate --randomize'

describe('repository test entrypoint', () => {
  test('bun run test dispatches backend, shared, and frontend in order', () => {
    expect(pkg.scripts?.test).toBe(
      'bun run test:backend && bun run test:shared && bun run test:frontend',
    )
    expect(pkg.scripts?.['test:backend']).toBe(hardenedBackendCommand)
    expect(pkg.scripts?.['test:shared']).toBe('bun run --filter @agent-workflow/shared test')
    expect(pkg.scripts?.['test:frontend']).toBe('bun run --filter @agent-workflow/frontend test')
  })

  test('every backend gate isolates files and randomizes execution order', () => {
    expect(backendPkg.scripts?.test).toBe(hardenedBackendCommand)
    expect(ciWorkflow).toContain(
      `run: ${hardenedBackendCommand} --coverage --coverage-reporter=text --coverage-reporter=lcov`,
    )
    expect(ciWorkflow).toContain(`run: ${hardenedBackendCommand}\n`)
  })

  test('low-level Bun discovery remains backend-only', () => {
    const bunfig = readFileSync(resolve(root, 'bunfig.toml'), 'utf8')
    expect(bunfig).toMatch(/\[test\][\s\S]*root\s*=\s*"packages\/backend\/tests"/)
  })
})
