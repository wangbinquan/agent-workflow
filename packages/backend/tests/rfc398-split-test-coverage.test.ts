// RFC-398: two long process / PostgreSQL matrices register one unit per test file so the backend
// CI shards stay inside their 15-minute budget (CI run 41287820486: the combined resume file needed
// about 26 minutes and its shard was cancelled; the two bridge releases took 4.6 minutes together).
// Bun shards by file. Splitting must never drop coverage: every unit keeps exactly one file named
// after it.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { POSTGRESQL_RESUME_POINTS, RESUME_POINTS } from './helpers/rfc398AutoUpgradeResume'
import { BRIDGE_RELEASE_TAGS } from './helpers/rfc398PostgresqlBridge'

function registrations(prefix: RegExp, call: RegExp) {
  return readdirSync(import.meta.dir)
    .filter((name) => prefix.test(name))
    .map((name) => {
      const calls = [...readFileSync(join(import.meta.dir, name), 'utf8').matchAll(call)]
      expect({ name, calls: calls.length }).toEqual({ name, calls: 1 })
      return { name, groups: calls[0]!.slice(1) }
    })
}

test('every SQLite and PostgreSQL resume point is registered by exactly one file named after it', () => {
  const sqlite: string[] = []
  const postgresql: string[] = []
  for (const { name, groups } of registrations(
    /^rfc398-auto-upgrade-resume.*\.test\.ts$/,
    /register(Postgresql)?ResumePoint\('([^']+)'\)/g,
  )) {
    const [engine, point] = groups
    expect(name).toBe(`rfc398-auto-upgrade-resume-${engine ? 'postgresql-' : ''}${point}.test.ts`)
    ;(engine ? postgresql : sqlite).push(point!)
  }
  expect(sqlite.sort()).toEqual([...RESUME_POINTS].sort())
  expect(postgresql.sort()).toEqual([...POSTGRESQL_RESUME_POINTS].sort())
  // The approved matrix: 18 SQLite points and 3 PostgreSQL points, each killed as child, parent
  // and both.
  expect([RESUME_POINTS.length, POSTGRESQL_RESUME_POINTS.length]).toEqual([18, 3])
})

test('every released PostgreSQL source has exactly one bridge file named after it', () => {
  const tags = registrations(
    /^rfc398-postgresql-bridge.*\.test\.ts$/,
    /registerBridgeRelease\('([^']+)'\)/g,
  ).map(({ name, groups }) => {
    const [tag] = groups
    expect(name).toBe(`rfc398-postgresql-bridge-${tag!.replaceAll('.', '_')}.test.ts`)
    return tag!
  })
  expect(tags.sort()).toEqual([...BRIDGE_RELEASE_TAGS].sort())
  expect(BRIDGE_RELEASE_TAGS).toEqual(['v0.18.18', 'v0.18.19'])
})
