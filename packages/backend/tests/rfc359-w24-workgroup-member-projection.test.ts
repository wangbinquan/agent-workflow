// Pure exposure executes the actual private Intent snapshot function body with
// its real codec dependencies. This is not a PostgreSQL factory/DB execution.
// Database cases below use the real dual-provider repository fixture.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { eq } from 'drizzle-orm'
import {
  QUARANTINED_SNAPSHOT_AGENT_ID,
  WG_CLARIFY_BUDGET_DEFAULT,
  WorkgroupDraftSnapshotSchema,
  resolveWorkgroupOutputContract,
  serializeWorkgroupEditableSnapshotV1,
  type Workgroup,
  type WorkgroupDraftMember,
  type WorkgroupDraftSnapshot,
  type WorkgroupMember,
} from '@agent-workflow/shared'
import { ZodError } from 'zod'
import { workgroupMembers, workgroups } from '@/db/schema'
import { workgroupRepositoryDependencies } from '@/modules/resource-catalog/composition/workgroupOperations'
import * as persistence from '@/modules/resource-catalog/infrastructure/workgroupPersistence'
import { normalizeWorkgroupSnapshot } from '@/modules/resource-catalog/infrastructure/workgroupPersistence'
import {
  createWorkgroupRepository,
  workgroupFromRows,
} from '@/modules/resource-catalog/infrastructure/workgroupRepository'
import { rowToWorkgroup } from '@/modules/resource-catalog/infrastructure/legacy/workgroups'
import { describeEachProvider } from './helpers/eachProvider'

type Row = typeof workgroups.$inferSelect
type MemberRow = typeof workgroupMembers.$inferSelect
type MemberProjection = (member: WorkgroupMember) => WorkgroupDraftMember
type IntentSnapshot = (row: Row, members: readonly MemberRow[]) => WorkgroupDraftSnapshot
const T0 = 1_700_000_000_000

// Exact old outer functions. Their callbacks differ only in the agent fallback.
function originalSnapshot(group: Workgroup): WorkgroupDraftSnapshot {
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
    members: ordered.map((member) =>
      member.memberType === 'agent'
        ? {
            memberType: 'agent' as const,
            agentId: member.agentId ?? QUARANTINED_SNAPSHOT_AGENT_ID,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          }
        : {
            memberType: 'human' as const,
            userId: member.userId ?? '',
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          },
    ),
  })
}

function originalIntentSnapshot(
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
    members: ordered.map((member) =>
      member.memberType === 'agent'
        ? {
            memberType: 'agent',
            agentId: member.agentId ?? '',
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          }
        : {
            memberType: 'human',
            userId: member.userId ?? '',
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          },
    ),
  })
}

function exposeFunction<T>(expression: string): T {
  const code = ts.transpileModule(`const selected = ${expression}`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText
  const factory = new Function(
    'workgroupFromRows',
    'WorkgroupDraftSnapshotSchema',
    'resolveWorkgroupOutputContract',
    'QUARANTINED_SNAPSHOT_AGENT_ID',
    'workgroupDraftMemberOf',
    'workgroupSnapshotValues',
    `${code}\nreturn selected`,
  )
  const result: unknown = factory(
    workgroupFromRows,
    WorkgroupDraftSnapshotSchema,
    resolveWorkgroupOutputContract,
    QUARANTINED_SNAPSHOT_AGENT_ID,
    Reflect.get(persistence, 'workgroupDraftMemberOf'),
    persistence.workgroupSnapshotValues,
  )
  if (typeof result !== 'function') throw new Error('expected an exposed codec function')
  return result as T
}

function sourceEntry(relative: string, name: string) {
  const path = fileURLToPath(new URL(relative, import.meta.url))
  const text = readFileSync(path, 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const selected = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  )
  if (selected.length !== 1) throw new Error(`expected one codec entry: ${name}`)
  const entry = selected[0]!
  const callbacks: ts.Expression[] = []
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'map' &&
      node.expression.expression.getText(source) === 'ordered'
    )
      callbacks.push(node.arguments[0]!)
    ts.forEachChild(node, visit)
  }
  visit(entry)
  if (callbacks.length !== 1) throw new Error(`expected one ordered member projection: ${name}`)
  return { entry: entry.getText(source), callback: callbacks[0]!.getText(source) }
}

