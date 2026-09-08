// The private Intent exposure below executes only its actual row-construction
// expression. The DB group separately drives complete selected Intent apply
// compositions; the exposure alone is not an owner or PostgreSQL execution.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  canonicalIntentJson,
  CreateAgentSchema,
  parseIntentChangeset,
  type IntentOp,
  type WorkgroupDraftMember,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  agents,
  intentApplyJournal,
  intentDrafts,
  intentProvenance,
  intentSessions,
  users,
  workgroupMembers,
  workgroups,
} from '@/db/schema'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import type { IntentApplyInput } from '@/modules/intent/application/ports/intentApplyOperations'
import type { IntentManifestEntry } from '@/modules/intent/application/manifest'
import {
  applyIntentChangeset,
  composeSqliteIntentApplyArtifactLifecycle,
  composeSqliteIntentApplyOperations,
  type ApplyIntentFaults,
} from '@/modules/intent/composition/apply'
import { createPostgresqlIntentApplyArtifactLifecycle } from '@/modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle'
import { createPostgresqlIntentApplyOperations } from '@/modules/intent/infrastructure/postgresqlIntentApplyOperations'
import {
  composePostgresqlIntentApplyResourceBinding,
  composePostgresqlSkillArtifactCompensation,
  createPostgresqlIntentPluginArtifactLifecycle,
  createPostgresqlIntentSkillArtifactLifecycle,
} from '@/modules/resource-catalog/composition/intentApply'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { createAgentPersistenceValues } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/infrastructure/mcpTransactionLifecycle'
import { workgroupMemberPersistenceValues } from '@/modules/resource-catalog/infrastructure/workgroupPersistence'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { intentApplyResourceBinding } from './helpers/intentApplyResourceBinding'

type MemberRow = typeof workgroupMembers.$inferInsert
type MemberValues = (
  workgroupId: string,
  members: readonly WorkgroupDraftMember[],
  now: number,
  names: ReadonlyMap<string, string>,
  nextId: () => string,
) => readonly MemberRow[]

// Exact two pre-unification constructors at 26b43805b. The only mapped-value
// difference is the agentName presence condition; property order also stays exact.
const originalShared: MemberValues = (workgroupId, members, now, names, nextId) =>
  members.map((member, index) => ({
    id: nextId(),
    workgroupId,
    memberType: member.memberType,
    agentName:
      member.memberType === 'agent' && member.agentId ? (names.get(member.agentId) ?? null) : null,
    agentId: member.memberType === 'agent' ? (member.agentId ?? null) : null,
    userId: member.memberType === 'human' ? (member.userId ?? null) : null,
    displayName: member.displayName,
    roleDesc: member.roleDesc,
    sortOrder: index,
    createdAt: now,
  }))
const originalIntent: MemberValues = (workgroupId, members, now, names, nextId) =>
  members.map((member, sortOrder) => ({
    id: nextId(),
    workgroupId,
    memberType: member.memberType,
    agentName:
      member.memberType === 'agent' && member.agentId !== undefined
        ? (names.get(member.agentId) ?? null)
        : null,
    agentId: member.memberType === 'agent' ? (member.agentId ?? null) : null,
    userId: member.memberType === 'human' ? (member.userId ?? null) : null,
    displayName: member.displayName,
    roleDesc: member.roleDesc,
    sortOrder,
    createdAt: now,
  }))

function intentMemberValues(): MemberValues {
  const path = fileURLToPath(
    new URL(
      '../src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourcePorts.ts',
      import.meta.url,
    ),
  )
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const selected = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'workgroupMemberValues',
  )
  if (selected.length !== 1) throw new Error('expected one Intent member constructor')
  const returned = selected[0]!.body?.statements.at(-1)
  if (
    returned === undefined ||
    !ts.isReturnStatement(returned) ||
    returned.expression === undefined
  )
    throw new Error('expected the original terminal member return')
  const code = ts.transpileModule(
    `const selected = (workgroupId, members, now, names, nextId) => ${returned.expression.getText(source)}`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } },
  ).outputText
  const result: unknown = new Function(
    'workgroupMemberPersistenceValues',
    `'use strict';\n${code}\nreturn selected`,
  )(workgroupMemberPersistenceValues)
  if (typeof result !== 'function') throw new Error('expected callable member constructor')
  return result as MemberValues
}

