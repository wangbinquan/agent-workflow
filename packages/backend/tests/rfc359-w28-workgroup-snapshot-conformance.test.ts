// The pure controls execute the three exact pre-W28 projection bodies. Private
// source exposure is not a provider execution; DB cases call the selected real
// package composition, and the existing W26 Intent controls run separately.
import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { eq } from 'drizzle-orm'
import { ZodError } from 'zod'
import {
  CreateAgentSchema,
  PackagePreviewSchema,
  PackageImportReceiptSchema,
  QUARANTINED_SNAPSHOT_AGENT_ID,
  WG_CLARIFY_BUDGET_DEFAULT,
  WorkgroupDraftSnapshotSchema,
  resolveWorkgroupOutputContract,
  type Workgroup,
  type WorkgroupDraftSnapshot,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { agents, users, workgroups, workgroupMembers, resourceBundleApplies } from '@/db/schema'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/infrastructure/mcpTransactionLifecycle'
import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import type { ComposedResourcePackageCatalog } from '@/modules/resource-catalog/composition/resourcePackageOperations'
import type { ResourcePackageImportDecision } from '@/modules/resource-catalog/application/package/ports'
import { workgroupRepositoryDependencies } from '@/modules/resource-catalog/composition/workgroupOperations'
import {
  createWorkgroupRepository,
  workgroupFromRows,
} from '@/modules/resource-catalog/infrastructure/workgroupRepository'
import { createAgentPersistenceValues } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import * as persistence from '@/modules/resource-catalog/infrastructure/workgroupPersistence'
import {
  normalizeWorkgroupSnapshot,
  workgroupDraftMemberOf,
} from '@/modules/resource-catalog/infrastructure/workgroupPersistence'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { createPostgresqlResourcePackageExecutionAdapter } from '@/services/resourcePackage/executionAdapter'
import { ValidationError } from '@/util/errors'
import { encodeZip } from '@/util/zip'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { composeSqliteResourcePackageCatalogForTest } from './helpers/resourcePackageProvider'

type Row = typeof workgroups.$inferSelect
type MemberRow = typeof workgroupMembers.$inferSelect
type SnapshotEntry = (row: Row, members: readonly MemberRow[]) => WorkgroupDraftSnapshot
const T0 = 1_700_000_000_000

function row(): Row {
  return {
    id: 'w24-group',
    name: 'member-codec',
    description: 'unchanged document',
    instructions: 'coordinate',
    mode: 'leader_worker',
    outputContract: 'discussion',
    leaderMemberId: 'm-lead',
    shareOutputs: false,
    directMessages: true,
    blackboard: false,
    maxRounds: 9,
    completionGate: true,
    clarifyBudget: 4,
    fanOut: true,
    version: 7,
    ownerUserId: 'opaque-owner',
    visibility: 'private',
    aclRevision: 3,
    schemaVersion: 1,
    createdAt: T0,
    updatedAt: T0 + 20,
  }
}

function members(): MemberRow[] {
  return [
    {
      id: 'm-zulu',
      workgroupId: 'w24-group',
      memberType: 'agent',
      agentName: 'Stored Zulu',
      agentId: 'a-zulu',
      userId: null,
      displayName: 'Zulu',
      roleDesc: 'implement 雪',
      sortOrder: 1,
      createdAt: T0,
    },
    {
      id: 'm-alpha',
      workgroupId: 'w24-group',
      memberType: 'human',
      agentName: null,
      agentId: null,
      userId: 'u-alpha',
      displayName: 'Alpha',
      roleDesc: 'review λ',
      sortOrder: 1,
      createdAt: T0,
    },
    {
      id: 'm-lead',
      workgroupId: 'w24-group',
      memberType: 'agent',
      agentName: 'Stored Lead',
      agentId: 'a-lead',
      userId: null,
      displayName: 'Lead',
      roleDesc: 'lead',
      sortOrder: 0,
      createdAt: T0,
    },
  ]
}

function originalWorkgroupDraftSnapshotOf(group: Workgroup): WorkgroupDraftSnapshot {
  const ordered = [...group.members].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName),
  )
  const leader = ordered.find((member) => member.id === group.leaderMemberId)
  return normalizeWorkgroupSnapshot({
    name: group.name,
    description: group.description,
    instructions: group.instructions,
    mode: group.mode,
    outputContract: resolveWorkgroupOutputContract(group.outputContract),
    ...(group.mode === 'leader_worker' && leader !== undefined
      ? { leaderDisplayName: leader.displayName }
      : {}),
    switches: { ...group.switches },
    maxRounds: group.maxRounds,
    completionGate: group.completionGate,
    clarifyBudget: group.clarifyBudget ?? WG_CLARIFY_BUDGET_DEFAULT,
    fanOut: group.fanOut ?? false,
    members: ordered.map((member) => workgroupDraftMemberOf(member, QUARANTINED_SNAPSHOT_AGENT_ID)),
  })
}