const commonSource = sourceEntry(
  '../src/modules/resource-catalog/infrastructure/workgroupPersistence.ts',
  'workgroupDraftSnapshotOf',
)
const intentSource = sourceEntry(
  '../src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourcePorts.ts',
  'workgroupSnapshotFromRows',
)
const commonMember = exposeFunction<MemberProjection>(commonSource.callback)
const intentMember = exposeFunction<MemberProjection>(intentSource.callback)
const intentSnapshot = exposeFunction<IntentSnapshot>(intentSource.entry)

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

function originalMember(member: WorkgroupMember, missingAgentId: string): WorkgroupDraftMember {
  return member.memberType === 'agent'
    ? {
        memberType: 'agent',
        agentId: member.agentId ?? missingAgentId,
        displayName: member.displayName,
        roleDesc: member.roleDesc,
      }
    : {
        memberType: 'human',
        userId: member.userId ?? '',
        displayName: member.displayName,
        roleDesc: member.roleDesc,
      }
}

function issueResult(run: () => unknown) {
  try {
    run()
  } catch (error) {
    if (!(error instanceof ZodError)) throw error
    return { name: error.name, message: error.message, issues: error.issues }
  }
  throw new Error('expected the original schema failure')
}

function memberWithReads(member: WorkgroupMember, reads: string[]): WorkgroupMember {
  const tracked = { ...member }
  for (const key of Object.keys(member)) {
    Object.defineProperty(tracked, key, {
      configurable: true,
      enumerable: true,
      get() {
        reads.push(key)
        return Reflect.get(member, key)
      },
    })
  }
  return tracked
}

describe('RFC359 original Workgroup member projection contracts', () => {
  for (const [label, project, fallback] of [
    ['repository', commonMember, QUARANTINED_SNAPSHOT_AGENT_ID],
    ['intent', intentMember, ''],
  ] as const) {
    test(`${label}: complete own fields, descriptors and getter order retain the original projection`, () => {
      for (const member of workgroupFromRows(row(), members()).members) {
        for (const id of [undefined, null, '', '雪-λ-🙂'] as const) {
          const value = { ...member }
          Object.defineProperty(value, member.memberType === 'agent' ? 'agentId' : 'userId', {
            value: id,
            enumerable: true,
            configurable: true,
          })
          Object.defineProperty(value, 'roleDesc', { value: undefined, enumerable: true })
          const actualReads: string[] = []
          const oldReads: string[] = []
          const actual = project(memberWithReads(value, actualReads))
          const old = originalMember(memberWithReads(value, oldReads), fallback)
          expect(actual).toEqual(old)
          expect(Object.keys(actual)).toEqual(Object.keys(old))
          expect(JSON.stringify(actual)).toBe(JSON.stringify(old))
          expect(Object.getOwnPropertyDescriptors(actual)).toEqual(
            Object.getOwnPropertyDescriptors(old),
          )
          expect(Object.getPrototypeOf(actual)).toBe(Object.prototype)
          expect(actualReads).toEqual(oldReads)
          expect(Object.hasOwn(actual, member.memberType === 'agent' ? 'userId' : 'agentId')).toBe(
            false,
          )
        }
      }
    })
  }

  test('both complete original snapshot entries preserve nonempty JSON and member order', () => {
    const stored = members()
    const group = workgroupFromRows(row(), stored)
    expect(JSON.stringify(persistence.workgroupDraftSnapshotOf(group))).toBe(
      JSON.stringify(originalSnapshot(group)),
    )
    expect(JSON.stringify(intentSnapshot(row(), stored))).toBe(
      JSON.stringify(originalIntentSnapshot(row(), stored)),
    )
    expect(intentSnapshot(row(), stored).members.map((member) => member.displayName)).toEqual([
      'Lead',
      'Alpha',
      'Zulu',
    ])
    expect(stored.map((member) => member.id)).toEqual(['m-zulu', 'm-alpha', 'm-lead'])
  })

  test('NULL agent fallback remains accepted by repository and rejected by the original Intent schema', () => {
    const stored = members()
    stored[0]!.agentId = null
    const group = workgroupFromRows(row(), stored)
    const snapshot = persistence.workgroupDraftSnapshotOf(group)
    expect(JSON.stringify(snapshot)).toBe(JSON.stringify(originalSnapshot(group)))
    expect(snapshot.members[2]!.agentId).toBe(QUARANTINED_SNAPSHOT_AGENT_ID)
    const actual = issueResult(() => intentSnapshot(row(), stored))
    expect(actual).toEqual(issueResult(() => originalIntentSnapshot(row(), stored)))
    expect(actual.issues.map((issue) => issue.path)).toEqual([
      ['members', 2, 'agentId'],
      ['members', 2],
    ])
  })

  for (const memberIndex of [0, 1]) {
    test(`empty identity ${memberIndex}: both original error messages and issue order remain unchanged`, () => {
      const stored = members()
      if (memberIndex === 0) stored[0]!.agentId = ''
      else stored[1]!.userId = null
      const group = workgroupFromRows(row(), stored)
      expect(issueResult(() => persistence.workgroupDraftSnapshotOf(group))).toEqual(
        issueResult(() => originalSnapshot(group)),
      )
      expect(issueResult(() => intentSnapshot(row(), stored))).toEqual(
        issueResult(() => originalIntentSnapshot(row(), stored)),
      )
    })
  }
})

