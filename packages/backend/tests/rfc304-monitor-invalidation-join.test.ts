// RFC-304 T45 — the monitor is what RUNS the invalidation.
//
// This file exists because of what the completeness audit found (plan §2bis).
// `invalidatePendingOnPush` was complete and unit-tested, and nothing in `src`
// imported it. The rule existed; the moment it was supposed to fire did not.
//
// That is the pattern this RFC keeps rediscovering — both halves correct, no
// join — and it is invisible for the same reason every time: an absent call
// raises no error, so nothing is red.
//
// The specific damage of THIS gap is quiet rather than loud, which is why it
// survived. `verify-baseline` still refuses to push a stale artifact, so
// nothing WRONG is ever applied. What happens instead: the diff sits on the
// thread looking live, the author replies `/aw apply` two days later, and only
// then learns it expired. Nobody told them, and the thing they were told to do
// turned out not to work. T45's whole point is that the platform speaks at the
// moment the branch moves rather than at the moment somebody tries to use it.
//
// The join is placed right after `collect`, because `collect` reporting the
// current head is the only moment in the loop where the platform knows the
// branch moved at all.
//
// Real: the database, the schema, the four scripts as python subprocesses, the
// artifact rows. Faked: the code host and git (recording doubles), because what
// is under test is whether the invalidation RUNS, not what git does when it
// does.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeArtifacts } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import {
  runMonitorWake,
  type MonitorScriptSet,
  type RoundDispatcher,
} from '../src/modules/code-capability/application/monitorLoop'
import type { MonitorScriptDefinition } from '../src/modules/code-capability/application/monitorScripts'
import { ensureWorkItem } from '../src/modules/code-capability/infrastructure/sqliteMonitorStore'
import type { WorkItemIdentity } from '../src/modules/code-capability/infrastructure/sqliteMonitorStore'
import type { CodeHostCall, CodeHostPort } from '../src/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const IDENTITY: WorkItemIdentity = {
  codeHostEndpointId: 'ep-1',
  stableProjectId: 'proj-9',
  capability: 'mr-monitor',
  anchorKind: 'mr',
  anchorId: '412',
}

const OLD_HEAD = 'sha-old-000000000000'
const NEW_HEAD = 'sha-new-111111111111'

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

/** A healthy merge request at `headSha` — the `noop` path, so nothing else runs. */
const scriptsAtHead = (headSha: string): MonitorScriptSet => ({
  collect: emits('collect', {
    conflict: false,
    unresolvedComments: [],
    gate: { status: 'pass' },
    headSha,
  }),
})

const dispatch: RoundDispatcher = async (req) => ({ taskId: `task-${req.roundId}` })

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

function recordingGit(): { port: GitPort; deletedRefs: string[] } {
  const deletedRefs: string[] = []
  const port = {
    deleteRef: async (input: { repoPath: string; ref: string }) => {
      deletedRefs.push(input.ref)
      return { ok: true as const }
    },
  } as unknown as GitPort
  return { port, deletedRefs }
}

