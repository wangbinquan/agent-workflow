// RFC-304 T36–T40 — the monitor's main loop, against a real database.
//
// The loop's interesting behaviour is almost entirely in what it does NOT do:
// most wake-ups must produce no task and no comment, a conflict must produce a
// report and nothing else, and a merged merge request must produce nothing at
// all. Those are the cases here, and each is asserted by counting the things
// that must not exist — a test that only checked the happy path would pass
// against an implementation that starts a round for every event, which is
// exactly the implementation this design exists to avoid.
//
// Real: the database, the schema, the four scripts (as python subprocesses),
// the work-item and round rows, the observation ledger. Faked: the code host
// (one recording double) and the round dispatcher, because "a round started" is
// the fact under test, not what the round then does.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeWorkItems, codeWorkObservations, codeWorkRounds } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import {
  closeMonitorItem,
  runMonitorWake,
  type MonitorScriptSet,
  type RoundDispatcher,
} from '../src/modules/code-capability/application/monitorLoop'
import type { MonitorScriptDefinition } from '../src/modules/code-capability/application/monitorScripts'
import {
  ensureWorkItem,
  type WorkItemIdentity,
} from '../src/modules/code-capability/infrastructure/sqliteMonitorStore'
import type { CodeHostCall, CodeHostPort } from '../src/modules/code-capability/ports/codeHostPort'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const IDENTITY: WorkItemIdentity = {
  codeHostEndpointId: 'ep-1',
  stableProjectId: 'proj-9',
  capability: 'mr-monitor',
  anchorKind: 'mr',
  anchorId: '412',
}

/** A python script that emits `port` carrying the given JSON, verbatim. */
const emits = (port: string, value: unknown): MonitorScriptDefinition => ({
  name: port as MonitorScriptDefinition['name'],
  language: 'python',
  script: [
    'import os, json',
    'n = os.environ["AW_ENVELOPE_NONCE"]',
    `body = json.dumps(json.loads(r'''${JSON.stringify(value)}'''))`,
    'print(f"<workflow-output nonce=\\"{n}\\">")',
    `print(f"<port name=\\"${port}\\">{body}</port>")`,
    'print("</workflow-output>")',
  ].join('\n'),
})

const collectOf = (over: Record<string, unknown> = {}): MonitorScriptDefinition =>
  emits('collect', {
    conflict: false,
    unresolvedComments: [],
    gate: { status: 'pass' },
    headSha: 'sha-aaa',
    ...over,
  })

function recordingHost(): { port: CodeHostPort; calls: CodeHostCall[] } {
  const calls: CodeHostCall[] = []
  return {
    calls,
    port: {
      call: async (call) => {
        calls.push(call)
        return { ok: true, status: 201, body: '{"id":7}', truncated: false }
      },
    },
  }
}

function recordingDispatcher(): {
  dispatch: RoundDispatcher
  seen: Array<{ capability: string; roundSeq: number; packages: number }>
} {
  const seen: Array<{ capability: string; roundSeq: number; packages: number }> = []
  return {
    seen,
    dispatch: async (req) => {
      seen.push({
        capability: req.capability,
        roundSeq: req.roundSeq,
        packages: req.packages.length,
      })
      return { taskId: `task-${req.roundId}` }
    },
  }
}

