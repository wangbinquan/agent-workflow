// RFC-349 — the Memory HTTP surface consumes one provider-selected catalog.
//
// This source lock exists because a SQLite fallback at the route boundary would
// make the PostgreSQL migration look healthy while requests still reopen the
// legacy database. Provider selection belongs to bootstrap; transport receives
// only the closed Memory catalog contract.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src')

describe('RFC-349 Memory provider boundary', () => {
  test('the HTTP route consumes MemoryCatalogOperations without a database client', () => {
    const source = readFileSync(resolve(SRC, 'routes', 'memories.ts'), 'utf8')

    expect(source).toContain('MemoryCatalogOperations')
    expect(source).toContain('catalog.queries')
    expect(source).toContain('catalog.commands')
    expect(source).not.toContain("from '@/services/memory'")
    expect(source).not.toMatch(/\bdeps\.db\b/)
    expect(source).not.toMatch(/\bDbClient\b/)
  })

  test('bootstrap injects the selected catalog and keeps SQLite fallback out of transport', () => {
    const server = readFileSync(resolve(SRC, 'server.ts'), 'utf8')

    expect(server).toContain('deps.memoryOperations.catalog ??')
    expect(server).toContain('mountMemoryRoutes(app, memoryCatalog')
  })
})