const privateIntentValues = intentMemberValues()
const fields = [
  'id',
  'workgroupId',
  'memberType',
  'agentName',
  'agentId',
  'userId',
  'displayName',
  'roleDesc',
  'sortOrder',
  'createdAt',
]

function observed(
  mapper: MemberValues,
  members: readonly WorkgroupDraftMember[],
  failure?: { field: string; error: Error },
) {
  const trace: string[] = []
  let calls = 0
  class ObservedNames extends Map<string, string> {
    override get(id: string) {
      trace.push(`name:${id}`)
      if (failure?.field === 'name') throw failure.error
      return super.get(id)
    }
  }
  const namesWithReads = new ObservedNames([
    ['a', 'Agent A'],
    ['', 'Empty ID label'],
  ])
  const watched = members.map(
    (member, index) =>
      new Proxy(member, {
        get(target, field, receiver) {
          trace.push(`${index}:${String(field)}`)
          if (field === failure?.field) throw failure.error
          return Reflect.get(target, field, receiver)
        },
      }),
  )
  const nextId = () => {
    trace.push(`id:${calls}`)
    if (failure?.field === 'id' && calls === 1) throw failure.error
    return `member-${calls++}`
  }
  try {
    const rows = mapper('group', watched, 73, namesWithReads, nextId)
    return { rows, trace, calls, error: undefined }
  } catch (error) {
    return { rows: undefined, trace, calls, error }
  }
}

const directMembers: WorkgroupDraftMember[] = [
  { memberType: 'agent', agentId: 'a', displayName: 'A', roleDesc: 'first' },
  { memberType: 'human', userId: 'person', displayName: 'H', roleDesc: 'human' },
  { memberType: 'agent', agentId: '', displayName: 'Empty', roleDesc: '' },
  { memberType: 'agent', displayName: 'Missing', roleDesc: '' },
  { memberType: 'agent', agentId: 'absent', displayName: 'Unmapped', roleDesc: '' },
  { memberType: 'human', displayName: 'No user', roleDesc: '' },
]

for (const [name, actual, original] of [
  ['shared default', workgroupMemberPersistenceValues, originalShared],
  ['private Intent', privateIntentValues, originalIntent],
] as const) {
  describe(`RFC359 original ${name} member values`, () => {
    test('all columns, own keys, JSON, reads and empty/undefined lookups stay exact', () => {
      const before = observed(original, directMembers)
      const after = observed(actual, directMembers)
      expect(after).toEqual(before)
      expect(after.rows?.map((row) => Object.keys(row))).toEqual(directMembers.map(() => fields))
      expect(JSON.stringify(after.rows)).toBe(JSON.stringify(before.rows))
      expect(after.rows?.[2]?.agentName).toBe(name === 'private Intent' ? 'Empty ID label' : null)
      expect(after.rows?.[3]?.agentName).toBeNull()
      expect(after.rows?.[3]?.agentId).toBeNull()
      expect(after.rows?.[5]?.userId).toBeNull()
      expect(after.calls).toBe(6)
    })

    test('sparse input and empty control retain map indices and ID consumption', () => {
      const sparse = [...directMembers]
      delete sparse[1]
      const before = observed(original, sparse)
      const after = observed(actual, sparse)
      expect(after).toEqual(before)
      expect(Object.keys(after.rows ?? {})).toEqual(['0', '2', '3', '4', '5'])
      expect(after.rows?.[2]?.sortOrder).toBe(2)
      expect(after.calls).toBe(5)
      expect(observed(actual, [])).toEqual({ rows: [], trace: [], calls: 0, error: undefined })
    })

    test('a raw NULL identity retains the original nullish result and lookup trace', () => {
      const member: WorkgroupDraftMember = {
        memberType: 'agent',
        displayName: 'Null identity',
        roleDesc: '',
      }
      // This is the direct mapper's input boundary, not a valid apply payload.
      Object.defineProperty(member, 'agentId', { value: null, enumerable: true })
      const before = observed(original, [member])
      const after = observed(actual, [member])
      expect(after).toEqual(before)
      expect(after.rows?.[0]?.agentId).toBeNull()
      expect(after.rows?.[0]?.agentName).toBeNull()
      expect(after.trace.includes('name:null')).toBe(name === 'private Intent')
    })

    for (const field of ['displayName', 'name', 'id']) {
      test(`${field} failure preserves original error identity and consumed prefix`, () => {
        const error = new Error(`original-${field}-failure`)
        const before = observed(original, directMembers, { field, error })
        const after = observed(actual, directMembers, { field, error })
        expect(after).toEqual(before)
        expect(after.error).toBe(error)
      })
    }
  })
}

