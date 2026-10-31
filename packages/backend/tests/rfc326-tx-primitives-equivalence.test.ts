import { taskAggregateWrite } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { withTargetMintIdentity } from './helpers/rfc395Mint'
// RFC-326 T7 — the synchronous transaction companions are EQUIVALENT to the
// async originals (proposal AC-19; design §6.2).
//
// WHY THIS FILE EXISTS: the review decision now commits in ONE dbTxSync, so the
// row moves it used to make through `transitionNodeRunStatus` / `mintNodeRun` /
// `hasActingMembership` (each its own autocommit or transaction) go through
// `…Tx` twins that take the caller's handle. The async originals became pure
// wrappers around the twins. This file pins:
//   - same input → byte-identical resulting rows (ALL node_runs rows, including
//     the prior generations — RFC-369: the mint no longer writes them; their
//     supersession is derived on read) and the same return value;
//   - same refusal → same DomainError subclass + code (not found / illegal
//     transition / RFC-303 source-termination fence);
//   - the originals really are wrappers (no second direct write in the async
//     bodies — the lifecycle-grep-guard count `KERNEL_DIRECT_WRITES = 3` and the
//     s10 `RAW_TRANSACTION_SITES` ledger stay untouched by construction).

import {
  nodeRunFixture,
  taskFixture,
  workflowFixture,
  readNodeRunFixtures,
  type NodeRunFixtureRow,
} from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  allowedFromForMergeEvent,
  MERGE_STATES,
  type MergeState,
  type NodeRunTransitionEvent,
} from '@agent-workflow/shared'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { transitionNodeRunStatus, transitionNodeRunStatusTx } from '../src/services/lifecycle'
import { mintNodeRun, type MintNodeRunArgs } from '../src/services/nodeRunMint'
import { createNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunMintParticipant'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { hasActingMembership } from '@/modules/collaboration/infrastructure/taskCollab'
import { derivedSupersededIds } from './helpers/nodeRunSupersession'
import { DomainError } from '../src/util/errors'

const TASK = 'task-rfc326-eq'
// Fixed ids sort BELOW every freshly generated ULID ('01…'), so a minted row is
// the newest generation in both databases alike.
const REVIEW = '00000000000000000000000001'
const DOC_PRIOR = '00000000000000000000000002'
const DOC_PRIOR_KEPT = '00000000000000000000000003'
const OTHER_NODE = '00000000000000000000000004'
const DOC_ITER1 = '00000000000000000000000005'
const NOW = 1_700_000_000_000

const ABANDONABLE = allowedFromForMergeEvent({ kind: 'abandon', reason: 'derive-from-set' }).filter(
  (s): s is MergeState => s !== null,
)
const NOT_ABANDONABLE = MERGE_STATES.filter((s) => !ABANDONABLE.includes(s))

async function seed(db: DbClient, fence: 'closed' | 'merged' | null = null): Promise<void> {
  const { users, taskCollaborators } = tablesOf(db)
  await workflowFixture(db, { id: 'wf', name: 'wf', description: '', definition: '{}' })
  await taskFixture(db, {
    id: TASK,
    name: 't',
    workflowId: 'wf',
    workflowSnapshot: '{}',
    repoPath: '/tmp/rfc326-eq',
    worktreePath: '/tmp/rfc326-eq',
    baseBranch: 'main',
    branch: `agent-workflow/${TASK}`,
    status: 'running',
    inputs: '{}',
    startedAt: NOW,
    sourceTerminationFence: fence,
  })
  const base = { taskId: TASK, retryIndex: 0, startedAt: NOW, finishedAt: NOW }
  await nodeRunFixture(db, [
    {
      ...base,
      id: REVIEW,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      iteration: 0,
      finishedAt: null,
    },
    {
      ...base,
      id: DOC_PRIOR,
      nodeId: 'doc',
      status: 'done',
      iteration: 0,
      mergeState: ABANDONABLE[0]!,
    },
    {
      ...base,
      id: DOC_PRIOR_KEPT,
      nodeId: 'doc',
      status: 'done',
      iteration: 0,
      mergeState: NOT_ABANDONABLE[0]!,
    },
    {
      ...base,
      id: OTHER_NODE,
      nodeId: 'other',
      status: 'done',
      iteration: 0,
      mergeState: ABANDONABLE[0]!,
    },
    {
      ...base,
      id: DOC_ITER1,
      nodeId: 'doc',
      status: 'done',
      iteration: 1,
      mergeState: ABANDONABLE[0]!,
    },
  ])
  await db.insert(users).values(
    ['u-owner', 'u-collab', 'u-observer', 'u-stranger'].map((id) => ({
      id,
      username: id,
      displayName: id,
      role: 'user' as const,
      status: 'active' as const,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  )
  await db.insert(taskCollaborators).values([
    { taskId: TASK, userId: 'u-owner', role: 'owner', addedBy: 'u-owner', addedAt: NOW },
    { taskId: TASK, userId: 'u-collab', role: 'collaborator', addedBy: 'u-owner', addedAt: NOW },
    { taskId: TASK, userId: 'u-observer', role: 'observer', addedBy: 'u-owner', addedAt: NOW },
  ])
}

async function pair(fence: 'closed' | 'merged' | null = null): Promise<[DbClient, DbClient]> {
  const a = createInMemoryDb()
  const b = createInMemoryDb()
  await seed(a, fence)
  await seed(b, fence)
  return [a, b]
}

async function dump(db: DbClient): Promise<NodeRunFixtureRow[]> {
  return await readNodeRunFixtures(db, undefined, { orderBy: [{ field: 'id', direction: 'asc' }] })
}

interface Refusal {
  name: string
  code: string
  status: number
}

/**
 * Every refusal the kernel raises carries a `code` — DomainError subclasses
 * (404 / 409) and the shared `IllegalNodeRunTransition` alike; the twins must
 * raise the same class with the same code.
 */
async function refusalOf(fn: () => unknown): Promise<Refusal> {
  try {
    await fn()
  } catch (err) {
    if (!(err instanceof Error)) throw err
    const e = err as Error & { code?: string; status?: number }
    if (typeof e.code !== 'string') throw err
    return {
      name: e.constructor.name,
      code: e.code,
      status: err instanceof DomainError ? err.status : -1,
    }
  }
  throw new Error('expected a coded refusal')
}

describe('RFC-326 AC-19 — transitionNodeRunStatus ≡ transitionNodeRunStatusTx', () => {
  test.each<
    [NodeRunTransitionEvent, NonNullable<Parameters<typeof transitionNodeRunStatus>[0]['extra']>]
  >([
    [{ kind: 'approve-review' }, { identity: { finishedAt: NOW + 5 } }],
    [{ kind: 'iterate-review' }, { identity: { reviewIteration: 1 } }],
    [{ kind: 'reject-review' }, { identity: { reviewIteration: 1 } }],
  ])('%p — same return value, same rows', async (event, extra) => {
    const [a, b] = await pair()
    const before = await dump(a)
    expect(await dump(b)).toEqual(before)

    const viaAsync = await transitionNodeRunStatus({ db: a, nodeRunId: REVIEW, event, extra })
    const viaTx = await databaseSessionFor(b).transaction((tx) =>
      transitionNodeRunStatusTx({ tx, nodeRunId: REVIEW, event, extra }),
    )

    expect(viaTx).toEqual(viaAsync)
    expect(viaAsync.from).toBe('awaiting_review')
    const afterA = await dump(a)
    expect(await dump(b)).toEqual(afterA)
    expect(afterA).not.toEqual(before) // the fixture really moved a row
    expect(afterA.find((r) => r.id === REVIEW)!.status).toBe(viaAsync.to)
  })

  test('same refusals: unknown row / illegal transition / RFC-303 fence', async () => {
    // unknown row
    {
      const [a, b] = await pair()
      const event: NodeRunTransitionEvent = { kind: 'approve-review' }
      const ra = await refusalOf(() => transitionNodeRunStatus({ db: a, nodeRunId: 'nope', event }))
      const rb = await refusalOf(() =>
        databaseSessionFor(b).transaction((tx) =>
          transitionNodeRunStatusTx({ tx, nodeRunId: 'nope', event }),
        ),
      )
      expect(rb).toEqual(ra)
      expect(ra.code).toBe('node-run-not-found')
    }
    // illegal transition: approve-review from a `done` row
    {
      const [a, b] = await pair()
      const event: NodeRunTransitionEvent = { kind: 'approve-review' }
      const ra = await refusalOf(() =>
        transitionNodeRunStatus({ db: a, nodeRunId: DOC_PRIOR, event }),
      )
      const rb = await refusalOf(() =>
        databaseSessionFor(b).transaction((tx) =>
          transitionNodeRunStatusTx({ tx, nodeRunId: DOC_PRIOR, event }),
        ),
      )
      expect(rb).toEqual(ra)
      expect(ra.code).toBe('illegal-node-run-transition')
      expect(await dump(b)).toEqual(await dump(a))
    }
    // fence: a closed MR/PR refuses re-opening the review row (→ pending)
    {
      const [a, b] = await pair('closed')
      const event: NodeRunTransitionEvent = { kind: 'iterate-review' }
      const before = await dump(a)
      const ra = await refusalOf(() => transitionNodeRunStatus({ db: a, nodeRunId: REVIEW, event }))
      const rb = await refusalOf(() =>
        databaseSessionFor(b).transaction((tx) =>
          transitionNodeRunStatusTx({ tx, nodeRunId: REVIEW, event }),
        ),
      )
      expect(rb).toEqual(ra)
      expect(ra.code).toBe('task-source-terminal-closed')
      expect(await dump(a)).toEqual(before)
      expect(await dump(b)).toEqual(before)
    }
  })
})

// RFC-359：原判据比的是 `mintNodeRun`（异步入口）≡ `mintNodeRunTx`（`dbTxSync` 体内的同步孪生）。
// 同步那一面随本波退役，但**「独立入口铸行」与「在调用方事务里铸行」结果必须一致**这条产品行为
// 依然承重——只是后者现在由中立的 `createNodeRunMintParticipantInTx(tx)` 承担（同一个
// `nodeRunMintProgram`，异步解释）。判据一条没少：新行、被退役的同代旧行、以及同样的拒绝。
describe('RFC-326 AC-19 — mintNodeRun ≡ in-transaction mint (including retired merge states)', () => {
  const args: MintNodeRunArgs = withTargetMintIdentity({
    role: 'node-attempt',
    syntheticKind: null,
    taskId: TASK,
    nodeId: 'doc',
    status: 'pending',
    cause: 'review-iterate',
    retryIndex: 1,
    iteration: 0,
    overrides: {
      identity: {
        parentNodeRunId: null,
        startedAt: null,
        envelopeNonce: '0123456789abcdef',
      },
      checkpoint: {
        checkpoints: [{ mountPath: '', preSnapshot: 'deadbeef' }],
      },
    },
  })

  async function normalised(db: DbClient, mintedId: string): Promise<NodeRunFixtureRow[]> {
    return (await dump(db)).map((r) => ({ ...r, id: r.id === mintedId ? '<minted>' : r.id }))
  }

  test('same rows after the mint — the new row AND every prior generation (untouched, derived superseded)', async () => {
    expect(ABANDONABLE.length).toBeGreaterThan(0)
    expect(NOT_ABANDONABLE.length).toBeGreaterThan(0)
    const [a, b] = await pair()

    const idA = await mintNodeRun(a, withTargetMintIdentity(args))
    const idB = await databaseSessionFor(b).transaction(async (tx) => {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, TASK)
      return await createNodeRunMintParticipantInTx(tx).mint(withTargetMintIdentity(args))
    })
    expect(idA).not.toBe(idB) // fresh ULIDs — everything else must match

    const rowsA = await normalised(a, idA)
    expect(await normalised(b, idB)).toEqual(rowsA)

    // RFC-369: the mint writes no prior generation; the abandonable prior generation of
    // the SAME (task, node, iteration) is derived superseded — in both databases alike —
    // and everything else is not.
    const byId = new Map(rowsA.map((r) => [r.id, r]))
    expect(byId.get(DOC_PRIOR)!.mergeState).toBe(ABANDONABLE[0]!)
    expect(await derivedSupersededIds(a, TASK)).toEqual([DOC_PRIOR])
    expect(await derivedSupersededIds(b, TASK)).toEqual([DOC_PRIOR])
    expect(byId.get(DOC_PRIOR_KEPT)!.mergeState).toBe(NOT_ABANDONABLE[0]!)
    expect(byId.get(OTHER_NODE)!.mergeState).toBe(ABANDONABLE[0]!)
    expect(byId.get(DOC_ITER1)!.mergeState).toBe(ABANDONABLE[0]!)
    const minted = byId.get('<minted>')!
    expect(minted.status).toBe('pending')
    expect(minted.retryIndex).toBe(1)
    expect(minted.checkpoints.find((checkpoint) => checkpoint.mountPath === '')?.preSnapshot).toBe(
      'deadbeef',
    )
    expect(minted.envelopeNonce).toBe('0123456789abcdef')
    expect(minted.startedAt).toBeNull()
  })

  test('same refusal: a top-level born-running mint is rejected by both before any write', async () => {
    const [a, b] = await pair()
    const bad: MintNodeRunArgs = { ...args, status: 'running' }
    let ea: unknown
    let eb: unknown
    try {
      await mintNodeRun(a, withTargetMintIdentity(bad))
    } catch (err) {
      ea = err
    }
    try {
      await databaseSessionFor(b).transaction(async (tx) => {
        await taskAggregateWrite.lockTaskAggregateRoot(tx, TASK)
        return await createNodeRunMintParticipantInTx(tx).mint(withTargetMintIdentity(bad))
      })
    } catch (err) {
      eb = err
    }
    expect((ea as Error).message).toBe((eb as Error).message)
    expect(await dump(a)).toEqual(await dump(b))
    expect((await dump(a)).find((r) => r.id === DOC_PRIOR)!.mergeState).toBe(ABANDONABLE[0]!)
  })
})

// RFC-359 W9 —— AC-19 的「两个面等价」判据退役成「只剩一个面」。
//
// 原判据是 `hasActingMembership`（异步）≡ `hasActingMembershipTx`（`dbTxSync` 内的同步孪生）。
// 同步孪生存在的理由是评审决定在 `dbTxSync` 的提交点上复核成员身份，而那条链路 RFC-359 W1-T2c
// 已迁到 `databaseSessionFor`；从那天起同步孪生在 `src` 里零调用方，只有本用例按名字钉着它。
// W9 把它连同 `updateTaskMembersLocked` 的 `dbTxSync` 一起删掉了——两个引擎现在共用同一个
// 异步谓词。保留的断言是这条谓词**本身**的行为（AC-19 真正要锁的东西）：owner / collaborator
// 有行动权，observer / 陌生人没有。行为跨引擎的对拍在
// `tests/rfc359-w9-task-members-conformance.test.ts`。
describe('RFC-326 AC-19 — 行动权谓词（合一后只剩异步一个面）', () => {
  test('owner / collaborator act; observer / stranger do not', async () => {
    const [a] = await pair()
    const users = ['u-owner', 'u-collab', 'u-observer', 'u-stranger']
    const viaAsync = await Promise.all(users.map((u) => hasActingMembership(a, TASK, u)))
    expect(viaAsync).toEqual([true, true, false, false])
    const { taskCollaborators } = tablesOf(a)
    // Sanity: the observer row is really there (otherwise the false is vacuous).
    const observer = queryRows(
      a.select().from(taskCollaborators).where(eq(taskCollaborators.userId, 'u-observer')),
    )
    expect(observer.map((r) => r.role)).toEqual(['observer'])
  })
})

describe('RFC-326 T7 — the async originals are pure wrappers (guard ledgers untouched)', () => {
  const SRC = resolve(import.meta.dir, '..', 'src', 'services')
  const SQLITE_TASK_LIFECYCLE = resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'infrastructure',
    'taskLifecycle.ts',
  )

  function bodyOf(source: string, signature: string): string {
    const start = source.indexOf(signature)
    if (start < 0) throw new Error(`signature not found: ${signature}`)
    const next = source.indexOf('\nexport ', start + signature.length)
    return source.slice(start, next < 0 ? source.length : next)
  }

  test('transitionNodeRunStatus delegates to transitionNodeRunStatusTx and writes nothing itself', () => {
    const src = readFileSync(SQLITE_TASK_LIFECYCLE, 'utf8')
    const body = bodyOf(src, 'export async function transitionNodeRunStatus(')
    // Epoch 2 funnels both context forms through the same task-root transaction.
    expect(body.match(/transitionNodeRunStatusInTransaction\(\{/g)?.length ?? 0).toBe(1)
    expect(body).toContain('return withTaskExecutionWrite(args.db, async (tx) => {')
    expect(body).toContain('await fenceTaskWrite(tx, { taskId: row.taskId, context })')
    expect(body).toContain('await lockNodeRunTaskRootInTx(tx, args.nodeRunId)')
    expect(body).not.toContain('.update(nodeRuns)')
    // A standalone CAS is one statement: the wrapper must NOT open a transaction
    // of its own (an extra BEGIN/COMMIT per transition changed the session-lease
    // retry behaviour — runner.test.ts on CI, 430717cae).
    expect(body).not.toContain('dbTxSync(')
    expect(body).not.toContain('.transaction(')
    // The single allow-listed writer for this event family sits in the Tx twin.
    expect(src).toContain(
      'export const transitionNodeRunStatusTx = transitionNodeRunStatusInTransaction',
    )
    const twin = readFileSync(
      new URL(
        '../src/modules/task-execution/infrastructure/nodeRunLifecycleTransition.ts',
        import.meta.url,
      ),
      'utf8',
    )
    expect(twin.match(/compareAndWriteNodeRunInTx\(/g)?.length ?? 0).toBe(1)
    expect(twin).toContain('eq(nodeRuns.status, from)')
    expect(twin).toContain('{ ...extra?.identity, status: to }')
    expect(twin).not.toContain('.update(nodeRuns)')
    const protocol = readFileSync(
      new URL(
        '../src/modules/task-execution/infrastructure/nodeRunWriteProtocol.ts',
        import.meta.url,
      ),
      'utf8',
    )
    const cas = bodyOf(protocol, 'export async function compareAndWriteNodeRunInTx(')
    expect(cas).toContain('rfc053-allow-direct-status-write')
    expect(cas.match(/\.update\(nodeRuns\)/g)?.length ?? 0).toBe(1)
    expect(cas).toContain('.where(and(eq(nodeRuns.id, nodeRunId), predicate))')
  })

  // RFC-359：同步孪生 `mintNodeRunTx` 已退役（生产零调用方），所以这里只剩「入口本身不写行」
  // 这一半。要在自己的事务里铸行的调用方走中立的 `createNodeRunMintParticipantInTx(tx)`。
  test('mintNodeRun delegates to the lifecycle port and inserts nothing itself', () => {
    const src = readFileSync(resolve(SRC, 'nodeRunMint.ts'), 'utf8')
    const body = bodyOf(src, 'export async function mintNodeRun(')
    expect(body).toContain('createLegacySqliteNodeRunOperations(db).lifecycle.mint(args)')
    expect(body).not.toMatch(/(?:\.insert\(\s*nodeRuns\s*\)|\binsertOne\([^,]+,\s*nodeRuns\s*,)/)
    // No raw `.transaction(` site here (s10 ledger): the write boundary lives in the port.
    expect(body).not.toContain('.transaction(')
    expect(src).not.toContain('export function mintNodeRunTx(')
  })
})