describe('RFC-304 T36 — the monitor loop', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  const countRounds = async (): Promise<number> => (await db.select().from(codeWorkRounds)).length

  test('a healthy merge request produces an observation and NOTHING else', async () => {
    // The ~150-a-day case. No task, no comment: the whole reason `noop` is in
    // the union rather than being expressed as an empty result or a fake review.
    const host = recordingHost()
    const dispatcher = recordingDispatcher()

    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: { collect: collectOf() },
      dispatch: dispatcher.dispatch,
      codeHost: host.port,
      reportTarget: { __project__: 'p', mr: '412' },
    })

    expect(out.kind).toBe('noop')
    expect(await countRounds()).toBe(0)
    expect(dispatcher.seen).toEqual([])
    expect(host.calls).toEqual([])

    // …but it is not invisible. "Did it look, and when?" has an answer without
    // anyone polling the code host to find out.
    const observations = await db.select().from(codeWorkObservations)
    expect(observations.length).toBe(1)
    expect(observations[0]?.kind).toBe('noop')
    expect(observations[0]?.observedRevision).toBe('sha-aaa')
  })

  test('a work package opens exactly one round and starts its task', async () => {
    const dispatcher = recordingDispatcher()
    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: {
        collect: collectOf(),
        arbitrate: emits('arbitrate', [{ capability: 'mr-review', items: [] }]),
      },
      dispatch: dispatcher.dispatch,
    })

    expect(out.kind).toBe('dispatched')
    if (out.kind !== 'dispatched') throw new Error('expected a dispatched round')
    expect(out.capability).toBe('mr-review')
    expect(out.roundSeq).toBe(1)
    // The task the dispatcher started is the one for THIS round — a dispatcher
    // handed the wrong round id would still return a task and still look fine.
    expect(out.taskId).toBe(`task-${out.roundId}`)
    expect(dispatcher.seen).toEqual([{ capability: 'mr-review', roundSeq: 1, packages: 1 }])

    const rounds = await db.select().from(codeWorkRounds)
    expect(rounds.length).toBe(1)
    expect(rounds[0]?.baselineSha).toBe('sha-aaa')
  })

  test('the second wake-up is round 2 of the SAME work item, not a second item', async () => {
    // Round numbering is what makes "this MR has been reviewed three times"
    // representable. The wake path this replaces launched every round as
    // `roundSeq: 1` with no work item at all, so the question had no answer.
    const dispatcher = recordingDispatcher()
    const scripts: MonitorScriptSet = {
      collect: collectOf(),
      arbitrate: emits('arbitrate', [{ capability: 'mr-review', items: [] }]),
    }

    await runMonitorWake({ db, identity: IDENTITY, scripts, dispatch: dispatcher.dispatch })
    await runMonitorWake({ db, identity: IDENTITY, scripts, dispatch: dispatcher.dispatch })

    expect(dispatcher.seen.map((s) => s.roundSeq)).toEqual([1, 2])
    expect((await db.select().from(codeWorkItems)).length).toBe(1)
  })

  test('several packages of one capability share ONE round (T38)', async () => {
    // "依次做完这批，统一推送一次" — the batch is what makes a single push
    // possible. Opening a round per package would push once per package, which
    // is three CI runs and three notifications for one decision.
    const dispatcher = recordingDispatcher()
    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: {
        collect: collectOf(),
        arbitrate: emits('arbitrate', [
          { capability: 'mr-review', items: [], note: 'first' },
          { capability: 'mr-review', items: [], note: 'second' },
        ]),
      },
      dispatch: dispatcher.dispatch,
    })

    expect(out.kind === 'dispatched' && out.packages.length).toBe(2)
    expect(await countRounds()).toBe(1)
    expect(dispatcher.seen).toEqual([{ capability: 'mr-review', roundSeq: 1, packages: 2 }])
  })

  test('a batch that mixes capabilities is refused, with no round', async () => {
    const dispatcher = recordingDispatcher()
    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: {
        collect: collectOf(),
        arbitrate: emits('arbitrate', [
          { capability: 'mr-review', items: [] },
          { capability: 'noop', reason: 'nothing', observedRevision: 'sha-aaa' },
        ]),
      },
      dispatch: dispatcher.dispatch,
    })

    expect(out.kind).toBe('blocked')
    expect(out.kind === 'blocked' && out.reason).toContain('two rounds')
    expect(await countRounds()).toBe(0)
    expect(dispatcher.seen).toEqual([])
  })

  test('an empty arbitration is blocked, not read as a quiet day', async () => {
    // `[]` and `[{noop}]` are different claims: one is "nothing to do", the
    // other is "I have nothing to say". Collapsing them would let a broken
    // arbitration script look exactly like a healthy merge request.
    const dispatcher = recordingDispatcher()
    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: { collect: collectOf(), arbitrate: emits('arbitrate', []) },
      dispatch: dispatcher.dispatch,
    })

    expect(out.kind).toBe('blocked')
    expect(await countRounds()).toBe(0)
  })

  test('a failed collect blocks the round and records why (T35b)', async () => {
    const dispatcher = recordingDispatcher()
    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: {
        collect: {
          name: 'collect',
          language: 'python',
          script: 'import sys\nprint("token expired", file=sys.stderr)\nsys.exit(1)',
        },
      },
      dispatch: dispatcher.dispatch,
    })

    expect(out.kind).toBe('blocked')
    expect(out.kind === 'blocked' && out.reason).toContain('token expired')
    expect(await countRounds()).toBe(0)

    const observations = await db.select().from(codeWorkObservations)
    expect(observations[0]?.kind).toBe('blocked')
  })

  test('classify does not run on a green gate', async () => {
    // A log parser handed a passing pipeline's logs will return SOMETHING, and
    // arbitration would then treat it as a problem to fix on a merge request
    // whose pipeline is green.
    const dispatcher = recordingDispatcher()
    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: {
        collect: collectOf({ gate: { status: 'pass' } }),
        // Would block the round if it ran at all.
        classify: { name: 'classify', language: 'python', script: 'import sys\nsys.exit(9)' },
      },
      dispatch: dispatcher.dispatch,
    })

    expect(out.kind).toBe('noop')
  })
})

