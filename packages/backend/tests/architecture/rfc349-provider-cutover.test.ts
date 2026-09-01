// RFC-349 T2/T5/T6 — provider cutover is a production architecture contract,
// not a collection of PostgreSQL adapter unit tests.  The migration is not
// source-complete while business/application/transport code still imports the
// SQLite DB surface or while a compiled daemon bypasses the verified generation
// pointer and opens db.sqlite directly.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { backendUnits, importEdges, moduleLocation, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const units = backendUnits(REPO_ROOT)

function isBusinessOrTransport(unit: SourceUnit): boolean {
  const location = moduleLocation(unit.path)
  if (location !== null) {
    const layer = location.rest.split('/')[0]
    return layer === 'application' || layer === 'domain' || layer === 'engine' || layer === 'public'
  }
  // `auth` predates the bounded-context module layout. Its provider adapters
  // and root composition are infrastructure even though the directory itself
  // sits beside the transport folders. Keep the application and compatibility
  // facades in the negative corpus; only the explicit provider-owning surfaces
  // are exempt from the transport rule.
  if (/\/src\/auth\/infrastructure\//.test(unit.path)) return false
  if (/\/src\/auth\/composition\.ts$/.test(unit.path)) return false
  return /\/src\/(?:auth|mcp|routes|services|ws)\//.test(unit.path)
}

function isDatabaseMechanism(specifier: string): boolean {
  return (
    /^@\/db(?:\/|$)/.test(specifier) ||
    specifier === 'bun:sqlite' ||
    specifier === 'drizzle-orm' ||
    specifier.startsWith('drizzle-orm/')
  )
}

function unit(path: string): SourceUnit {
  const found = units.find((candidate) => candidate.path === path)
  if (found === undefined) throw new Error(`missing production source ${path}`)
  return found
}

describe('RFC-349 provider cutover', () => {
  test('business, application, public and transport surfaces own ports instead of DB mechanisms', () => {
    const violations = units
      .filter(isBusinessOrTransport)
      .flatMap((source) =>
        importEdges(source)
          .filter((edge) => isDatabaseMechanism(edge.specifier))
          .map((edge) => `${source.path} -> ${edge.specifier}`),
      )
      .sort()

    expect(violations).toEqual([])
  })

  test('daemon bootstrap selects the verified provider and mounts live migration admission', () => {
    const source = unit('packages/backend/src/cli/start.ts').text

    expect(source).not.toMatch(/from\s+['"]@\/db\/client['"]/) // provider factory owns SQLite
    expect(source).toContain('resolveDatabaseProviderRuntime')
    expect(source).toContain('createDatabaseMigrationDaemonAdmission')
    expect(source).toContain('databaseMigration:')
    expect(source).toContain('.runBusinessRequest(')
  })

  test('standalone CLI bootstraps do not silently reopen SQLite after PostgreSQL cutover', () => {
    const source = unit('packages/backend/src/main.ts').text

    expect(source).not.toMatch(/from\s+['"]\.\/db\/client['"]/) // user/package/ops share provider bootstrap
    expect(source).not.toMatch(/\bopenDb\s*\(/)
    expect(source).toContain('resolveDatabaseProviderRuntime')
  })
})
