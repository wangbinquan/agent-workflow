import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROUTE = resolve(import.meta.dir, '../src/routes/fusions.ts')

describe('RFC-349 fusion route provider composition', () => {
  test('mount requires closed FusionOperations and never receives a database client', () => {
    const source = readFileSync(ROUTE, 'utf8')

    expect(source).toContain('readonly operations: FusionOperations')
    expect(source).toContain('operations: deps.operations')
    expect(source).not.toMatch(/from ['"]@\/db(?:\/|['"])/)
    expect(source).not.toMatch(/\bdeps\.db\b/)
    expect(source).not.toMatch(/\bdb:\s*deps\.db\b/)
  })

  test('launch constructs the exact MemoryScopeAuthority pair', () => {
    const source = readFileSync(ROUTE, 'utf8')

    expect(source).toContain('const scopeAuthority: MemoryScopeAuthority')
    expect(source).toContain('actor,')
    expect(source).toContain('authority: directRequestAuthority(deps.directAuthority, actor)')
    expect(source).not.toContain('resourceScopeAuthorization')
    expect(source).not.toMatch(/\bauthorization:\s*/)
  })
})