const OWNER = 'w26-member-owner'
const A = 'w26-agent-a'
const B = 'w26-agent-b'
const T0 = 1_700_000_000_000
const actor = buildActor({
  user: { id: OWNER, username: OWNER, displayName: OWNER, role: 'admin', status: 'active' },
  source: 'session',
})

function composeFor(harness: ProviderHarness, appHome: string) {
  const pluginsDir = join(appHome, 'plugins')
  if (harness.capabilities.isolation === 'exclusive') {
    const db = harness.db as DbClient
    const binding = intentApplyResourceBinding(db, actor)
    const operations = composeSqliteIntentApplyOperations({
      db,
      appHome,
      resources: binding.resourceApply,
      artifacts: composeSqliteIntentApplyArtifactLifecycle({ db, appHome }),
    })
    return {
      apply(command: IntentApplyInput, faults?: ApplyIntentFaults) {
        if (faults === undefined)
          return operations.apply({ actor, authority: binding.authority, command })
        return applyIntentChangeset(
          {
            db,
            appHome,
            actor,
            authority: binding.authority,
            resourceApply: binding.resourceApply,
            faults,
          },
          command,
        )
      },
    }
  }
  const db = harness.db as PostgresqlDatabaseClient
  const identity = composeIdentityAccess(db)
  const { authority } = identity.contexts.fromAuthenticatedPrincipal(
    { userId: OWNER, source: 'session' },
    'http',
  )
  const resources = composePostgresqlIntentApplyResourceBinding({
    db,
    mcpLifecycle: createMcpTransactionLifecycle(),
    pluginArtifacts: createPostgresqlIntentPluginArtifactLifecycle({ pluginsDir }),
    skillArtifacts: createPostgresqlIntentSkillArtifactLifecycle({ appHome }),
    aclIdentities: composeResourceCatalogFor({ db }).persistence.identities,
  })
  const operations = createPostgresqlIntentApplyOperations({
    db,
    resources,
    artifacts: createPostgresqlIntentApplyArtifactLifecycle({
      db,
      appHome,
      pluginsDir,
      skillArtifacts: composePostgresqlSkillArtifactCompensation(),
    }),
  })
  return {
    apply(command: IntentApplyInput, faults?: ApplyIntentFaults) {
      return operations.apply({
        actor,
        authority,
        command,
        ...(faults === undefined ? {} : { faults }),
      })
    },
  }
}

function payload(replacement = false) {
  return {
    name: 'Intent member group',
    description: replacement ? 'replacement' : 'created',
    instructions: 'Keep submitted member order.',
    mode: 'leader_worker' as const,
    outputContract: 'discussion' as const,
    leaderDisplayName: 'Lead',
    switches: { shareOutputs: false, directMessages: true, blackboard: false },
    maxRounds: 12,
    completionGate: true,
    clarifyBudget: 0,
    fanOut: false,
    members: [
      {
        memberType: 'agent' as const,
        agentRef: replacement ? 'res#agent#1' : 'res#agent#2',
        displayName: 'Peer',
        roleDesc: 'peer role',
      },
      {
        memberType: 'agent' as const,
        agentRef: replacement ? 'res#agent#2' : 'res#agent#1',
        displayName: 'Lead',
        roleDesc: 'lead role',
      },
    ],
  }
}

