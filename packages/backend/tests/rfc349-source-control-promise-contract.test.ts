// RFC-349 — guards the source-control provider boundary: application/public/
// composition stay provider-neutral and every credential operation is async.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..')

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8')
}

describe('RFC-349 source-control Promise contract', () => {
  test('provider mechanisms remain sealed in infrastructure adapters', () => {
    const neutralFiles = [
      'packages/backend/src/modules/source-control/application/repositoryTransportCredentials.ts',
      'packages/backend/src/modules/source-control/ports/repositoryTransportCredentialRepository.ts',
      'packages/backend/src/modules/source-control/public/commands.ts',
      'packages/backend/src/modules/source-control/public/queries.ts',
      'packages/backend/src/modules/source-control/public/participants.ts',
      'packages/backend/src/modules/source-control/composition.ts',
      'packages/backend/src/modules/source-control/composition/repositoryPublicationTransport.ts',
      'packages/backend/src/services/codeHost/connections.ts',
    ]
    for (const path of neutralFiles) {
      const source = read(path)
      expect(source).not.toContain("from '@/db/client'")
      expect(source).not.toContain("from '@/db/schema'")
      expect(source).not.toContain("from '@/db/txSync'")
      expect(source).not.toContain('PostgresqlDatabaseClient')
    }

    const postgresql = read(
      'packages/backend/src/modules/source-control/infrastructure/postgresqlRepositoryTransportCredentialRepository.ts',
    )
    expect(postgresql).toContain('type { PostgresqlDatabaseClient }')
    expect(postgresql).not.toMatch(/\bas\s+(?:unknown\s+as\s+)?DbClient\b/)
    expect(postgresql).not.toContain('dbTxSync')
    expect(postgresql).not.toContain('bun:sqlite')
  })

  test('public credential commands, queries, and selection return Promises', () => {
    const commands = read('packages/backend/src/modules/source-control/public/commands.ts')
    const queries = read('packages/backend/src/modules/source-control/public/queries.ts')
    const participants = read('packages/backend/src/modules/source-control/public/participants.ts')
    expect(commands).toContain('Promise<OwnCodeHostPushCredentialSummary>')
    expect(commands).toContain('Promise<{ readonly removed: boolean }>')
    expect(queries).toContain('Promise<OwnCodeHostPushCredentialList>')
    expect(participants).toContain('Promise<RepositoryTransportCredentialSelection>')
  })

  test('repository transport HTTP consumers await the provider-neutral contracts', () => {
    const account = read('packages/backend/src/routes/accountRepositoryTransportCredentials.ts')
    const connections = read('packages/backend/src/services/codeHost/connections.ts')
    const routes = read('packages/backend/src/routes/codeHosts.ts')

    expect(account).toContain('return await operation()')
    expect(account).toContain('await credentials.resolvePersonalForTest(')
    expect(connections).toContain(
      'interface RepositoryTransportConnectionAdministrationParticipant',
    )
    expect(connections).toContain(
      'await repositoryTransport.synchronizeAdminConnection(values, impact)',
    )
    expect(connections).not.toContain('dbTxSync')
    expect(routes).toContain('await service.upsert(')
    expect(routes).toContain('await service.remove(')
    expect(routes).toContain('await service.resolve(')
  })

  test('publication composition consumes an injected closed repository', () => {
    const source = read(
      'packages/backend/src/modules/source-control/composition/repositoryPublicationTransport.ts',
    )
    expect(source).toContain('readonly repository: RepositoryTransportCredentialRepository')
    expect(source).toContain('await repository.listConnections()')
    expect(source).toContain('await credentialSupply.resolveExecution(')
    expect(source).toContain('await repository.findConnection(')
    expect(source).not.toContain('new SQLiteRepositoryTransportCredentialRepository')
  })
})
