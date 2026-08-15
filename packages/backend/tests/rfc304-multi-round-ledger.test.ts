// RFC-304 §6.1 (T27/T27b) — what makes the SECOND round different from the first.
//
// PR-4a published every finding every round. On an MR that is pushed to ten
// times that means ten copies of each remark, and the author stops reading any
// of them. This file drives the same MR through several rounds against the real
// sqlite ledger and pins the behaviour the design asks for:
//
//   still there  → not reposted, thread left open, `lastSeenAt` refreshed
//   new          → published
//   gone         → the thread is settled ONCE, on the active→disappeared edge
//   back again   → published under a NEW generation
//
// The edge is the part worth protecting. The first draft settled every absent
// finding every round, which on one long-lived MR produced 78 identical "no
// longer present" replies under the same thread and buried the human
// discussion. "Fires once" is therefore asserted by running a THIRD round and
// checking that nothing happens — a two-round test would pass either way.
//
// Everything is real except the host socket and the model: the runner, the
// stage engine, the contract order, the reconcile logic and the ledger rows are
// all production code.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createCodeCapabilityRunner } from '../src/modules/code-capability/composition/codeCapabilityRunner'
import {
  mrReviewAiStages,
  mrReviewProgramStages,
  type MrReviewEnvironment,
} from '../src/modules/code-capability/composition/mrReviewStages'
import {
  createSqliteFindingLedger,
  readLedgerForAnchor,
  type LedgerAnchor,
} from '../src/modules/code-capability/infrastructure/sqliteFindingLedger'
import type {
  CodeHostCall,
  CodeHostPort,
  CodeHostResult,
} from '../src/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NONCE = 'ledgernonce'
const ENDPOINT = 'ep_7'

const ANCHOR: LedgerAnchor = {
  codeHostEndpointId: ENDPOINT,
  stableProjectId: '41823',
  anchorKind: 'mr',
  anchorId: '412',
}

const webhookOf = (provider: 'gitlab' | 'github' = 'gitlab'): WebhookTriggerFields => ({
  event_type: 'mr_opened',
  provider,
  project_id: '41823',
  mr_iid: '412',
  commit_sha: HEAD,
  repo_path: 'group/project',
  mr_title: 'Add retry logic',
})

const PATCH = '@@ -10,3 +10,4 @@\n context\n-removed\n+added one\n+added two\n context2\n'
const GITLAB_DIFF = [{ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: PATCH }]
const MR_BODY = {
  title: 'Add retry logic',
  diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: HEAD },
}

const okJson = (body: unknown): CodeHostResult => ({
  ok: true,
  status: 200,
  body: JSON.stringify(body),
  truncated: false,
})

/**
 * A host that hands out a DISTINCT discussion id per inline comment.
 *
 * A constant id would let a wrong-thread bug pass: every resolve would name the
 * same discussion and look correct no matter which finding disappeared.
 */
function fakeHost(provider: 'gitlab' | 'github' = 'gitlab') {
  const calls: CodeHostCall[] = []
  let thread = 0
  const port: CodeHostPort = {
    async call(call) {
      calls.push(call)
      if (call.action === 'mr.get') return okJson(MR_BODY)
      if (call.action === 'mr.diff') return okJson(GITLAB_DIFF)
      if (call.action === 'comment.create-inline') {
        thread += 1
        return okJson({ id: `disc-${thread}` })
      }
      return okJson({ id: 1 })
    },
  }
  return { port, calls, provider }
}

const fakeGit = (): GitPort => ({
  async fetchRef() {
    return { ok: true, resolvedSha: HEAD }
  },
  async checkoutDetached() {
    return { ok: true }
  },
})

const envelope = (findings: unknown[]) =>
  `<workflow-output nonce="${NONCE}"><port name="findings">${JSON.stringify({ findings })}</port></workflow-output>`

const findingAt = (line: number, title: string) => ({
  file: 'src/a.ts',
  line,
  severity: 'major',
  title,
  body: `Something is wrong near line ${line}.`,
})