async function draft(harness: ProviderHarness, op: IntentOp, extra: IntentManifestEntry[] = []) {
  const sessionId = ulid()
  const id = ulid()
  const parsed = parseIntentChangeset(JSON.stringify({ $schema_version: 1, ops: [op] }))
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  const canonical = canonicalIntentJson(parsed.changeset)
  const draftHash = `sha256:${createHash('sha256').update(canonical).digest('hex')}`
  const manifest: IntentManifestEntry[] = [
    { handle: 'res#agent#1', resourceType: 'agent', resourceId: A, root: false, detail: false },
    { handle: 'res#agent#2', resourceType: 'agent', resourceId: B, root: false, detail: false },
    ...extra,
  ]
  await harness.db.insert(intentSessions).values({
    id: sessionId,
    ownerUserId: OWNER,
    title: 'Member rows',
    contextManifestJson: JSON.stringify(manifest),
    createdAt: T0,
    updatedAt: T0,
  })
  await harness.db.insert(intentDrafts).values({
    id,
    sessionId,
    revision: 1,
    changesetJson: canonical,
    validationJson: '{"errors":[],"credentialFindings":[]}',
    draftHash,
    contextRevision: 0,
    createdAt: T0,
  })
  await harness.db
    .update(intentSessions)
    .set({ currentDraftId: id })
    .where(eq(intentSessions.id, sessionId))
  return {
    sessionId,
    clientMutationId: ulid(),
    draftRevision: 1,
    draftHash,
    decisions: op.action === 'update' ? [{ opId: op.opId, applyMode: 'modify' as const }] : [],
  }
}

async function physical(harness: ProviderHarness, id: string) {
  return {
    row: await harness.db.select().from(workgroups).where(eq(workgroups.id, id)).get(),
    members: await harness.db
      .select()
      .from(workgroupMembers)
      .where(eq(workgroupMembers.workgroupId, id))
      .orderBy(workgroupMembers.sortOrder)
      .all(),
  }
}

function groupManifest(id: string, version: number): IntentManifestEntry[] {
  return [
    {
      handle: 'res#workgroup#1',
      resourceType: 'workgroup',
      resourceId: id,
      root: true,
      detail: true,
      fence: { kind: 'workgroup', version },
    },
  ]
}

function expectRows(saved: Awaited<ReturnType<typeof physical>>, replacement: boolean) {
  if (saved.row === undefined) throw new Error('actual Intent group missing')
  const p = payload(replacement)
  expect(saved.row).toEqual({
    id: saved.row.id,
    name: p.name,
    description: p.description,
    instructions: p.instructions,
    mode: p.mode,
    outputContract: p.outputContract,
    leaderMemberId: saved.members[1]!.id,
    ...p.switches,
    maxRounds: p.maxRounds,
    completionGate: p.completionGate,
    clarifyBudget: p.clarifyBudget,
    fanOut: p.fanOut,
    version: replacement ? 2 : 1,
    ownerUserId: OWNER,
    visibility: 'private',
    aclRevision: 0,
    schemaVersion: 1,
    createdAt: saved.row.createdAt,
    updatedAt: saved.row.updatedAt,
  })
  expect(saved.members).toHaveLength(2)
  expect(saved.members).toEqual(
    p.members.map((member, index): typeof workgroupMembers.$inferSelect => ({
      id: saved.members[index]!.id,
      workgroupId: saved.row!.id,
      memberType: 'agent',
      agentName: member.agentRef === 'res#agent#1' ? 'current-agent-a' : 'current-agent-b',
      agentId: member.agentRef === 'res#agent#1' ? A : B,
      userId: null,
      displayName: member.displayName,
      roleDesc: member.roleDesc,
      sortOrder: index,
      createdAt: saved.row!.updatedAt,
    })),
  )
  expect(new Set(saved.members.map((row) => row.id)).size).toBe(2)
}

