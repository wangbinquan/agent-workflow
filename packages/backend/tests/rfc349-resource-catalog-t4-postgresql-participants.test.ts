import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MemoryResourceScopeAccessParticipant } from '../src/modules/memory/application/ports/resourceScopeAccess'
import { composePostgresqlResourceScopeAccessParticipant } from '../src/modules/resource-catalog/composition/postgresqlResourceScopeAuthorization'
import type { PostgresqlResourceScopeTransaction } from '../src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourceScopeAuthorization'

const root = join(import.meta.dir, '..')

describe('RFC-349 Resource Catalog T4 PostgreSQL participants', () => {
  test('Memory receives the exact async access participant for its PostgreSQL transaction', () => {
    const participant: MemoryResourceScopeAccessParticipant<PostgresqlResourceScopeTransaction> =
      composePostgresqlResourceScopeAccessParticipant()
    expect(Object.isFrozen(participant)).toBe(true)
  })

  test('the adapter stays provider-native and outside public contracts', () => {
    const source = readFileSync(
      join(
        root,
        'src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourceScopeAuthorization.ts',
      ),
      'utf8',
    )
    expect(source).toContain('eq(resourceGrants.resourceType, scope.kind)')
    expect(source).toContain('await transaction')
    expect(source).not.toContain("from '@/db/client'")
    expect(source).not.toContain("from '@/db/txSync'")
    expect(source).not.toContain(' as ')

    const publicParticipants = readFileSync(
      join(root, 'src/modules/resource-catalog/public/participants.ts'),
      'utf8',
    )
    expect(publicParticipants).not.toContain('PostgresqlResourceScopeTransaction')
    expect(publicParticipants).not.toContain('PostgresqlDatabaseClient')
  })
})