describeEachProvider('RFC359 Workgroup member projection on stored rows', (harness) => {
  test('real repository and both codecs retain full row projections and rollback snapshots', async () => {
    await harness.db.insert(workgroups).values(row()).run()
    await harness.db.insert(workgroupMembers).values(members()).run()
    const { repository, projection } = createWorkgroupRepository(
      harness.db,
      workgroupRepositoryDependencies({ db: harness.db, now: () => T0 + 50 }),
    )
    const before = await repository.get('w24-group')
    if (before === null) throw new Error('missing actual repository document')
    const stored = await harness.db
      .select()
      .from(workgroups)
      .where(eq(workgroups.id, 'w24-group'))
      .get()
    const storedMembers = await harness.db.select().from(workgroupMembers).all()
    if (stored === undefined) throw new Error('missing actual workgroup row')
    expect(stored).toEqual(row())
    expect(
      storedMembers
        .map((member) => ({ ...member }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual(members().sort((left, right) => left.id.localeCompare(right.id)))
    const group = rowToWorkgroup(stored, storedMembers)
    expect(JSON.stringify(projection.snapshotOf(group))).toBe(
      JSON.stringify(originalSnapshot(group)),
    )
    expect(JSON.stringify(intentSnapshot(stored, storedMembers))).toBe(
      JSON.stringify(originalIntentSnapshot(stored, storedMembers)),
    )
    expect(serializeWorkgroupEditableSnapshotV1(projection.snapshotOf(group))).toBe(
      serializeWorkgroupEditableSnapshotV1(originalSnapshot(group)),
    )
    expect(await repository.list()).toEqual([workgroupFromRows(stored, storedMembers)])
    const rollback = new Error('rollback original member projection')
    await expect(
      harness.session.transaction(async (tx) => {
        await tx
          .update(workgroupMembers)
          .set({ roleDesc: 'changed role' })
          .where(eq(workgroupMembers.id, 'm-zulu'))
          .run()
        await tx
          .update(workgroups)
          .set({ version: 8, updatedAt: T0 + 60 })
          .where(eq(workgroups.id, 'w24-group'))
          .run()
        const nextRow = await tx
          .select()
          .from(workgroups)
          .where(eq(workgroups.id, 'w24-group'))
          .get()
        const nextMembers = await tx.select().from(workgroupMembers).all()
        if (nextRow === undefined) throw new Error('missing transaction row')
        const next = workgroupFromRows(nextRow, nextMembers)
        expect(next.version).toBe(8)
        expect(next.members[2]!.roleDesc).toBe('changed role')
        expect(JSON.stringify(projection.snapshotOf(next))).toBe(
          JSON.stringify(originalSnapshot(next)),
        )
        expect(JSON.stringify(intentSnapshot(nextRow, nextMembers))).toBe(
          JSON.stringify(originalIntentSnapshot(nextRow, nextMembers)),
        )
        expect(projection.snapshotOf(next)).not.toEqual(projection.snapshotOf(group))
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect(await repository.get('w24-group')).toEqual(before)
    expect(
      await harness.db.select().from(workgroups).where(eq(workgroups.id, 'w24-group')).get(),
    ).toEqual(stored)
    expect(await harness.db.select().from(workgroupMembers).all()).toEqual(storedMembers)
  })
})