describe('RFC-304 T39 — conflicts are reported, never fixed', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('a conflict posts one report and starts no round', async () => {
    const host = recordingHost()
    const dispatcher = recordingDispatcher()

    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: { collect: collectOf({ conflict: true }) },
      dispatch: dispatcher.dispatch,
      codeHost: host.port,
      reportTarget: { __project__: 'p', mr: '412' },
    })

    expect(out.kind).toBe('conflict')
    expect(out.kind === 'conflict' && out.reported).toBe(true)
    expect(dispatcher.seen).toEqual([])
    expect((await db.select().from(codeWorkRounds)).length).toBe(0)

    expect(host.calls.length).toBe(1)
    expect(host.calls[0]?.action).toBe('comment.create')
    // The report has to say the machine will NOT fix it, or a reader assumes
    // it is being handled and the merge request simply stops.
    expect(host.calls[0]?.params.body).toContain('not')
  })

  test('the same conflicted revision is reported ONCE, however many events arrive', async () => {
    // A conflicted MR keeps producing events for as long as it sits there —
    // comments, pipeline runs, other people's pushes. One report per event is
    // how the bot gets muted, and a muted bot loses the reports that matter.
    const host = recordingHost()
    const dispatcher = recordingDispatcher()
    const scripts: MonitorScriptSet = { collect: collectOf({ conflict: true }) }

    for (const eventId of ['e1', 'e2', 'e3']) {
      await runMonitorWake({
        db,
        identity: IDENTITY,
        scripts,
        dispatch: dispatcher.dispatch,
        codeHost: host.port,
        reportTarget: { __project__: 'p', mr: '412' },
        eventId,
      })
    }

    expect(host.calls.length).toBe(1)
  })

  test('a NEW revision that still conflicts is reported again', async () => {
    // The author pushing is new information. Staying silent because "we already
    // said that" would leave someone who tried to fix it with no signal either
    // way.
    const host = recordingHost()
    const dispatcher = recordingDispatcher()

    await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: { collect: collectOf({ conflict: true, headSha: 'sha-aaa' }) },
      dispatch: dispatcher.dispatch,
      codeHost: host.port,
      reportTarget: { __project__: 'p', mr: '412' },
      eventId: 'e1',
    })
    await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: { collect: collectOf({ conflict: true, headSha: 'sha-bbb' }) },
      dispatch: dispatcher.dispatch,
      codeHost: host.port,
      reportTarget: { __project__: 'p', mr: '412' },
      eventId: 'e2',
    })

    expect(host.calls.length).toBe(2)
  })
})

describe('RFC-304 T40 — a merged merge request stops the loop', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('after close, a later event runs no scripts and opens no round', async () => {
    const dispatcher = recordingDispatcher()

    await closeMonitorItem({ db, identity: IDENTITY, reason: 'merge request merged' })

    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: {
        // Would block loudly if the loop got as far as running it — proof the
        // close check happens BEFORE any subprocess is spent.
        collect: { name: 'collect', language: 'python', script: 'import sys\nsys.exit(2)' },
      },
      dispatch: dispatcher.dispatch,
    })

    expect(out.kind).toBe('closed')
    expect((await db.select().from(codeWorkRounds)).length).toBe(0)
    expect(dispatcher.seen).toEqual([])
  })

  test('closing twice is idempotent', async () => {
    const first = await closeMonitorItem({ db, identity: IDENTITY, reason: 'merged' })
    const second = await closeMonitorItem({ db, identity: IDENTITY, reason: 'merged again' })
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(false)

    const items = await db.select().from(codeWorkItems)
    expect(items.length).toBe(1)
    expect(items[0]?.status).toBe('closed')
  })
})