function originalWorkgroupSnapshotFromRows(
  row: typeof workgroups.$inferSelect,
  members: readonly (typeof workgroupMembers.$inferSelect)[],
): WorkgroupDraftSnapshot {
  const group = workgroupFromRows(row, members)
  const ordered = [...group.members].sort((left, right) => left.sortOrder - right.sortOrder)
  const leader = ordered.find((member) => member.id === group.leaderMemberId)
  return WorkgroupDraftSnapshotSchema.parse({
    name: group.name,
    description: group.description,
    instructions: group.instructions,
    mode: group.mode,
    outputContract: resolveWorkgroupOutputContract(group.outputContract),
    ...(group.mode === 'leader_worker' && leader !== undefined
      ? { leaderDisplayName: leader.displayName }
      : {}),
    switches: group.switches,
    maxRounds: group.maxRounds,
    completionGate: group.completionGate,
    clarifyBudget: group.clarifyBudget ?? 3,
    fanOut: group.fanOut ?? false,
    members: ordered.map((member) => workgroupDraftMemberOf(member, '')),
  })
}

function originalCurrentWorkgroupSnapshot(
  row: typeof workgroups.$inferSelect,
  memberRows: readonly (typeof workgroupMembers.$inferSelect)[],
): WorkgroupDraftSnapshot {
  const current = workgroupFromRows(row, memberRows)
  const ordered = [...current.members].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName),
  )
  const leader = ordered.find((member) => member.id === current.leaderMemberId)
  return WorkgroupDraftSnapshotSchema.parse({
    name: current.name,
    description: current.description,
    instructions: current.instructions,
    mode: current.mode,
    outputContract: resolveWorkgroupOutputContract(current.outputContract),
    ...(current.mode === 'leader_worker' && leader !== undefined
      ? { leaderDisplayName: leader.displayName }
      : {}),
    switches: current.switches,
    maxRounds: current.maxRounds,
    completionGate: current.completionGate,
    clarifyBudget: current.clarifyBudget ?? WG_CLARIFY_BUDGET_DEFAULT,
    fanOut: current.fanOut ?? false,
    members: ordered.map((member) => {
      if (member.memberType === 'agent' && member.agentId !== null) {
        return {
          memberType: 'agent',
          agentId: member.agentId,
          displayName: member.displayName,
          roleDesc: member.roleDesc,
        }
      }
      if (member.memberType === 'human' && member.userId !== null) {
        return {
          memberType: 'human',
          userId: member.userId,
          displayName: member.displayName,
          roleDesc: member.roleDesc,
        }
      }
      throw new ValidationError(
        'workgroup-member-row-corrupt',
        `workgroup member '${member.id}' has no canonical identity`,
      )
    }),
  })
}
const entries = [
  {
    name: 'repository',
    path: '../src/modules/resource-catalog/infrastructure/workgroupPersistence.ts',
    symbol: 'workgroupDraftSnapshotOf',
  },
  {
    name: 'intent',
    path: '../src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourcePorts.ts',
    symbol: 'workgroupSnapshotFromRows',
  },
  {
    name: 'package',
    path: '../src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms.ts',
    symbol: 'currentWorkgroupSnapshot',
  },
] as const
function currentBody(entry: (typeof entries)[number]): string {
  const path = fileURLToPath(new URL(entry.path, import.meta.url))
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const selected = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === entry.symbol,
  )
  if (selected.length !== 1) throw new Error(`expected one actual snapshot entry ${entry.symbol}`)
  return selected[0]!.getText(source).replace(/^export /, '')
}
function expose(
  body: string,
  options?: { group?: Workgroup; capture?: (snapshot: WorkgroupDraftSnapshot) => void },
): SnapshotEntry {
  const code = ts.transpileModule(`const selected = ${body}`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText
  const bindings = {
    workgroupFromRows: options?.group === undefined ? workgroupFromRows : () => options.group,
    WorkgroupDraftSnapshotSchema: {
      parse(snapshot: WorkgroupDraftSnapshot) {
        options?.capture?.(snapshot)
        return WorkgroupDraftSnapshotSchema.parse(snapshot)
      },
    },
    normalizeWorkgroupSnapshot: (snapshot: WorkgroupDraftSnapshot) => {
      options?.capture?.(snapshot)
      return normalizeWorkgroupSnapshot(snapshot)
    },
    resolveWorkgroupOutputContract,
    WG_CLARIFY_BUDGET_DEFAULT,
    QUARANTINED_SNAPSHOT_AGENT_ID,
    workgroupDraftMemberOf,
    ValidationError,
    workgroupSnapshotValues: Reflect.get(persistence, 'workgroupSnapshotValues'),
  }
  const result: unknown = new Function(...Object.keys(bindings), `${code}\nreturn selected`)(
    ...Object.values(bindings),
  )
  if (typeof result !== 'function') throw new Error('expected the actual projection function')
  return result as SnapshotEntry
}
function originalBody(name: (typeof entries)[number]['name']) {
  return name === 'repository'
    ? originalWorkgroupDraftSnapshotOf.toString()
    : name === 'intent'
      ? originalWorkgroupSnapshotFromRows.toString()
      : originalCurrentWorkgroupSnapshot.toString()
}
function outcome(action: () => unknown) {
  try {
    return { value: action(), error: undefined }
  } catch (error) {
    if (error instanceof ZodError)
      return {
        value: undefined,
        error: { name: error.name, message: error.message, issues: error.issues },
      }
    if (error instanceof ValidationError)
      return {
        value: undefined,
        error: { name: error.name, message: error.message, code: error.code },
      }
    throw error
  }
}
function invoke(entry: (typeof entries)[number], body: string, stored: Row, roster: MemberRow[]) {
  if (entry.name === 'repository')
    return (expose(body) as unknown as (group: Workgroup) => WorkgroupDraftSnapshot)(
      workgroupFromRows(stored, roster),
    )
  return expose(body)(stored, roster)
}
for (const entry of entries) {
  describe(`RFC359 W28 ${entry.name} original snapshot`, () => {
    test('nonempty tied roster, defaults and complete JSON keep the original result and input order', () => {
      for (const mode of ['leader_worker', 'free_collab'] as const) {
        const stored = { ...row(), mode }
        for (const value of [undefined, null, 0, 7]) {
          Object.defineProperty(stored, 'clarifyBudget', {
            value,
            enumerable: true,
            configurable: true,
          })
          const roster = members()
          const before = structuredClone(roster)
          const actual = invoke(entry, currentBody(entry), stored, roster)
          const original = invoke(entry, originalBody(entry.name), stored, roster)
          expect(actual).toEqual(original)
          expect(JSON.stringify(actual)).toBe(JSON.stringify(original))
          expect(Object.keys(actual)).toEqual(Object.keys(original))
          expect(actual.members.map((member) => member.displayName)).toEqual([
            'Lead',
            'Alpha',
            'Zulu',
          ])
          expect(roster).toEqual(before)
        }
      }
    })
    test('NULL, absent and empty identities retain the original native error or fallback', () => {
      for (const index of [0, 1])
        for (const value of [null, undefined, '']) {
          const roster = members()
          Object.defineProperty(roster[index]!, index === 0 ? 'agentId' : 'userId', {
            value,
            enumerable: true,
          })
          const actual = outcome(() => invoke(entry, currentBody(entry), row(), roster))
          const original = outcome(() => invoke(entry, originalBody(entry.name), row(), roster))
          expect(actual).toEqual(original)
          expect(JSON.stringify(actual)).toBe(JSON.stringify(original))
          if (entry.name === 'package' && value === null)
            expect(actual.error).toMatchObject({
              code: 'workgroup-member-row-corrupt',
              message: `workgroup member '${roster[index]!.id}' has no canonical identity`,
            })
        }
    })
    test('group and member getters, own descriptors and switches copy timing stay exact', () => {
      function observe(body: string, failure?: Error) {
        const reads: string[] = []
        const base = workgroupFromRows(row(), members())
        const watch = <T extends object>(value: T, label: string): T =>
          new Proxy(value, {
            get(target, key, receiver) {
              reads.push(`${label}:${String(key)}`)
              if (failure && label === 'group' && key === 'maxRounds') throw failure
              return Reflect.get(target, key, receiver)
            },
          })
        base.members = base.members.map((member, index) => watch(member, `member${index}`))
        const group = watch(base, 'group')
        let captured: unknown
        const fn = expose(body, {
          group,
          capture(snapshot) {
            captured = {
              keys: Object.keys(snapshot),
              descriptors: Object.getOwnPropertyDescriptors(snapshot),
              sameSwitches: snapshot.switches === base.switches,
            }
          },
        })
        try {
          const value =
            entry.name === 'repository'
              ? (fn as unknown as (group: Workgroup) => WorkgroupDraftSnapshot)(group)
              : fn(row(), members())
          return { reads, captured, value, error: undefined }
        } catch (error) {
          return { reads, captured, value: undefined, error }
        }
      }
      const actual = observe(currentBody(entry))
      expect(actual).toEqual(observe(originalBody(entry.name)))
      expect(actual.captured).toMatchObject({ sameSwitches: entry.name !== 'repository' })
      const failure = new Error('original maxRounds getter')
      const failed = observe(currentBody(entry), failure)
      expect(failed).toEqual(observe(originalBody(entry.name), failure))
      expect(failed.error).toBe(failure)
    })
  })
}
const OWNER = 'w28-snapshot-owner'
const AGENT = 'w28-snapshot-agent'
const actor = buildActor({
  user: { id: OWNER, username: OWNER, displayName: OWNER, role: 'admin', status: 'active' },
  source: 'daemon',
})
function packageBytes(revision: number): Uint8Array {
  const text = (value: string) => new TextEncoder().encode(value)
  return encodeZip([
    {
      path: 'manifest.yaml',
      bytes: text(
        `formatVersion: 1\nexportedAt: 0\nroot:\n  slug: snapshot-group\n  type: workgroup\n  name: snapshot-group\nresources:\n  - slug: snapshot-group\n    type: workgroup\n    name: snapshot-group\nrequirements: {}\nsecrets: []\ndanglingCallRefs: []\n`,
      ),
    },
    {
      path: 'bundle.json',
      bytes: text(
        JSON.stringify({
          bundleVersion: 1,
          rootRef: 'local:snapshot-group',
          ops: [
            {
              opId: 'op-1',
              kind: 'workgroup-create',
              slug: 'snapshot-group',
              payload: {
                name: 'snapshot-group',
                description: `revision ${revision}`,
                instructions: 'Coordinate 雪',
                mode: 'leader_worker',
                outputContract: 'discussion',
                switches: { shareOutputs: false, directMessages: true, blackboard: false },
                maxRounds: 9,
                completionGate: true,
                clarifyBudget: 0,
                fanOut: true,
                leaderDisplayName: 'Lead',
                members: [
                  {
                    memberType: 'agent',
                    agentRef: `external:${AGENT}`,
                    displayName: 'Zulu',
                    roleDesc: 'peer λ',
                    sortOrder: 1,
                  },
                  {
                    memberType: 'agent',
                    agentRef: `external:${AGENT}`,
                    displayName: 'Lead',
                    roleDesc: 'lead',
                    sortOrder: 0,
                  },
                ],
              },
            },
          ],
        }),
      ),
    },
  ])
}
async function physical(harness: ProviderHarness, id: string) {
  return {
    group: await harness.db.select().from(workgroups).where(eq(workgroups.id, id)).get(),
    members: await harness.db
      .select()
      .from(workgroupMembers)
      .where(eq(workgroupMembers.workgroupId, id))
      .orderBy(workgroupMembers.sortOrder)
      .all(),
    journal: await harness.db
      .select()
      .from(resourceBundleApplies)
      .orderBy(resourceBundleApplies.id)
      .all(),
  }
}
describeEachProvider('RFC359 W28 Workgroup snapshot real package and repository', (harness) => {
  const temporary: string[] = []
  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
  })
  async function fixture() {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-w28-snapshot-'))
    temporary.push(appHome)
    await harness.db.insert(users).values({ ...actor.user, createdAt: T0, updatedAt: T0 })
    await harness.db.insert(agents).values(
      createAgentPersistenceValues({
        id: AGENT,
        agent: CreateAgentSchema.parse({ name: AGENT }),
        ownerUserId: OWNER,
        now: T0,
      }),
    )
    const authority = new AuthorityClaimRegistry().mintLocalAuthority({
      userId: OWNER,
      source: 'system',
    })
    const context = { authority, operationId: 'w28-package', correlationId: 'w28-package', now: T0 }
    const box = createSecretBoxFromKey(randomBytes(32))
    function compose(): ComposedResourcePackageCatalog {
      if (harness.capabilities.isolation === 'exclusive')
        return composeSqliteResourcePackageCatalogForTest({
          db: harness.db as DbClient,
          appHome,
          box,
        })
      const db = harness.db as PostgresqlDatabaseClient
      const provider = composePostgresqlResourcePackageProvider({
        db,
        appHome,
        authorityResolver: { resolve: () => actor },
        mcpLifecycle: createMcpTransactionLifecycle(),
        capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({ db }),
        pluginInstaller: {
          plannedGenerationDirectory() {
            throw new Error('Workgroup must not install plugin files')
          },
          async install() {
            throw new Error('Workgroup must not install a plugin')
          },
        },
      })
      return composePostgresqlResourcePackageCatalog({
        provider,
        execution: createPostgresqlResourcePackageExecutionAdapter({
          box,
          provider,
          atomicApply: createPostgresqlResourcePackageAtomicApplyOperations({ db, box }),
        }),
      })
    }
    const catalog = compose()
    async function preview(bytes: Uint8Array) {
      const result = await catalog.operations.inspect.invoke(
        context,
        catalog.transport.stageInspect(actor, bytes),
      )
      const view = await catalog.operations.getPreview.invoke(context, result)
      return PackagePreviewSchema.parse(JSON.parse(view.document))
    }
    async function apply(
      bytes: Uint8Array,
      previewToken: string,
      decision: ResourcePackageImportDecision,
      target = catalog,
    ) {
      const result = await target.operations.apply.invoke(
        context,
        target.transport.stageApply(actor, {
          bytes,
          previewToken,
          decisions: [decision],
          humanMemberMappings: [],
          secretInputs: [],
        }),
      )
      const view = await target.operations.getReceipt.invoke(context, result)
      return PackageImportReceiptSchema.parse(JSON.parse(view.document))
    }
    return { compose, preview, apply }
  }
  test('actual package create, overwrite and replay retain stored snapshots and repository revisions', async () => {
    const f = await fixture()
    const bytes = packageBytes(1)
    const preview = await f.preview(bytes)
    const decision = { localSlug: 'snapshot-group', action: 'new' as const }
    const created = await f.apply(bytes, preview.previewToken, decision)
    if (created.root === undefined) throw new Error('Workgroup package root missing')
    const id = created.root.resourceId
    const before = await physical(harness, id)
    if (before.group === undefined) throw new Error('Workgroup row missing')
    expect(created.applied).toEqual([
      {
        opId: 'op-1',
        resourceType: 'workgroup',
        resourceId: id,
        action: 'create',
        name: 'snapshot-group',
      },
    ])
    expect(before.group).toEqual({
      id,
      name: 'snapshot-group',
      description: 'revision 1',
      instructions: 'Coordinate 雪',
      mode: 'leader_worker',
      outputContract: 'discussion',
      leaderMemberId: before.members[1]!.id,
      shareOutputs: false,
      directMessages: true,
      blackboard: false,
      maxRounds: 9,
      completionGate: true,
      clarifyBudget: 0,
      fanOut: true,
      version: 1,
      ownerUserId: OWNER,
      visibility: 'private',
      aclRevision: 0,
      schemaVersion: 1,
      createdAt: before.group.createdAt,
      updatedAt: before.group.createdAt,
    })
    expect(before.members).toEqual(
      ['Zulu', 'Lead'].map(
        (name, index): MemberRow => ({
          id: before.members[index]!.id,
          workgroupId: id,
          memberType: 'agent',
          agentName: AGENT,
          agentId: AGENT,
          userId: null,
          displayName: name,
          roleDesc: index === 0 ? 'peer λ' : 'lead',
          sortOrder: index,
          createdAt: before.group!.createdAt,
        }),
      ),
    )
    expect(before.journal).toHaveLength(1)
    expect(before.journal[0]?.state).toBe('committed')
    expect(await f.apply(bytes, preview.previewToken, decision, f.compose())).toEqual(created)
    expect(await physical(harness, id)).toEqual(before)
    const changedBytes = packageBytes(2)
    const changedPreview = await f.preview(changedBytes)
    const overwrite = { localSlug: 'snapshot-group', action: 'overwrite' as const, targetId: id }
    const updated = await f.apply(changedBytes, changedPreview.previewToken, overwrite)
    const after = await physical(harness, id)
    expect(updated.applied).toEqual([{ ...created.applied[0]!, action: 'update' as const }])
    expect(after.group).toEqual({
      ...before.group,
      description: 'revision 2',
      version: 2,
      updatedAt: after.group!.updatedAt,
    })
    expect(after.members).toEqual(before.members)
    expect(after.journal).toHaveLength(2)
    expect(
      await f.apply(changedBytes, changedPreview.previewToken, overwrite, f.compose()),
    ).toEqual(updated)
    expect(await physical(harness, id)).toEqual(after)
    const { repository, projection } = createWorkgroupRepository(
      harness.db,
      workgroupRepositoryDependencies({ db: harness.db, now: () => T0 }),
    )
    const group = await repository.get(id)
    if (group === null) throw new Error('real repository group missing')
    expect(group).toEqual({
      ...workgroupFromRows(after.group!, after.members),
      snapshotHash: persistence.workgroupSnapshotHashOf(originalWorkgroupDraftSnapshotOf(group)),
    })
    expect(JSON.stringify(projection.snapshotOf(group))).toBe(
      JSON.stringify(originalWorkgroupDraftSnapshotOf(group)),
    )
    expect(JSON.stringify(expose(currentBody(entries[2]))(after.group!, after.members))).toBe(
      JSON.stringify(originalCurrentWorkgroupSnapshot(after.group!, after.members)),
    )
  })
  test('real overwrite inside the outer transaction rolls back all group, member and receipt rows', async () => {
    const f = await fixture()
    const bytes = packageBytes(1)
    const preview = await f.preview(bytes)
    const created = await f.apply(bytes, preview.previewToken, {
      localSlug: 'snapshot-group',
      action: 'new',
    })
    if (created.root === undefined) throw new Error('Workgroup package root missing')
    const id = created.root.resourceId
    const before = await physical(harness, id)
    if (before.group === undefined) throw new Error('Workgroup row missing')
    const changed = packageBytes(3)
    const next = await f.preview(changed)
    const failure = new Error('rollback after actual package overwrite')
    await expect(
      harness.session.transaction(async (tx) => {
        const receipt = await f.apply(changed, next.previewToken, {
          localSlug: 'snapshot-group',
          action: 'overwrite',
          targetId: id,
        })
        expect(receipt.applied[0]?.action).toBe('update')
        const updated = await tx.select().from(workgroups).where(eq(workgroups.id, id)).get()
        expect(updated).toEqual({
          ...before.group!,
          description: 'revision 3',
          version: 2,
          updatedAt: updated!.updatedAt,
        })
        expect(await tx.select().from(resourceBundleApplies)).toHaveLength(2)
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await physical(harness, id)).toEqual(before)
  })
})
