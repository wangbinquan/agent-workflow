// RFC-370: an upgrade points to the preceding entry's payload digest, never
// a second hash of the complete envelope (which already contains a digest).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { postgresqlMigrationDigest } from '@/platform/persistence/postgresqlMigrationSequence'

test('M1 PostgreSQL history links to the exact published M0 migration entry', () => {
  const directory = resolve(import.meta.dir, '../db/postgresql-migrations/meta')
  const previous = JSON.parse(
    readFileSync(resolve(directory, '0034_rfc370_m0_hosted_control_plane.upgrade.json'), 'utf8'),
  )
  const current = JSON.parse(
    readFileSync(resolve(directory, '0035_rfc370_m1_hosted_execution.upgrade.json'), 'utf8'),
  )
  const { digest, ...payload } = current
  expect(current.previousEntryDigest).toBe(previous.digest)
  expect(current.previousEntryDigest).not.toBe(postgresqlMigrationDigest(previous))
  expect(digest).toBe(postgresqlMigrationDigest(payload))
})