describe('RFC-304 T10e — one ingress event, one capability', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('a second capability answering the same event is refused', async () => {
    // Without this the same note both triggers a review and wakes the monitor
    // into an independent reaction, and the merge request gets two responses to
    // one comment.
    const dispatcher = recordingDispatcher()
    const scripts: MonitorScriptSet = {
      collect: collectOf(),
      arbitrate: emits('arbitrate', [{ capability: 'mr-review', items: [] }]),
    }

    const first = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts,
      dispatch: dispatcher.dispatch,
      eventId: 'delivery-77',
    })
    const second = await runMonitorWake({
      db,
      identity: { ...IDENTITY, capability: 'mr-review' },
      scripts,
      dispatch: dispatcher.dispatch,
      eventId: 'delivery-77',
    })

    expect(first.kind).toBe('dispatched')
    expect(second.kind).toBe('claimed-elsewhere')
    expect(dispatcher.seen.length).toBe(1)
  })

  test('wake-ups with no event id are never treated as duplicates', async () => {
    // A wake request and a recovery pass legitimately have no ingress event.
    // A unique index that folded them together would let one manual re-run
    // silently suppress every later one.
    const dispatcher = recordingDispatcher()
    const scripts: MonitorScriptSet = { collect: collectOf() }

    const a = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts,
      dispatch: dispatcher.dispatch,
    })
    const b = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts,
      dispatch: dispatcher.dispatch,
    })

    expect(a.kind).toBe('noop')
    expect(b.kind).toBe('noop')
    expect((await db.select().from(codeWorkObservations)).length).toBe(2)
  })
})

describe('RFC-304 N7 — the monitor never polls', () => {
  test('no timer appears anywhere in the loop', () => {
    // A source-level assertion because the failure is invisible at runtime: a
    // `setInterval` that re-collects "just in case" would make every test here
    // pass and would spend its day asking 200 repositories × 50 merge requests
    // a question whose answer is "nothing changed". The design forbids it (N7,
    // E3) and this is the only place that can catch it being added.
    const files = [
      'src/modules/code-capability/application/monitorLoop.ts',
      'src/modules/code-capability/application/monitorScripts.ts',
      'src/modules/code-capability/infrastructure/sqliteMonitorStore.ts',
    ]
    for (const file of files) {
      const source = readFileSync(resolve(import.meta.dir, '..', file), 'utf8')
      expect(source).not.toContain('setInterval')
      expect(source).not.toContain('setTimeout')
    }
  })
})

describe('RFC-304 — work item identity', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('repeated wake-ups on one merge request share a single work item', async () => {
    // Six wake-ups, one item. Note what this does NOT prove: `bun:sqlite` is
    // synchronous, so `Promise.all` here interleaves nothing at the database
    // level and cannot exhibit a real insert race. What it does prove is the
    // property that matters day to day — the identity is idempotent, so an MR
    // that is pushed to six times has one item and six observations rather than
    // six items with one each. The race itself is handled by
    // `onConflictDoNothing` plus the unique index, and is verified by removing
    // the former (the insert then throws instead of returning the winner's row).
    const dispatcher = recordingDispatcher()
    const scripts: MonitorScriptSet = { collect: collectOf() }

    await Promise.all(
      Array.from({ length: 6 }, () =>
        runMonitorWake({
          db,
          identity: IDENTITY,
          scripts,
          dispatch: dispatcher.dispatch,
          eventId: ulid(),
        }),
      ),
    )

    const items = await db.select().from(codeWorkItems).where(eq(codeWorkItems.anchorId, '412'))
    expect(items.length).toBe(1)
    expect((await db.select().from(codeWorkObservations)).length).toBe(6)
  })

  test('an item that already exists is adopted, not duplicated', async () => {
    // The deterministic half of the property above: `ensureWorkItem` called
    // twice returns the same id, and only the first call reports `created`.
    const first = await ensureWorkItem({ db, ...IDENTITY })
    const second = await ensureWorkItem({ db, ...IDENTITY })

    expect(second.id).toBe(first.id)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
  })
})