/** One round, wired exactly as production wires it — including the ledger. */
async function runRound(
  db: DbClient,
  home: string,
  host: ReturnType<typeof fakeHost>,
  findings: unknown[],
) {
  const roundId = ulid()
  const env: MrReviewEnvironment = {
    codeHost: host.port,
    git: fakeGit(),
    webhook: webhookOf(host.provider),
    codeHostEndpointId: ENDPOINT,
    repoPath: home,
    worktreePath: home,
    ledger: createSqliteFindingLedger(db, { capability: 'mr-review', roundId }),
    makeCaller: () => async () => ({ stdout: envelope(findings), sessionId: 's1' }),
    protocolBlock: '',
    nonce: NONCE,
    budget: { sameSession: 1, freshSession: 0 },
    gate: { threshold: 'info', maxPerRound: 20 },
  }
  const runner = createCodeCapabilityRunner({
    db,
    programStages: mrReviewProgramStages(env),
    aiStages: mrReviewAiStages(env),
  })
  const outcome = await runner.runRound({
    roundId,
    capability: 'mr-review',
    roundSeq: 1,
    worktreePath: home,
    repos: [{ name: 'main', path: home }],
    envelopeNonce: NONCE,
    resumeFromStage: null,
  })
  return { outcome, roundId }
}

const inlineCalls = (host: ReturnType<typeof fakeHost>) =>
  host.calls.filter((c) => c.action === 'comment.create-inline')
const resolveCalls = (host: ReturnType<typeof fakeHost>) =>
  host.calls.filter((c) => c.action === 'thread.resolve')
const overviews = (host: ReturnType<typeof fakeHost>) =>
  host.calls.filter((c) => c.action === 'comment.create')

describe('RFC-304 — a finding that is still there', () => {
  let db: DbClient
  let home: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-ledger-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('is published once and NOT reposted on the next round', async () => {
    // The bug PR-4b exists to fix. Ten pushes used to mean ten copies.
    const host = fakeHost()
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    expect(inlineCalls(host)).toHaveLength(1)

    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    expect(inlineCalls(host)).toHaveLength(1)
  })

  test('keeps its thread OPEN — it is not resolved just because it was seen before', async () => {
    // The failure the three-set design was chosen to avoid: dedupe plus
    // cleanup would suppress the new comment AND resolve the old thread,
    // leaving an unfixed problem with no live remark anywhere on the MR.
    const host = fakeHost()
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    expect(resolveCalls(host)).toHaveLength(0)
  })

  test('the second round’s overview says it is still open, not that nothing was found', async () => {
    // "No findings this round" printed directly above an unresolved thread is
    // the summary contradicting the MR it sits on.
    const host = fakeHost()
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])

    const body = String(overviews(host).at(-1)?.params.body ?? '')
    expect(body).toContain('no new findings')
    expect(body).toContain('still open')
  })

  test('leaves exactly one ledger row, still active', async () => {
    const host = fakeHost()
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])

    const rows = await readLedgerForAnchor(db, ANCHOR, 'mr-review')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.lifecycle).toBe('active')
  })

  test('the row remembers which thread it owns', async () => {
    // Without the thread id, settling later is impossible and the finding would
    // simply be forgotten instead of closed out.
    const host = fakeHost()
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    const rows = await readLedgerForAnchor(db, ANCHOR, 'mr-review')
    expect(rows[0]?.externalId).toBe('disc-1')
  })
})

describe('RFC-304 — a genuinely new finding', () => {
  let db: DbClient
  let home: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-ledger-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('is published even when an older one is still open', async () => {
    // Dedup must not turn into "say nothing after round one".
    const host = fakeHost()
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    await runRound(db, home, host, [findingAt(11, 'unchecked index'), findingAt(12, 'leaked fd')])

    expect(inlineCalls(host)).toHaveLength(2)
    const rows = await readLedgerForAnchor(db, ANCHOR, 'mr-review')
    expect(rows).toHaveLength(2)
  })
})

