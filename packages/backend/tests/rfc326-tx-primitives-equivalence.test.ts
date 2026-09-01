// RFC-326 T7 — the synchronous transaction companions are EQUIVALENT to the
// async originals (proposal AC-19; design §6.2).
//
// WHY THIS FILE EXISTS: the review decision now commits in ONE dbTxSync, so the
// row moves it used to make through `transitionNodeRunStatus` / `mintNodeRun` /
// `hasActingMembership` (each its own autocommit or transaction) go through
// `…Tx` twins that take the caller's handle. The async originals became pure
// wrappers around the twins. This file pins:
//   - same input → byte-identical resulting rows (ALL node_runs rows, including
//     the prior generations `abandonSupersededMergeStates` retires on mint) and
//     the same return value;
//   - same refusal → same DomainError subclass + code (not found / illegal
//     transition / RFC-303 source-termination fence);
//   - the originals really are wrappers (no second direct write in the async
//     bodies — the lifecycle-grep-guard count `KERNEL_DIRECT_WRITES = 3` and the
//     s10 `RAW_TRANSACTION_SITES` ledger stay untouched by construction).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { allowedFromForMergeEvent, MERGE_STATES } from '@agent-workflow/shared'
import type { MergeState, NodeRunTransitionEvent } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { dbTxSync } from '../src/db/txSync'
import { nodeRuns, taskCollaborators, tasks, users, workflows } from '../src/db/schema'
import { transitionNodeRunStatus, transitionNodeRunStatusTx } from '../src/services/lifecycle'
import { mintNodeRun, mintNodeRunTx, type MintNodeRunArgs } from '../src/services/nodeRunMint'
import { hasActingMembership, hasActingMembershipTx } from '../src/services/taskCollab'
import { DomainError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
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
  await db.insert(workflows).values({ id: 'wf', name: 'wf', description: '', definition: '{}' })
  await db.insert(tasks).values({
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
  await db.insert(nodeRuns).values([
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
  const a = createInMemoryDb(MIGRATIONS)
  const b = createInMemoryDb(MIGRATIONS)
  await seed(a, fence)
  await seed(b, fence)
  return [a, b]
}

function dump(db: DbClient): (typeof nodeRuns.$inferSelect)[] {
  return db.select().from(nodeRuns).orderBy(asc(nodeRuns.id)).all()
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
  test.each<[NodeRunTransitionEvent, Record<string, unknown>]>([
    [{ kind: 'approve-review' }, { finishedAt: NOW + 5 }],
    [{ kind: 'iterate-review' }, { reviewIteration: 1 }],
    [{ kind: 'reject-review' }, { reviewIteration: 1 }],
  ])('%p — same return value, same rows', async (event, extra) => {
    const [a, b] = await pair()
    const before = dump(a)
    expect(dump(b)).toEqual(before)

    const viaAsync = await transitionNodeRunStatus({ db: a, nodeRunId: REVIEW, event, extra })
    const viaTx = dbTxSync(b, (tx) =>
      transitionNodeRunStatusTx({ tx, nodeRunId: REVIEW, event, extra }),
    )

    expect(viaTx).toEqual(viaAsync)
    expect(viaAsync.from).toBe('awaiting_review')
    const afterA = dump(a)
    expect(dump(b)).toEqual(afterA)
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
        dbTxSync(b, (tx) => transitionNodeRunStatusTx({ tx, nodeRunId: 'nope', event })),
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
        dbTxSync(b, (tx) => transitionNodeRunStatusTx({ tx, nodeRunId: DOC_PRIOR, event })),
      )
      expect(rb).toEqual(ra)
      expect(ra.code).toBe('illegal-node-run-transition')
      expect(dump(b)).toEqual(dump(a))
    }
    // fence: a closed MR/PR refuses re-opening the review row (→ pending)
    {
      const [a, b] = await pair('closed')
      const event: NodeRunTransitionEvent = { kind: 'iterate-review' }
      const before = dump(a)
      const ra = await refusalOf(() => transitionNodeRunStatus({ db: a, nodeRunId: REVIEW, event }))
      const rb = await refusalOf(() =>
        dbTxSync(b, (tx) => transitionNodeRunStatusTx({ tx, nodeRunId: REVIEW, event })),
      )
      expect(rb).toEqual(ra)
      expect(ra.code).toBe('task-source-terminal-closed')
      expect(dump(a)).toEqual(before)
      expect(dump(b)).toEqual(before)
    }
  })
})

describe('RFC-326 AC-19 — mintNodeRun ≡ mintNodeRunTx (including retired merge states)', () => {
  const args: MintNodeRunArgs = {
    taskId: TASK,
    nodeId: 'doc',
    status: 'pending',
    cause: 'review-iterate',
    retryIndex: 1,
    iteration: 0,
    overrides: {
      parentNodeRunId: null,
      preSnapshot: 'deadbeef',
      startedAt: null,
      envelopeNonce: '0123456789abcdef',
    },
  }

  function normalised(db: DbClient, mintedId: string): (typeof nodeRuns.$inferSelect)[] {
    return dump(db).map((r) => ({ ...r, id: r.id === mintedId ? '<minted>' : r.id }))
  }

  test('same rows after the mint — the new row AND every abandoned prior generation', async () => {
    expect(ABANDONABLE.length).toBeGreaterThan(0)
    expect(NOT_ABANDONABLE.length).toBeGreaterThan(0)
    const [a, b] = await pair()

    const idA = await mintNodeRun(a, args)
    const idB = dbTxSync(b, (tx) => mintNodeRunTx(tx, args))
    expect(idA).not.toBe(idB) // fresh ULIDs — everything else must match

    const rowsA = normalised(a, idA)
    expect(normalised(b, idB)).toEqual(rowsA)

    // The fixture exercised the retire path: the abandonable prior generation of
    // the SAME (task, node, iteration) flipped, everything else stayed.
    const byId = new Map(rowsA.map((r) => [r.id, r]))
    expect(byId.get(DOC_PRIOR)!.mergeState).toBe('abandoned')
    expect(byId.get(DOC_PRIOR_KEPT)!.mergeState).toBe(NOT_ABANDONABLE[0]!)
    expect(byId.get(OTHER_NODE)!.mergeState).toBe(ABANDONABLE[0]!)
    expect(byId.get(DOC_ITER1)!.mergeState).toBe(ABANDONABLE[0]!)
    const minted = byId.get('<minted>')!
    expect(minted.status).toBe('pending')
    expect(minted.retryIndex).toBe(1)
    expect(minted.preSnapshot).toBe('deadbeef')
    expect(minted.envelopeNonce).toBe('0123456789abcdef')
    expect(minted.startedAt).toBeNull()
  })

  test('same refusal: a top-level born-running mint is rejected by both before any write', async () => {
    const [a, b] = await pair()
    const bad: MintNodeRunArgs = { ...args, status: 'running' }
    let ea: unknown
    let eb: unknown
    try {
      await mintNodeRun(a, bad)
    } catch (err) {
      ea = err
    }
    try {
      dbTxSync(b, (tx) => mintNodeRunTx(tx, bad))
    } catch (err) {
      eb = err
    }
    expect((ea as Error).message).toBe((eb as Error).message)
    expect(dump(a)).toEqual(dump(b))
    expect(dump(a).find((r) => r.id === DOC_PRIOR)!.mergeState).toBe(ABANDONABLE[0]!)
  })
})

describe('RFC-326 AC-19 — hasActingMembership ≡ hasActingMembershipTx', () => {
  test('owner / collaborator act; observer / stranger do not — identical on both surfaces', async () => {
    const [a] = await pair()
    const users = ['u-owner', 'u-collab', 'u-observer', 'u-stranger']
    const viaAsync = await Promise.all(users.map((u) => hasActingMembership(a, TASK, u)))
    const viaTx = users.map((u) => dbTxSync(a, (tx) => hasActingMembershipTx(tx, TASK, u)))
    expect(viaTx).toEqual(viaAsync)
    expect(viaAsync).toEqual([true, true, false, false])
    // Sanity: the observer row is really there (otherwise the false is vacuous).
    const observer = a
      .select()
      .from(taskCollaborators)
      .where(eq(taskCollaborators.userId, 'u-observer'))
      .all()
    expect(observer.map((r) => r.role)).toEqual(['observer'])
  })
})

describe('RFC-326 T7 — the async originals are pure wrappers (guard ledgers untouched)', () => {
  const SRC = resolve(import.meta.dir, '..', 'src', 'services')
  const SQLITE_TASK_LIFECYCLE = resolve(
    import.meta.dir,
    '..',
    'src',
    'platform',
    'persistence',
    'sqlite',
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
    expect(body).toContain('transitionNodeRunStatusTx({ tx: args.db, ...args })')
    expect(body).not.toContain('.update(nodeRuns)')
    // A standalone CAS is one statement: the wrapper must NOT open a transaction
    // of its own (an extra BEGIN/COMMIT per transition changed the session-lease
    // retry behaviour — runner.test.ts on CI, 430717cae).
    expect(body).not.toContain('dbTxSync(')
    expect(body).not.toContain('.transaction(')
    // The single allow-listed writer for this event family sits in the Tx twin.
    const twin = bodyOf(src, 'export function transitionNodeRunStatusTx(')
    expect(twin).toContain('rfc053-allow-direct-status-write')
    expect(twin.match(/\.update\(nodeRuns\)/g)?.length ?? 0).toBe(1)
  })

  test('mintNodeRun delegates to mintNodeRunTx and inserts nothing itself', () => {
    const src = readFileSync(resolve(SRC, 'nodeRunMint.ts'), 'utf8')
    const body = bodyOf(src, 'export async function mintNodeRun(')
    expect(body).toContain('createLegacySqliteNodeRunOperations(db).lifecycle.mint(args)')
    expect(body).not.toContain('.insert(nodeRuns)')
    // No new raw `.transaction(` site (s10 ledger) — the wrapper goes through dbTxSync.
    expect(body).not.toContain('.transaction(')
    const twin = bodyOf(src, 'export function mintNodeRunTx(')
    expect(twin).toContain('mintLegacySqliteNodeRunInTx(tx, args)')
  })
})