// RFC-304 T51a — the arms the monitor can actually select.
//
// This block exists because of a gap found while wiring `ci-fix`: the whole
// `mr-comment-fix` sequence shipped in PR-7, complete and unit-tested, while
// `WorkPackageSchema` still admitted only `noop` and `mr-review`. An arbitration
// script that selected comment repair was therefore rejected as malformed and
// the round was `blocked` — the capability was unreachable through the only
// path that reaches it, and nothing was red, because a missing arm looks
// exactly like a well-formed refusal.
//
// The union is deliberately closed (declaring an arm the platform cannot run
// lets a script select work that dies at round start with "no such sequence",
// which reads as the platform being broken). Closed means each capability has
// to be let in ON PURPOSE — so each one gets a test that it was.
describe('RFC-304 T51a — every shipped capability is selectable', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('arbitration can select mr-comment-fix', async () => {
    const dispatcher = recordingDispatcher()
    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: {
        collect: collectOf(),
        arbitrate: emits('arbitrate', [
          { capability: 'mr-comment-fix', items: [{ threadId: 'thread-1' }] },
        ]),
      },
      dispatch: dispatcher.dispatch,
    })

    expect(out.kind).toBe('dispatched')
    expect(out.kind === 'dispatched' && out.capability).toBe('mr-comment-fix')
  })

  test('arbitration can select ci-fix', async () => {
    const dispatcher = recordingDispatcher()
    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: {
        collect: collectOf({ gate: { status: 'fail' } }),
        arbitrate: emits('arbitrate', [
          { capability: 'ci-fix', items: [{ issueRef: 'compile:src/a.ts' }] },
        ]),
      },
      dispatch: dispatcher.dispatch,
    })

    expect(out.kind).toBe('dispatched')
    expect(out.kind === 'dispatched' && out.capability).toBe('ci-fix')
  })

  test('a red pipeline dispatches ci-fix with NO arbitrate script configured', async () => {
    // The join that matters most, and the one nothing else covers: on day one
    // no deployment has written an arbitrate script, so the built-in
    // `defaultArbitrate` is what every red pipeline meets. While it answered
    // "this version cannot repair that yet", the entire capability was
    // unreachable in practice and nothing anywhere went red.
    const dispatcher = recordingDispatcher()
    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: {
        collect: collectOf({ gate: { status: 'fail' } }),
        classify: emits('classify', [
          { type: 'unit-test', message: 'retry spec failed' },
          { type: 'compile', file: 'src/a.ts', message: 'cannot find name Foo' },
        ]),
        // deliberately no `arbitrate`
      },
      dispatch: dispatcher.dispatch,
    })

    expect(out.kind).toBe('dispatched')
    expect(out.kind === 'dispatched' && out.capability).toBe('ci-fix')
    // And it arrived ordered: compile before unit-test, because a compile break
    // makes the other result unmeasurable.
    const pkg = out.kind === 'dispatched' ? out.packages[0] : undefined
    expect(pkg?.capability === 'ci-fix' && pkg.items.map((i) => i.issueRef)).toEqual([
      'compile:src/a.ts',
      'unit-test',
    ])
  })

  test('an unresolved comment dispatches mr-comment-fix with no arbitrate script', async () => {
    const dispatcher = recordingDispatcher()
    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: {
        collect: collectOf({
          unresolvedComments: [{ threadId: 'disc-1', author: 'ann', body: 'why?' }],
        }),
      },
      dispatch: dispatcher.dispatch,
    })

    expect(out.kind).toBe('dispatched')
    expect(out.kind === 'dispatched' && out.capability).toBe('mr-comment-fix')
  })

  test('a red pipeline nobody classified stays a noop', async () => {
    // Red with no classification is a real state, and it needs a person rather
    // than an agent dispatched into a worktree with nothing to go on.
    const dispatcher = recordingDispatcher()
    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: { collect: collectOf({ gate: { status: 'fail' } }) },
      dispatch: dispatcher.dispatch,
    })

    expect(out.kind).toBe('noop')
    expect(dispatcher.seen).toEqual([])
  })

  test('a capability the platform does NOT ship is still refused', async () => {
    // The other half of "closed". Opening the union arm by arm is only
    // meaningful if an unknown name is still rejected here rather than at round
    // start, where the failure names a missing sequence instead of a bad script.
    const dispatcher = recordingDispatcher()
    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: {
        collect: collectOf(),
        arbitrate: emits('arbitrate', [{ capability: 'deploy-to-prod', items: [] }]),
      },
      dispatch: dispatcher.dispatch,
    })

    expect(out.kind).toBe('blocked')
    expect(dispatcher.seen).toEqual([])
  })
})
