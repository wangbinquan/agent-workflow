import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const participantPath = join(
  root,
  'src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourceParticipants.ts',
)
const portsPath = join(
  root,
  'src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourcePorts.ts',
)
const compositionPath = join(root, 'src/modules/resource-catalog/composition/intentApply.ts')

describe('RFC-349 PostgreSQL Intent resource apply binding', () => {
  test('binds six exhaustive mutations to the caller-owned transaction', () => {
    const source = readFileSync(participantPath, 'utf8')
    const ports = readFileSync(portsPath, 'utf8')

    for (const kind of ['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup']) {
      expect(source).toContain(`case '${kind}':`)
      expect(source).toContain(`ports.${kind}.commitInTransaction({`)
      expect(ports).toContain(
        `${kind}: create${kind[0]!.toUpperCase()}${kind.slice(1)}Port(options`,
      )
    }
    expect(source).toContain('readonly transaction: PostgresqlResourceCatalogTransaction')
    expect(source).not.toContain('runPostgresqlResourceCatalogTransaction')
    expect(ports).not.toContain('runPostgresqlResourceCatalogTransaction')
    expect(source).not.toContain("from '@/db/client'")
    expect(source).not.toContain("from '@/db/txSync'")
    expect(ports).not.toContain("from '@/services/")
    expect(ports).not.toContain("from '@/db/client'")
    expect(ports).not.toContain("from '@/db/txSync'")
    expect(source).not.toContain('SQLite')
    expect(ports).not.toContain('SQLite')
    expect(source).not.toContain(' as unknown as ')
    expect(ports).not.toContain(' as unknown as ')
  })

  test('owns the six PostgreSQL aggregate arms and their revisions', () => {
    const source = readFileSync(portsPath, 'utf8')

    for (const table of ['agents', 'skills', 'mcps', 'plugins', 'workflows', 'workgroups']) {
      expect(source).toContain(`.insert(${table})`)
      expect(source).toContain(`.update(${table})`)
    }
    expect(source).toContain('ownerUserId: actor.user.id')
    expect(source).toContain('requireOwner(actor,')
    expect(source).toContain('plan.expectedRevision.updatedAt')
    expect(source).toContain('plan.expectedRevision.configHash')
    expect(source).toContain('plan.expectedRevision.token')
    expect(source).toContain('plan.expectedRevision.version')
    expect(source).toContain('assertVisibleReferences(')
  })

  test('keeps preflight and durable artifact lifecycle explicit', () => {
    const source = readFileSync(participantPath, 'utf8')
    const ports = readFileSync(portsPath, 'utf8')

    expect(source).toContain('preflight(')
    expect(source).toContain('listOwnedNames(type, ownerUserId)')
    expect(source).toContain('getOwner(entry.resourceType, entry.resourceId)')
    expect(source).toContain('recordArtifact(artifact: PostgresqlIntentApplyArtifact)')
    expect(source).toContain('rollForwardCommitted?')
    expect(source).toContain('abortPrepared?')
    expect(source).toContain('readonly databaseCommitted: boolean')
    expect(ports.indexOf('recordArtifact(prepared.install.artifact)')).toBeLessThan(
      ports.indexOf('prepared.install.stage()'),
    )
    expect(ports.indexOf('recordArtifact(prepared.stage.artifact)')).toBeLessThan(
      ports.indexOf('prepared.stage.stage()'),
    )
    expect(ports).toContain('await prepared.stage.compensate()')
    expect(ports).toContain('await prepared.stage.rollForward()')
  })

  test('promotes only the successful transaction attempt tail', () => {
    const source = readFileSync(participantPath, 'utf8')

    expect(source).toContain('const attemptTail: Array<() => Promise<void>> = []')
    expect(source).toContain('const attemptRollForwardTail: Array<() => Promise<void>> = []')
    expect(source).toContain('commitSucceeded()')
    expect(source).toContain('committedRollForwardTail.push(...attemptRollForwardTail)')
    expect(source).toContain('committedAfterTail.push(...attemptTail)')
  })

  test('composition owns the concrete factory and requires exact identities', () => {
    const source = readFileSync(compositionPath, 'utf8')
    const participant = readFileSync(participantPath, 'utf8')

    expect(source).toContain('PostgresqlIntentApplyResourcePortFactoryDependencies')
    expect(source).toContain('createPostgresqlIntentApplyResourcePortFactory(input)')
    expect(source).toContain('aclIdentities: ResourceCatalogAclIdentityReadPort')
    expect(source).toContain('factory.create(options)')
    expect(participant).toContain('readonly actor: DirectAuthenticatedAuthority')
    expect(participant).toContain('if (authority !== options.authority)')
    expect(source).not.toContain('DbClient')
    expect(source).not.toContain('DbTxSync')
  })
})
