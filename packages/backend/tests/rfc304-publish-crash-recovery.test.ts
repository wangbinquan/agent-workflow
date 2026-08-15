// RFC-304 §7.2 — a publish that was interrupted, and the round after it.
//
// The window: `publish` posts the comments, `ledger` records them. Crash,
// cancel or preemption in between leaves the comments ON the MR with nothing in
// the ledger that knows. The next round then reconciles against an empty
// history, decides every finding is new, and posts the entire review a second
// time — the duplicate-comment bug the ledger exists to prevent, reintroduced
// by a crash instead of by a bug.
//
// `sqlitePublishIntentStore` and `publishIntent`/`publishReconcileRemote` all
// shipped with PR-1c, fully tested, and nothing called them. So the failure
// above was live and no test anywhere was red.
//
// These tests reproduce the crash for real — the intent row is written, the
// comments exist on the fake host, the ledger is empty — and then run a normal
// round on top of it.

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
import { createSqliteFindingLedger } from '../src/modules/code-capability/infrastructure/sqliteFindingLedger'
import {
  readIntent,
  writeIntent,
} from '../src/modules/code-capability/infrastructure/sqlitePublishIntentStore'
import { withFingerprintMarker } from '../src/modules/code-capability/domain/publishReconcileRemote'
import {
  fingerprintFor,
  renderFindingComment,
} from '../src/modules/code-capability/domain/reviewComment'
import { hunkDigestFor } from '../src/modules/code-capability/domain/anchorLine'
import { parseDiffHunks } from '../src/modules/code-capability/domain/diffHunks'
import type {
  CodeHostCall,
  CodeHostPort,
  CodeHostResult,
} from '../src/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NONCE = 'crashnonce'
const ENDPOINT = 'ep_7'
const ANCHOR_REF = `${ENDPOINT}:41823:mr:412`

const webhook: WebhookTriggerFields = {
  event_type: 'mr_opened',
  provider: 'gitlab',
  project_id: '41823',
  mr_iid: '412',
  commit_sha: HEAD,
  repo_path: 'group/project',
  mr_title: 'Add retry logic',
}

const PATCH = '@@ -10,3 +10,4 @@\n context\n-removed\n+added one\n+added two\n context2\n'
const GITLAB_DIFF = [{ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: PATCH }]
const MR_BODY = {
  title: 'Add retry logic',
  diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: HEAD },
}

const FINDING = {
  file: 'src/a.ts',
  line: 11,
  severity: 'major' as const,
  title: 'unchecked index',
  body: 'This can be undefined.',
}

/**
 * The fingerprint the round WILL compute for `FINDING`.
 *
 * Derived exactly as `resolve-positions` derives it — from the hunk text — so
 * the comment seeded on the fake MR carries the same marker the round is about
 * to look for. A hand-written constant here would make the test pass or fail on
 * whether two strings happened to match, not on whether recovery works.
 */
function fingerprintOfFinding(): string {
  const hunks = parseDiffHunks(`--- a/src/a.ts\n+++ b/src/a.ts\n${PATCH}`)
  const location = { file: FINDING.file, line: FINDING.line, side: undefined }
  return fingerprintFor(FINDING, hunkDigestFor(location, hunks))
}

const okJson = (body: unknown): CodeHostResult => ({
  ok: true,
  status: 200,
  body: JSON.stringify(body),
  truncated: false,
})

/** A host that can be seeded with comments already on the MR. */
function fakeHost(existing: Array<{ id: string; body: string }> = []) {
  const calls: CodeHostCall[] = []
  let thread = existing.length
  const port: CodeHostPort = {
    async call(call) {
      calls.push(call)
      if (call.action === 'mr.get') return okJson(MR_BODY)
      if (call.action === 'mr.diff') return okJson(GITLAB_DIFF)
      if (call.action === 'comment.list') {
        // GitLab's discussion shape: a thread id plus its notes.
        return okJson(existing.map((c) => ({ id: c.id, notes: [{ body: c.body }] })))
      }
      if (call.action === 'comment.create-inline') {
        thread += 1
        return okJson({ id: `disc-${thread}` })
      }
      return okJson({ id: 1 })
    },
  }
  return { port, calls }
}

const fakeGit = (): GitPort => ({
  async fetchRef() {
    return { ok: true, resolvedSha: HEAD }
  },
  async checkoutDetached() {
    return { ok: true }
  },
  async addDisposableWorktree() {
    return { ok: true }
  },
  async removeDisposableWorktree() {
    return { ok: true }
  },
})

const envelope = (findings: unknown[]) =>
  `<workflow-output nonce="${NONCE}"><port name="findings">${JSON.stringify({ findings })}</port></workflow-output>`

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
    webhook,
    codeHostEndpointId: ENDPOINT,
    repoPath: home,
    worktreePath: home,
    ledger: createSqliteFindingLedger(db, { capability: 'mr-review', roundId }),
    publishIntents: { db, roundId, epoch: 1, anchorRef: ANCHOR_REF },
    makeCaller: () => async () => ({ stdout: envelope(findings), sessionId: 's1' }),
    protocolBlock: '',
    nonce: NONCE,
    budget: { sameSession: 1, freshSession: 0 },
    gate: { threshold: 'info', maxPerRound: 20 },
    shardConcurrency: 1,
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