describeEachProvider('RFC359 real Intent Workgroup member writes', (harness) => {
  let appHome: string
  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-w26-member-values-'))
    await harness.db.insert(users).values({ ...actor.user, createdAt: T0, updatedAt: T0 })
    await harness.db.insert(agents).values([
      createAgentPersistenceValues({
        id: A,
        agent: CreateAgentSchema.parse({ name: 'current-agent-a' }),
        ownerUserId: OWNER,
        now: T0,
      }),
      createAgentPersistenceValues({
        id: B,
        agent: CreateAgentSchema.parse({ name: 'current-agent-b' }),
        ownerUserId: OWNER,
        now: T0,
      }),
    ])
  })
  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
  })

  test('full apply create, update and replay preserve complete member rows and receipts', async () => {
    const composition = composeFor(harness, appHome)
    const create = await draft(harness, {
      opId: 'op-1',
      action: 'create',
      resourceType: 'workgroup',
      tempRef: '$new:team',
      payload: payload(),
    })
    const created = await composition.apply(create)
    expect(created.applied).toHaveLength(1)
    const id = created.applied[0]!.resourceId
    expect(created.applied).toEqual([
      {
        opId: 'op-1',
        resourceType: 'workgroup',
        resourceId: id,
        action: 'create',
        fromCopy: false,
        name: payload().name,
      },
    ])
    const before = await physical(harness, id)
    expectRows(before, false)
    expect(await composition.apply(create)).toEqual(created)
    expect(await physical(harness, id)).toEqual(before)
    const update = await draft(
      harness,
      {
        opId: 'op-1',
        action: 'update',
        resourceType: 'workgroup',
        target: 'res#workgroup#1',
        payload: payload(true),
      },
      groupManifest(id, 1),
    )
    const updated = await composition.apply(update)
    expect(updated.applied).toEqual([{ ...created.applied[0]!, action: 'update' }])
    const after = await physical(harness, id)
    expectRows(after, true)
    expect(after.row!.createdAt).toBe(before.row!.createdAt)
    expect(new Set([...before.members, ...after.members].map((row) => row.id)).size).toBe(4)
    expect(await composition.apply(update)).toEqual(updated)
    expect(await physical(harness, id)).toEqual(after)
    for (const receipt of [created, updated]) {
      const journal = await harness.db
        .select()
        .from(intentApplyJournal)
        .where(eq(intentApplyJournal.id, receipt.journalId))
        .get()
      expect(journal).toMatchObject({
        state: 'committed',
        error: null,
        receiptJson: JSON.stringify(receipt),
      })
      expect(
        await harness.db
          .select()
          .from(intentProvenance)
          .where(eq(intentProvenance.commitId, receipt.journalId)),
      ).toMatchObject([{ resourceType: 'workgroup', resourceId: id }])
    }
  })

  test('failure after real create and replacement writes rolls back all group and member rows', async () => {
    const composition = composeFor(harness, appHome)
    let reached = 0
    const failure = new Error('after actual Workgroup rows')
    const faults = {
      inTxAfterOps() {
        reached++
        throw failure
      },
    }
    const failedCreate = await draft(harness, {
      opId: 'op-1',
      action: 'create',
      resourceType: 'workgroup',
      tempRef: '$new:team',
      payload: payload(),
    })
    await expect(composition.apply(failedCreate, faults)).rejects.toBe(failure)
    expect(reached).toBe(1)
    expect(await harness.db.select().from(workgroups)).toEqual([])
    expect(await harness.db.select().from(workgroupMembers)).toEqual([])
    const create = await draft(harness, {
      opId: 'op-1',
      action: 'create',
      resourceType: 'workgroup',
      tempRef: '$new:team',
      payload: payload(),
    })
    const receipt = await composition.apply(create)
    const id = receipt.applied[0]!.resourceId
    const before = await physical(harness, id)
    const update = await draft(
      harness,
      {
        opId: 'op-1',
        action: 'update',
        resourceType: 'workgroup',
        target: 'res#workgroup#1',
        payload: payload(true),
      },
      groupManifest(id, 1),
    )
    await expect(composition.apply(update, faults)).rejects.toBe(failure)
    expect(reached).toBe(2)
    expect(await physical(harness, id)).toEqual(before)
    for (const command of [failedCreate, update]) {
      const journal = await harness.db
        .select()
        .from(intentApplyJournal)
        .where(eq(intentApplyJournal.sessionId, command.sessionId))
        .get()
      expect(journal).toMatchObject({ state: 'failed', receiptJson: null })
      expect(journal?.error).toContain(failure.message)
      expect(
        await harness.db
          .select()
          .from(intentProvenance)
          .where(eq(intentProvenance.sessionId, command.sessionId)),
      ).toEqual([])
    }
  })
})
