import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MemoryResourceScopeAccessParticipant } from '../src/modules/memory/application/ports/resourceScopeAccess'
import { composeResourceScopeAccessParticipant } from '../src/modules/resource-catalog/composition/resourceScopeAuthorization'
import type { DatabaseTransaction } from '../src/platform/persistence/databaseTransaction'

const root = join(import.meta.dir, '..')

// RFC-349 T4 立的是「memory 经 exact participant 拿 scope 访问档，provider 机制不外泄」；
// RFC-359 W4-D4 把 participant 收成一份中立实现（两个 provider 共用），本锁随之改指中立文件。
describe('RFC-349 Resource Catalog T4 resource-scope access participant', () => {
  test('Memory receives the exact async access participant bound to the neutral transaction', () => {
    const participant: MemoryResourceScopeAccessParticipant<DatabaseTransaction> =
      composeResourceScopeAccessParticipant()
    expect(Object.isFrozen(participant)).toBe(true)
  })

  test('the reads stay provider-neutral and the public contract names no provider', () => {
    const source = readFileSync(
      join(
        root,
        'src/modules/resource-catalog/infrastructure/aggregateAdapters/resourceScopeAuthorization.ts',
      ),
      'utf8',
    )
    expect(source).toContain('eq(resourceGrants.resourceType, scope.kind)')
    expect(source).toContain('await transaction')
    expect(source).not.toContain("from '@/db/client'")
    expect(source).not.toContain("from '@/db/txSync'")
    expect(source).not.toContain('PostgresqlDatabaseClient')
    expect(source).not.toContain(' as ')

    const publicParticipants = readFileSync(
      join(root, 'src/modules/resource-catalog/public/participants.ts'),
      'utf8',
    )
    // 端口归 memory（`application/ports/resourceScopeAccess.ts`）；resource-catalog 的 public 面不引 Actor、不点名事务句柄。
    expect(publicParticipants).not.toContain("from '@/auth/actor'")
    expect(publicParticipants).not.toContain('ResourceScopeAccessParticipant<')
    expect(publicParticipants).not.toContain('PostgresqlResourceScopeTransaction')
    expect(publicParticipants).not.toContain('PostgresqlDatabaseClient')
    expect(publicParticipants).not.toContain('ResourceScopeAuthorizationInTx')
  })
})