describe('RFC-304 T45 — a push through the monitor invalidates the pending change', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  /** A live artifact frozen against `baseSha`, waiting for `/aw apply`. */
  const seedPending = async (baseSha: string): Promise<string> => {
    const item = await ensureWorkItem({ db, ...IDENTITY, now: 1_000 })
    await db.insert(codeArtifacts).values({
      id: 'art-1',
      repoPath: '/tmp/repo',
      commitSha: 'commit-abc',
      baseSha,
      digest: 'd'.repeat(64),
      keepRef: 'refs/aw/keep/art-1',
      roundId: null,
      workItemId: item.id,
      generation: 1,
      refCount: 1,
      state: 'live',
      createdAt: 1_000,
      releasedAt: null,
    })
    return item.id
  }

  const stateOf = async (): Promise<string> => {
    const [row] = await db.select().from(codeArtifacts).where(eq(codeArtifacts.id, 'art-1'))
    return row?.state ?? 'missing'
  }

  test('the branch moving past a pending change RELEASES it and says so on the thread', async () => {
    // The assertion the missing join would have failed. Before the wiring the
    // artifact stayed `live` forever and the thread stayed silent — the state
    // an author reads as "this is still applicable".
    const host = recordingHost()
    const git = recordingGit()
    await seedPending(OLD_HEAD)

    await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: scriptsAtHead(NEW_HEAD),
      dispatch,
      codeHost: host.port,
      git: git.port,
      reportTarget: { __project__: 'proj-9', mr: '412' },
    })

    expect(await stateOf()).toBe('superseded')
    expect(git.deletedRefs).toEqual(['refs/aw/keep/art-1'])

    const notices = host.calls.filter((c) => c.action === 'comment.reply-thread')
    expect(notices).toHaveLength(1)
    // Names the new revision, so a reader can tell WHICH push expired it rather
    // than being told only that something expired.
    expect(String(notices[0]?.params['body'])).toContain(NEW_HEAD.slice(0, 12))
  })

  test('a wake-up at the SAME head leaves the pending change alone and stays silent', async () => {
    // The half that makes the feature usable rather than merely correct. This
    // platform pushes its own commits and re-reports the same revision from
    // several events; invalidating on every wake-up would expire every change
    // before anyone could confirm one, and would say so each time.
    const host = recordingHost()
    const git = recordingGit()
    await seedPending(OLD_HEAD)

    await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: scriptsAtHead(OLD_HEAD),
      dispatch,
      codeHost: host.port,
      git: git.port,
      reportTarget: { __project__: 'proj-9', mr: '412' },
    })

    expect(await stateOf()).toBe('live')
    expect(git.deletedRefs).toEqual([])
    expect(host.calls.filter((c) => c.action === 'comment.reply-thread')).toHaveLength(0)
  })

  test('the SECOND event carrying the same push says nothing more', async () => {
    // One push arrives as several events — `mr_updated`, a pipeline start, a
    // comment from CI — and each wakes the monitor. Idempotence here is not an
    // optimisation: without it the thread gets the same expiry notice three
    // times for one push, which is exactly the noise §11.1 exists to prevent.
    const host = recordingHost()
    const git = recordingGit()
    await seedPending(OLD_HEAD)

    const wake = async (): Promise<void> => {
      await runMonitorWake({
        db,
        identity: IDENTITY,
        scripts: scriptsAtHead(NEW_HEAD),
        dispatch,
        codeHost: host.port,
        git: git.port,
        reportTarget: { __project__: 'proj-9', mr: '412' },
      })
    }
    await wake()
    await wake()
    await wake()

    expect(host.calls.filter((c) => c.action === 'comment.reply-thread')).toHaveLength(1)
    expect(git.deletedRefs).toEqual(['refs/aw/keep/art-1'])
  })

  test('a loop with no git port runs unchanged rather than failing', async () => {
    // `git` is optional, and this pins what that means: the pre-T45 behaviour —
    // never invalidates — rather than a wake-up that throws. A monitor whose
    // wake-ups crash stops observing, which is a far worse failure than a
    // pending change nobody released.
    const host = recordingHost()
    await seedPending(OLD_HEAD)

    const out = await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: scriptsAtHead(NEW_HEAD),
      dispatch,
      codeHost: host.port,
      reportTarget: { __project__: 'proj-9', mr: '412' },
    })

    expect(out.kind).toBe('noop')
    expect(await stateOf()).toBe('live')
  })

  test('with no pending change a push is silent', async () => {
    // The ~150-a-day case: most pushes have nothing waiting on them. If this
    // ever posted, every ordinary push to every watched merge request would get
    // a comment about a change that never existed.
    const host = recordingHost()
    const git = recordingGit()
    await ensureWorkItem({ db, ...IDENTITY, now: 1_000 })

    await runMonitorWake({
      db,
      identity: IDENTITY,
      scripts: scriptsAtHead(NEW_HEAD),
      dispatch,
      codeHost: host.port,
      git: git.port,
      reportTarget: { __project__: 'proj-9', mr: '412' },
    })

    expect(host.calls.filter((c) => c.action === 'comment.reply-thread')).toHaveLength(0)
    expect(git.deletedRefs).toEqual([])
  })
})
