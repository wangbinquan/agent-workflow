// Released picker oracle; executable runtime selection is covered through RunSelectionReader.
import { isFresherNodeRun } from './helpers/model/frozenSelection/pickers'
let fixtureRunSequence = 0
// RFC-056 patch 2026-05-25 + RFC-064 — isFresherNodeRun ranking post unification.
//
// Pre-RFC-064 this file tested a 4-level rank:
//   clarifyIteration desc → crossClarifyIteration desc → retryIndex desc → id desc
// RFC-064 collapsed self + cross counters into one `clarifyIteration` column,
// so the comparator is now 3-level: clarifyIteration → retryIndex → id. The
// patch-2026-05-25-fresher-noderun-includes-cci behavior is structurally
// preserved: a cross-clarify rerun bumps the unified counter, so the new
// pending row still outranks any prior done row at a lower clarifyIteration,
// even when retryIndex was inflated by RFC-042 same-session retries.

import { type PersistenceTables } from '@/platform/persistence/sessionTables'
import { describe, expect, test } from 'bun:test'

type Row = PersistenceTables['nodeRuns']['$inferSelect']

function mkRow(opts: {
  id: string
  clarifyIteration?: number
  retryIndex?: number
  status?: string
}): Row {
  return {
    seq: ++fixtureRunSequence,

    id: opts.id,
    taskId: 't',
    nodeId: 'n',
    parentNodeRunId: null,
    iteration: 0,
    shardKey: null,
    retryIndex: opts.retryIndex ?? 0,
    status: (opts.status ?? 'done') as Row['status'],
    startedAt: 0,
    finishedAt: null,
    pid: null,
    exitCode: null,
    errorMessage: null,
    promptText: null,
    tokInput: null,
    tokOutput: null,
    tokCacheCreate: null,
    tokCacheRead: null,
    tokTotal: null,
    preSnapshot: null,
    reviewIteration: 0,
    opencodeSessionId: null,
    inventorySnapshotJson: null,
    wrapperProgressJson: null,
    injectedMemoriesJson: null,
    portValidationFailuresJson: null,
  } as unknown as Row
}

describe('RFC-064 — isFresherNodeRun ranks by persisted mint sequence', () => {
  test('live task 01KS7FAW reproducer (now expressed via unified clarifyIteration): clarify-bumped pending beats prior retry-bumped done', () => {
    // Pre-RFC-064 shape (task 01KS7FAW50V9KV2SPH859NV8ER):
    //   - done    (cli=0, cci=0, retry=1) — `<workflow-clarify>`-only
    //   - pending (cli=0, cci=1, retry=0) — post-submit questioner rerun
    // RFC-064 unified shape:
    //   - done    (clarify=0, retry=1) — same role row
    //   - pending (clarify=1, retry=0) — the questioner rerun mint (today the
    //                                    unified dispatch path) bumps the counter.
    // Pre-patch: comparator chose the done row (retry=1 > 0).
    // Post-RFC-064: clarify=1 > clarify=0 wins → pending row picked.
    const done = mkRow({
      id: '01KS7GPRZ11RWZ6NTXN2VVAAKR',
      retryIndex: 1,
      status: 'done',
    })
    const pending = mkRow({
      id: '01KSEX6H6A8YPK2S9QA3PDSHY0',
      retryIndex: 0,
      status: 'pending',
    })
    expect(isFresherNodeRun(pending, done)).toBe(true)
    expect(isFresherNodeRun(done, pending)).toBe(false)
  })

  test('a later explicit sequence wins despite retry counters', () => {
    const lower = mkRow({ id: 'A', clarifyIteration: 0, retryIndex: 9 })
    const higher = mkRow({ id: 'B', clarifyIteration: 1, retryIndex: 0 })
    expect(isFresherNodeRun(higher, lower)).toBe(true)
    expect(isFresherNodeRun(lower, higher)).toBe(false)
  })

  test('process retries use their newly minted sequence', () => {
    const older = mkRow({ id: 'A', clarifyIteration: 2, retryIndex: 0 })
    const newer = mkRow({ id: 'B', clarifyIteration: 2, retryIndex: 1 })
    expect(isFresherNodeRun(newer, older)).toBe(true)
    expect(isFresherNodeRun(older, newer)).toBe(false)
  })

  test('later sequence wins when counters are equal', () => {
    const older = mkRow({ id: 'A', clarifyIteration: 0, retryIndex: 0 })
    const newer = mkRow({ id: 'B', clarifyIteration: 0, retryIndex: 0 })
    expect(isFresherNodeRun(newer, older)).toBe(true)
    expect(isFresherNodeRun(older, newer)).toBe(false)
  })

  test('returns true when incumbent is undefined (first comparison)', () => {
    const candidate = mkRow({ id: 'A', clarifyIteration: 0 })
    expect(isFresherNodeRun(candidate, undefined)).toBe(true)
  })
})
