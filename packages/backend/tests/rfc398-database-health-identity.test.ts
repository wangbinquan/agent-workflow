// RFC-398 design §2.7 / §3.6: both dialects supply health identity and profile syntax.
import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createDatabaseHealthIdentity } from '@/platform/persistence/databaseHealthIdentity'
import { persistenceDialect } from '@/platform/persistence/nativeDialect'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-398 database identity', (harness) => {
  test('reports the actual selected database name or the embedded absence', async () => {
    const server = harness.capabilities.isolation === 'read-committed'
    const provider = server ? 'postgresql' : 'sqlite'
    const actual = await createDatabaseHealthIdentity(harness.db, provider)()
    const expected = server
      ? String((await rawRows(harness.db, sql`SELECT current_database() AS name`))[0]!.name)
      : null
    expect(actual).toEqual({ provider, databaseName: expected })
    expect(harness.capabilities.databaseName() === null).toBe(!server)
  })
})

test('profile reference syntax is provided by both dialects without changing validation', () => {
  const embedded = persistenceDialect('sqlite')
  expect(embedded.isProfileRef('env:SOURCE')).toBe(false)
  expect(() => embedded.environmentProfileRef('SOURCE')).toThrow(
    'sqlite-profile-reference-unsupported',
  )
  const server = persistenceDialect('postgresql')
  const reference = server.environmentProfileRef('SOURCE', '库?#%')
  expect(server.isProfileRef(reference)).toBe(true)
  expect(server.isProfileRef('crewstation:source', 'source')).toBe(true)
  expect(server.isProfileRef('crewstation:source', 'target')).toBe(false)
  expect(server.isProfileRef('env:SOURCE/bad%2Fname')).toBe(false)
  expect(() => server.environmentProfileRef('SOURCE', 'x'.repeat(64))).toThrow(
    'postgresql-profile-reference-invalid',
  )
})
