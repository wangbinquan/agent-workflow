import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const participantPath = join(
  root,
  'src/modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourceParticipants.ts',
)
const portsPath = join(
  root,
  'src/modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourcePorts.ts',
)
const compositionPath = join(root, 'src/modules/resource-catalog/composition/intentApply.ts')
// RFC-359 W8：归属预检的两份 provider 副本（只差类型名前缀）合一到这里。**锚点跟着实现走**
// ——这两条断言原本打在 participant 文件里那段被抄了两份的函数体上；实现搬家后，继续钉旧位置
// 只会得到一个恒假（红）或恒真（更糟：默默失效）的断言。participant 那侧改钉「确实把预检委托
// 给了唯一那份实现」，判据本身钉在唯一那份实现上。
const preflightPath = join(
  root,
  'src/modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourcePreflight.ts',
)

describe('RFC-349 PostgreSQL Intent resource apply binding', () => {
  test('binds six exhaustive mutations to the caller-owned transaction', () => {
    const source = readFileSync(participantPath, 'utf8')
    const ports = readFileSync(portsPath, 'utf8')

    for (const kind of ['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup']) {
      expect(source).toContain(`case '${kind}':`)
      expect(source).toContain(`ports.${kind}.commitInTransaction({`)
      expect(ports).toMatch(
        new RegExp(`${kind}: create${kind[0]!.toUpperCase()}${kind.slice(1)}Port\\(\\s*options`),
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

    // RFC-395 II-a A5: workflows delegate to their single writer on the same transaction.
    // RFC-401 A1 / A3a: agents and workflows go through their one mutation participant on the same transaction; only
    // the workflow participant drives the definition writer.
    expect(source).toContain('const agents = createAgentMutationParticipant(transaction, { now })')
    expect(source).not.toContain('createAgentReferenceWriteParticipant')
    expect(source).toContain(
      'const workflows = createWorkflowMutationParticipant(transaction, { now })',
    )
    expect(source).not.toContain('createWorkflowDefinitionWriteParticipant')
    const workflowWriter = readFileSync(
      join(root, 'src/modules/resource-catalog/infrastructure/workflowDefinitionWrite.ts'),
      'utf8',
    )
    expect(workflowWriter).toContain('.insert(workflows)')
    expect(workflowWriter).toContain('.update(workflows)')
    // RFC-401 T5: skill rows (and version rows) go through the one skill write participant on the same transaction.
    expect(source).toContain('const skillWrites = createSkillMutationParticipant(transaction)')
    for (const table of ['skills', 'skillVersions']) {
      expect(source).not.toMatch(
        new RegExp(`(?:\\.insert\\(\\s*${table}\\s*\\)|\\binsertOne\\([^,]+,\\s*${table}\\s*,)`),
      )
      expect(source).not.toContain(`.update(${table})`)
    }
    // RFC-401 A3b: workgroup rows and member rows go through the one Workgroup mutation participant.
    expect(source).toContain('const workgroups = createWorkgroupMutationParticipant(transaction, {')
    expect(source).not.toMatch(/\.(?:insert|update)\(\s*workgroups\s*\)|workgroupMembers\s*,/)
    // RFC-401 A2: MCP and plugin rows go through their one participant on the same transaction.
    for (const [table, factory] of [
      ['mcps', 'createMcpMutationParticipant'],
      ['plugins', 'createPluginMutationParticipant'],
    ]) {
      expect(source).toContain(`${factory}(transaction, {`)
      expect(source).not.toMatch(
        new RegExp(`(?:\\.insert\\(\\s*${table}\\s*\\)|\\binsertOne\\([^,]+,\\s*${table}\\s*,)`),
      )
      expect(source).not.toContain(`.update(${table})`)
    }
    expect(source).toContain('ownerUserId: actor.user.id')
    expect(source).toContain('requireOwner(actor,')
    expect(source).toContain('plan.expectedRevision.updatedAt')
    expect(source).toContain('plan.expectedRevision.configHash')
    expect(source).toContain('plan.expectedRevision.token')
    expect(source).toContain('plan.expectedRevision.version')
    // RFC-401 A1–A3：引用的存在与可见由各类唯一的写入参与者按普通编辑的判据报，Intent 端口不再自带一份。
    expect(source).not.toContain('assertVisibleReferences(')
  })

  test('keeps preflight and durable artifact lifecycle explicit', () => {
    const source = readFileSync(participantPath, 'utf8')
    const ports = readFileSync(portsPath, 'utf8')

    const preflight = readFileSync(preflightPath, 'utf8')

    expect(source).toContain('preflight(')
    // participant 只负责把会话的 actor 交给唯一那份预检，不再自带一份判据。
    expect(source).toContain('return resolveIntentApplyResourcePreflight(')
    expect(source).toContain('options.actor.user.id')
    // 判据本体：copy-only 按 manifest 行的真实 owner 判（RFC-401 T5 起不再取占用名）。
    expect(preflight).not.toContain('listOwnedNames(')
    expect(preflight).toContain('getOwner(entry.resourceType, entry.resourceId)')
    expect(source).toContain('recordArtifact(artifact: IntentApplyArtifact)')
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

    expect(source).toContain('IntentApplyResourcePortFactoryDependencies')
    expect(source).toContain('createIntentApplyResourcePortFactory(input)')
    expect(source).toContain('aclIdentities: ResourceCatalogAclIdentityReadPort')
    expect(source).toContain('factory.create(options)')
    expect(participant).toContain('readonly actor: DirectAuthenticatedAuthority')
    expect(participant).toContain('if (authority !== options.authority)')
    expect(source).not.toContain('DbClient')
    expect(source).not.toContain('DbTxSync')
  })
})