describe('RFC-304 — a finding that disappeared', () => {
  let db: DbClient
  let home: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-ledger-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('has its thread resolved, naming the thread it actually owns', async () => {
    const host = fakeHost()
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    await runRound(db, home, host, [])

    const resolves = resolveCalls(host)
    expect(resolves).toHaveLength(1)
    expect(resolves[0]?.params.thread).toBe('disc-1')
  })

  test('is resolved EXACTLY once — a third round says nothing further', async () => {
    // The 78-replies bug. A two-round test cannot see it; this is why the
    // third round is here.
    const host = fakeHost()
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    await runRound(db, home, host, [])
    await runRound(db, home, host, [])

    expect(resolveCalls(host)).toHaveLength(1)
  })

  test('is recorded as disappeared, not deleted', async () => {
    // History is the point: "this keeps coming back" is only answerable if the
    // old rows survive.
    const host = fakeHost()
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    await runRound(db, home, host, [])

    const rows = await readLedgerForAnchor(db, ANCHOR, 'mr-review')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.lifecycle).toBe('disappeared')
  })
})

describe('RFC-304 — a finding that came back', () => {
  let db: DbClient
  let home: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-ledger-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('is published again rather than treated as already-said', async () => {
    // The hole a design gate found: a `disappeared` row still counts as "in the
    // ledger", so a naive dedupe would suppress the republish and leave a
    // problem that is present again with no live thread — while the old thread
    // sits there resolved.
    const host = fakeHost()
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    await runRound(db, home, host, [])
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])

    expect(inlineCalls(host)).toHaveLength(2)
  })

  test('comes back under a NEW generation, keeping the old row', async () => {
    // The unique key carries `generation` precisely to allow this; reusing the
    // old row would erase the fact that it recurred.
    const host = fakeHost()
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    await runRound(db, home, host, [])
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])

    const rows = await readLedgerForAnchor(db, ANCHOR, 'mr-review')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.generation).sort()).toEqual([1, 2])
  })

  test('the republished thread is the new one, not the resolved one', async () => {
    const host = fakeHost()
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])
    await runRound(db, home, host, [])
    await runRound(db, home, host, [findingAt(11, 'unchecked index')])

    const rows = await readLedgerForAnchor(db, ANCHOR, 'mr-review')
    const latest = rows.find((r) => r.generation === 2)
    expect(latest?.externalId).toBe('disc-2')
    expect(latest?.lifecycle).toBe('active')
  })
})

describe('RFC-304 — a finding the host refused', () => {
  let db: DbClient
  let home: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-ledger-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('is NOT recorded, so the next round still tries to say it', async () => {
    // The worst possible ledger bug: recording a finding that never landed
    // would mark it "already said" forever, and the author would never see a
    // remark the platform believes it delivered.
    const host = fakeHost()
    const rejecting: CodeHostPort = {
      async call(call) {
        if (call.action === 'comment.create-inline') {
          return { ok: false, code: 'forbidden', message: 'no permission to comment' }
        }
        return host.port.call(call)
      },
    }
    const roundId = ulid()
    const env: MrReviewEnvironment = {
      codeHost: rejecting,
      git: fakeGit(),
      webhook: webhookOf(),
      codeHostEndpointId: ENDPOINT,
      repoPath: home,
      worktreePath: home,
      ledger: createSqliteFindingLedger(db, { capability: 'mr-review', roundId }),
      makeCaller: () => async () => ({
        stdout: envelope([findingAt(11, 'unchecked index')]),
        sessionId: 's1',
      }),
      protocolBlock: '',
      nonce: NONCE,
      budget: { sameSession: 1, freshSession: 0 },
      gate: { threshold: 'info', maxPerRound: 20 },
    }
    const runner = createCodeCapabilityRunner({
      db,
      programStages: mrReviewProgramStages(env),
      aiStages: mrReviewAiStages(env),
    })
    await runner.runRound({
      roundId,
      capability: 'mr-review',
      roundSeq: 1,
      worktreePath: home,
      repos: [{ name: 'main', path: home }],
      envelopeNonce: NONCE,
      resumeFromStage: null,
    })

    expect(await readLedgerForAnchor(db, ANCHOR, 'mr-review')).toHaveLength(0)
  })
})