describe('RFC-304 — a round that died between publishing and recording', () => {
  let db: DbClient
  let home: string
  let fingerprint: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-crash-'))
    fingerprint = fingerprintOfFinding()
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  /** The exact state a crash leaves behind: comment on the MR, ledger empty. */
  async function seedInterruptedPublish() {
    await writeIntent(db, {
      batchId: 'batch-dead',
      roundId: 'round-dead',
      epoch: 1,
      fingerprints: [fingerprint],
      anchorRef: ANCHOR_REF,
    })
    return fakeHost([
      {
        id: 'disc-existing',
        body: withFingerprintMarker(renderFindingComment(FINDING, fingerprint), fingerprint),
      },
    ])
  }

  test('the next round does NOT post the finding a second time', async () => {
    // The whole point. Without recovery the ledger is empty, the finding looks
    // new, and the author gets the same remark twice.
    const host = await seedInterruptedPublish()
    await runRound(db, home, host, [FINDING])
    expect(inlineCalls(host)).toHaveLength(0)
  })

  test('the interrupted batch is settled, not left pending forever', async () => {
    const host = await seedInterruptedPublish()
    await runRound(db, home, host, [FINDING])
    const intent = await readIntent(db, 'batch-dead')
    expect(intent?.state).toBe('settled')
  })

  test('the adopted comment’s thread id is recorded, so it can be settled later', async () => {
    // Adopting without the id would leave a finding that can never be resolved
    // when it stops appearing — it would just go quiet.
    const host = await seedInterruptedPublish()
    await runRound(db, home, host, [FINDING])
    const intent = await readIntent(db, 'batch-dead')
    expect(intent?.externalIds[fingerprint]).toBe('disc-existing')
  })

  test('a finding that never landed IS published by the next round', async () => {
    // The other half. A pending intent must not be read as "everything was
    // said" — that would suppress findings nobody ever saw.
    await writeIntent(db, {
      batchId: 'batch-dead',
      roundId: 'round-dead',
      epoch: 1,
      fingerprints: [fingerprint],
      anchorRef: ANCHOR_REF,
    })
    const host = fakeHost([]) // nothing actually made it to the MR
    await runRound(db, home, host, [FINDING])
    expect(inlineCalls(host)).toHaveLength(1)
  })

  test('an unrelated MR’s pending batch is not adopted here', async () => {
    // Intents are keyed by anchor; adopting another MR's batch would mark this
    // MR's findings as already-said and silence them.
    await writeIntent(db, {
      batchId: 'batch-other-mr',
      roundId: 'round-dead',
      epoch: 1,
      fingerprints: [fingerprint],
      anchorRef: `${ENDPOINT}:41823:mr:999`,
    })
    const host = fakeHost([])
    await runRound(db, home, host, [FINDING])
    expect(inlineCalls(host)).toHaveLength(1)
    expect((await readIntent(db, 'batch-other-mr'))?.state).toBe('pending')
  })
})

describe('RFC-304 — the intent is written before the call, not after', () => {
  let db: DbClient
  let home: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-crash-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('a host that rejects the comment still leaves a pending intent behind', async () => {
    // An intent written AFTER a successful call would record only the batches
    // that need no recovery. This is the case that proves the ordering: the
    // call failed, and the row must exist anyway.
    const rejecting: CodeHostPort = {
      async call(call) {
        if (call.action === 'mr.get') return okJson(MR_BODY)
        if (call.action === 'mr.diff') return okJson(GITLAB_DIFF)
        if (call.action === 'comment.list') return okJson([])
        if (call.action === 'comment.create-inline') {
          return { ok: false, code: 'forbidden', message: 'no permission' }
        }
        return okJson({ id: 1 })
      },
    }
    const roundId = ulid()
    const env: MrReviewEnvironment = {
      codeHost: rejecting,
      git: fakeGit(),
      webhook,
      codeHostEndpointId: ENDPOINT,
      repoPath: home,
      worktreePath: home,
      ledger: createSqliteFindingLedger(db, { capability: 'mr-review', roundId }),
      publishIntents: { db, roundId, epoch: 1, anchorRef: ANCHOR_REF },
      makeCaller: () => async () => ({ stdout: envelope([FINDING]), sessionId: 's1' }),
      protocolBlock: '',
      nonce: NONCE,
      budget: { sameSession: 1, freshSession: 0 },
      gate: { threshold: 'info', maxPerRound: 20 },
      shardConcurrency: 1,
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

    const { readPendingIntentsForAnchor } =
      await import('../src/modules/code-capability/infrastructure/sqlitePublishIntentStore')
    const pending = await readPendingIntentsForAnchor(db, ANCHOR_REF)
    expect(pending).toHaveLength(1)
  })

  test('a successful publish settles its own intent', async () => {
    const host = fakeHost([])
    await runRound(db, home, host, [FINDING])
    const { readPendingIntentsForAnchor } =
      await import('../src/modules/code-capability/infrastructure/sqlitePublishIntentStore')
    expect(await readPendingIntentsForAnchor(db, ANCHOR_REF)).toHaveLength(0)
  })
})
