// RFC-304 §6.1 — `mr-review` as the stage engine runs it: one registered
// implementation per contract stage.
//
// ## Why this is per-stage rather than one function
//
// It would be less code to run the whole chain inside a single stage, and it
// would pass the same tests. It would also silently delete the hook mechanism:
// the engine fires `pre`/`post` at each stage BOUNDARY, so a sequence collapsed
// into one stage has exactly one boundary and a team's injection and blocking
// points quietly stop existing. Nothing would report that — the round would run
// green with hooks that never fire.
//
// So each stage here reads the artifacts the contract says it `requires` and
// returns the ones it `produces`. That contract is validated at author time
// (`checkBuiltinContracts`), which means a stage reaching for an artifact
// nothing upstream produces is caught before it becomes an empty value three
// stages later.
//
// ## What a stage may assume
//
// Only its declared `requires`. Reading an artifact the contract does not list
// works today and breaks the moment someone reorders the sequence — the failure
// then surfaces as a wrong review rather than as a missing input.

import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { fetchDiff } from '@/modules/code-capability/application/fetchDiff'
import { prepareWorktree } from '@/modules/code-capability/application/prepareWorktree'
import {
  publishReview,
  type PlacedFinding,
  type PublishedFinding,
  type UnplacedFinding,
} from '@/modules/code-capability/application/publishReview'
import { REVIEW_PORT } from '@/modules/code-capability/application/reviewStage'
import {
  runReviewShards,
  type ShardOutcome,
} from '@/modules/code-capability/application/reviewShards'
import { runGuardedAiStage } from '@/modules/code-capability/application/determinismGuard'
import { recoverPublishIntents } from '@/modules/code-capability/application/recoverPublishIntents'
import {
  enterPublishSection,
  leavePublishSection,
} from '@/modules/code-capability/infrastructure/sqliteWorkItemStore'
import {
  settleIntent,
  writeIntent,
} from '@/modules/code-capability/infrastructure/sqlitePublishIntentStore'
import type {
  StageArtifacts,
  StageResult,
  StageRunContext,
} from '@/modules/code-capability/application/stageEngine'
import type {
  AiCaller,
  AttemptRecorder,
  RetryBudget,
} from '@/modules/code-capability/application/determinismGuard'
import { hunkDigestFor, resolveAnchoredLine } from '@/modules/code-capability/domain/anchorLine'
import type { DiffHunk } from '@/modules/code-capability/domain/anchorResolve'
import { applyGate, type GateConfig } from '@/modules/code-capability/domain/findingGate'
import {
  detectCodeChanged,
  planSettleStale,
  reconcileFindings,
  type ReconcileAction,
} from '@/modules/code-capability/domain/findingReconcile'
import { readResolvedFindings } from '@/modules/code-capability/domain/publishReconcileRemote'
import type { DiffOmission, FileDiff } from '@/modules/code-capability/domain/mrDiffNormalize'
import {
  apiProjectAddress,
  resolveTarget,
  type RoundTarget,
} from '@/modules/code-capability/domain/resolveTarget'
import {
  fingerprintFor,
  renderFindingComment,
  renderOverviewPrelude,
} from '@/modules/code-capability/domain/reviewComment'
import {
  checkReviewSemantics,
  ReviewEnvelopeSchema,
  type ReviewEnvelope,
  type ReviewFinding,
} from '@/modules/code-capability/domain/reviewEnvelope'
import { buildGlobalReviewPrompt } from '@/modules/code-capability/domain/reviewPrompt'
import {
  DEFAULT_SPLIT,
  splitDiff,
  type DiffShard,
  type SplitDiffOptions,
} from '@/modules/code-capability/domain/splitDiff'
import type { GitlabDiffRefs } from '@/modules/code-capability/domain/reviewPosition'
import type { LedgerAnchor } from '@/modules/code-capability/infrastructure/sqliteFindingLedger'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'
import type { FindingLedgerPort } from '@/modules/code-capability/ports/findingLedgerPort'
import type { GitPort } from '@/modules/code-capability/ports/gitPort'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

/** Everything one round needs that is NOT produced by a stage. */
export interface MrReviewEnvironment {
  /**
   * Persists one row per AI call (`code_ai_attempts`).
   *
   * Optional so the stage maps stay constructible without a database in unit
   * tests, but production always supplies it: without it, a round that was
   * retried three times is indistinguishable from one that succeeded first try,
   * and "why did this cost four model calls" has no answer at all.
   */
  attemptRecorder?: AttemptRecorder
  codeHost: CodeHostPort
  /**
   * Cross-round findings history.
   *
   * Optional for the same reason `attemptRecorder` is — the stage maps stay
   * constructible without a database — but a round without it republishes its
   * whole review on every push, so production always supplies it.
   */
  ledger?: FindingLedgerPort
  git: GitPort
  webhook: WebhookTriggerFields
  codeHostEndpointId: string
  repoPath: string
  worktreePath: string
  /** Injected: this module must not reach the scheduler (AC-10 negative scan). */
  /** See `ReviewStageInput.makeCaller` — the port travels with the prompt. */
  makeCaller: (prompt: string, port: string) => AiCaller
  nonce: string
  budget: RetryBudget
  gate: GateConfig
  /**
   * Durable record of what a publish batch is ABOUT to say, written before the
   * outbound call (§7.2).
   *
   * Optional so stage maps stay constructible without a database. Absent means
   * a crash between publishing and recording is unrecoverable — the next round
   * sees an empty ledger and posts the entire review a second time.
   */
  publishIntents?: PublishIntentWiring
  /** See `PublishSectionWiring` — absent means no work item to claim against. */
  publishSection?: PublishSectionWiring
  /** How the diff is cut into shards; defaults are deliberately conservative. */
  split?: SplitDiffOptions
  /** One attempt recorder per shard, so a shard's retries are attributable. */
  shardRecorderFor?: (shardKey: string) => AttemptRecorder
  shardConcurrency?: number
}

/**
 * What a settled thread is told, on hosts that cannot resolve it.
 *
 * Deliberately says the finding stopped appearing rather than that it was
 * fixed: the review cannot tell the difference between a fix, a rewrite that
 * moved the code, and a deleted file, and claiming credit for a fix that did
 * not happen is worse than saying nothing.
 */
const STALE_NOTE =
  'This finding no longer appears in the latest revision under review, so it is being closed out. If it is still relevant, reply here and it will be picked up again.'

export interface PublishIntentWiring {
  db: DbClient
  roundId: string
  /** The work item's epoch; a batch from an older epoch is ignorable. */
  epoch: number
  /** How this MR is named in the intent rows — stable across rounds. */
  anchorRef: string
}

/**
 * The publish critical section (design §2.2) — the round's claim on writing to
 * this merge request at this epoch.
 *
 * `enterPublishSection` / `leavePublishSection` shipped with the CAS that makes
 * this correct and had NO production callers, so the section was a table in the
 * transition machine and nothing else. What it costs when absent: a round
 * preempted mid-flight still finishes and posts its review, because the cancel
 * lands after the stage has already started publishing — the author gets
 * remarks on a revision they had already replaced, which is the exact outcome
 * §2.2 introduces the section to prevent.
 */
export interface PublishSectionWiring {
  db: DbClient
  workItemId: string
  /** The epoch this round belongs to; a bumped epoch fails the CAS. */
  epoch: number
}

const fail = (error: string): StageResult => ({ status: 'failed', error })
const done = (produced: StageArtifacts): StageResult => ({ status: 'done', produced })

/**
 * Read an artifact a stage declared in `requires`.
 *
 * Throws rather than returning undefined: the contract was validated at author
 * time, so a missing required artifact is an engine or registration bug, and
 * continuing with `undefined` would turn it into a wrong review instead of a
 * loud failure.
 */
function required<T>(artifacts: StageArtifacts, name: string): T {
  const value = artifacts[name]
  if (value === undefined) {
    throw new Error(`stage artifact '${name}' is missing though the contract requires it`)
  }
  return value as T
}

interface MrMeta {
  diffRefs?: GitlabDiffRefs
  title: string | null
}

interface DiffArtifact {
  unifiedDiff: string
  hunks: readonly DiffHunk[]
  omitted: ReadonlyArray<{ path: string; omission: DiffOmission }>
  files: readonly FileDiff[]
}

interface WorktreeArtifact {
  path: string
  /** The commit `prepare-worktree` actually landed on. */
  baselineSha: string
}

interface ShardsArtifact {
  shards: readonly DiffShard[]
  /** The commit every shard tree is created at — what `fetch-diff` measured. */
  baselineSha: string
}

interface ShardFindingsArtifact {
  findings: readonly ReviewFinding[]
  outcomes: readonly ShardOutcome[]
  degraded: boolean
  diffClipped: boolean
}

interface GlobalFindingsArtifact {
  findings: readonly ReviewFinding[]
  degraded: boolean
  reason: string | null
  diffClipped: boolean
}

interface GatedArtifact {
  findings: readonly ReviewFinding[]
  truncated: number
  belowThreshold: number
  diffClipped: boolean
}

interface PlacementsArtifact {
  placed: PlacedFinding[]
  unplaced: UnplacedFinding[]
}

/**
 * What reconcile decided, split the way the later stages consume it.
 *
 * `actions` is kept alongside the split lists because `settle-stale` and
 * `ledger` need the reason for each decision (which generation, which thread),
 * not just the partition.
 */
interface ReconciledArtifact {
  actions: readonly ReconcileAction[]
  /** Only what should actually be posted this round. */
  toPublish: PlacementsArtifact
  /** Present again this round; the thread stays open and is not reposted. */
  keeps: ReadonlyArray<{ fingerprint: string; anchorLine: number | null }>
  /** Generation to record per fingerprint being published. */
  generations: Readonly<Record<string, number>>
}

interface SettledArtifact {
  resolved: number
  noted: number
  skipped: number
  /** Named so a round that could not settle is visible rather than silent. */
  failures: ReadonlyArray<{ fingerprint: string; message: string }>
}

/** The ledger anchor for this round — the MR, never the work item (§6). */
function anchorOf(target: RoundTarget, codeHostEndpointId: string): LedgerAnchor {
  return {
    codeHostEndpointId,
    stableProjectId: target.stableProjectId,
    anchorKind: target.anchorKind,
    anchorId: target.anchorId,
  }
}

/**
 * Read the MR body for the fields publishing needs.
 *
 * GitLab rejects an inline position without `diff_refs`, and the diff endpoint
 * does not return them — so this is a separate read, and its absence is named
 * HERE rather than left to fail once per comment later.
 */
async function readMr(
  codeHost: CodeHostPort,
  target: RoundTarget,
): Promise<{ ok: true; meta: MrMeta } | { ok: false; error: string }> {
  const project = apiProjectAddress(target)
  if (!project.ok) return { ok: false, error: project.message }

  const result = await codeHost.call({
    action: 'mr.get',
    params: { project: project.value, mr: target.anchorId },
  })
  if (!result.ok) return { ok: false, error: `${result.code}: ${result.message}` }

  let body: unknown
  try {
    body = JSON.parse(result.body)
  } catch {
    return { ok: false, error: 'the code host returned a merge request body that is not JSON' }
  }
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const title = typeof record.title === 'string' ? record.title : target.meta.title

  if (target.provider !== 'gitlab') return { ok: true, meta: { title } }

  const refs =
    typeof record.diff_refs === 'object' && record.diff_refs !== null
      ? (record.diff_refs as Record<string, unknown>)
      : null
  const baseSha = typeof refs?.base_sha === 'string' ? refs.base_sha : ''
  const startSha = typeof refs?.start_sha === 'string' ? refs.start_sha : ''
  const headSha = typeof refs?.head_sha === 'string' ? refs.head_sha : ''
  if (baseSha === '' || startSha === '' || headSha === '') {
    return {
      ok: false,
      error: 'the merge request did not report diff_refs (base/start/head sha)',
    }
  }
  return { ok: true, meta: { diffRefs: { baseSha, startSha, headSha }, title } }
}

/**
 * The `program` stage implementations, keyed by contract stage name.
 *
 * Registered into `createCodeCapabilityRunner`'s `programStages`, which is what
 * makes the engine able to run them — an unregistered name fails loudly rather
 * than being skipped (the behaviour this RFC exists to guarantee).
 */
export function mrReviewProgramStages(
  env: MrReviewEnvironment,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  return {
    'resolve-target': async () => {
      const resolved = resolveTarget(env.webhook, env.codeHostEndpointId)
      return resolved.ok ? done({ target: resolved.target }) : fail(resolved.message)
    },

    'prepare-worktree': async (ctx) => {
      const target = required<RoundTarget>(ctx.artifacts, 'target')
      const result = await prepareWorktree({
        git: env.git,
        repoPath: env.repoPath,
        worktreePath: env.worktreePath,
        target,
      })
      if (result.state === 'ready') {
        // The resolved sha travels with the path. `split-diff` needs it to
        // create every shard tree at the SAME commit this round measured — a
        // shard tree at any other commit reviews code the diff never described.
        return done({
          worktree: { path: env.worktreePath, baselineSha: result.sha } satisfies WorktreeArtifact,
        })
      }
      if (result.state === 'stale') {
        // Not an ordinary failure: the round is superseded, and the caller
        // re-arms the work item at the newer sha rather than dropping it. The
        // sha travels in the message because that is what re-arming needs.
        return fail(
          `stale-head: the MR moved to ${result.fetchedSha} before this round could read it`,
        )
      }
      return fail(result.message)
    },

    'fetch-diff': async (ctx) => {
      const target = required<RoundTarget>(ctx.artifacts, 'target')
      const mr = await readMr(env.codeHost, target)
      if (!mr.ok) return fail(mr.error)

      const diff = await fetchDiff({ codeHost: env.codeHost, target })
      if (!diff.ok) return fail(diff.message)

      return done({
        diff: {
          unifiedDiff: diff.unifiedDiff,
          hunks: diff.hunks,
          omitted: diff.omitted,
          // Carried so `split-diff` can group by path. The reassembled
          // unified diff cannot be re-split reliably — a patch body can
          // contain a line that looks like a file header.
          files: diff.files,
        } satisfies DiffArtifact,
        mrMeta: mr.meta,
      })
    },

    'split-diff': async (ctx) => {
      const diff = required<DiffArtifact>(ctx.artifacts, 'diff')
      const worktree = required<WorktreeArtifact>(ctx.artifacts, 'worktree')
      return done({
        shards: {
          shards: splitDiff(diff.files, env.split ?? DEFAULT_SPLIT),
          baselineSha: worktree.baselineSha,
        } satisfies ShardsArtifact,
      })
    },

    'validate-findings': async (ctx) => {
      const shard = required<ShardFindingsArtifact>(ctx.artifacts, 'shardFindings')
      const global = required<GlobalFindingsArtifact>(ctx.artifacts, 'globalFindings')

      // Both passes already went through the envelope schema and the semantic
      // check inside the determinism guard, so this is not re-validation. What
      // it is for is the MERGE: the global pass is told not to repeat a shard's
      // finding, and an instruction is not a guarantee. Two comments saying the
      // same thing in different words cannot be deduped by fingerprint later —
      // different text, different hunk digest — so it has to happen here.
      const seen = new Set<string>()
      const findings: ReviewFinding[] = []
      let duplicates = 0
      for (const finding of [...shard.findings, ...global.findings]) {
        const key = `${finding.file}\u0000${String(finding.line)}\u0000${finding.severity}\u0000${finding.title.trim().toLowerCase()}`
        if (seen.has(key)) {
          duplicates += 1
          continue
        }
        seen.add(key)
        findings.push(finding)
      }

      return {
        status: 'done',
        produced: {
          findings: {
            findings,
            // Either pass having clipped means the review did not see the whole
            // change, and the overview must say so.
            diffClipped: shard.diffClipped || global.diffClipped,
            shardOutcomes: shard.outcomes,
            degraded: shard.degraded || global.degraded,
            ...(global.reason !== null ? { globalReason: global.reason } : {}),
          },
        },
        counts: { findings: findings.length, duplicates },
      }
    },

    gate: async (ctx) => {
      const findings = required<{ findings: readonly ReviewFinding[]; diffClipped: boolean }>(
        ctx.artifacts,
        'findings',
      )
      const result = applyGate<ReviewFinding>(findings.findings, env.gate)
      return done({
        gated: {
          findings: result.published,
          truncated: result.truncated,
          belowThreshold: result.belowThreshold,
          diffClipped: findings.diffClipped,
        } satisfies GatedArtifact,
      })
    },

    'resolve-positions': async (ctx) => {
      const gated = required<GatedArtifact>(ctx.artifacts, 'gated')
      const diff = required<DiffArtifact>(ctx.artifacts, 'diff')

      const placed: PlacedFinding[] = []
      const unplaced: UnplacedFinding[] = []
      for (const finding of gated.findings) {
        const location = { file: finding.file, line: finding.line, side: finding.side }
        const anchor = resolveAnchoredLine(location, diff.hunks)
        // The hunk's TEXT, so the identity survives a rebase that shifts line
        // numbers without touching the code.
        const fingerprint = fingerprintFor(finding, hunkDigestFor(location, diff.hunks))
        const body = renderFindingComment(finding, fingerprint)
        const label = `${finding.file}:${finding.line}`
        if (anchor === null) {
          // AC-3/AC-4: not a validation failure and not a retry — the remark may
          // be perfectly correct, it just cannot be attached.
          unplaced.push({
            body,
            label,
            reason: 'this line is not part of the diff under review',
            fingerprint,
          })
          continue
        }
        placed.push({ body, anchor, label, fingerprint })
      }
      return done({ placements: { placed, unplaced } satisfies PlacementsArtifact })
    },

    reconcile: async (ctx) => {
      const placements = required<PlacementsArtifact>(ctx.artifacts, 'placements')
      const target = required<RoundTarget>(ctx.artifacts, 'target')

      // FIRST: adopt anything a previous round published but never recorded
      // (§7.2). This has to happen before the ledger is read, because adopting
      // writes ledger rows — and a fingerprint the ledger knows about becomes
      // `keep` rather than `publish`, which is exactly what stops the re-post.
      if (env.publishIntents !== undefined && env.ledger !== undefined) {
        const recovered = await recoverPublishIntents({
          db: env.publishIntents.db,
          codeHost: env.codeHost,
          target,
          anchorRef: env.publishIntents.anchorRef,
        })
        const anchor = anchorOf(target, env.codeHostEndpointId)
        for (const [fingerprint, externalId] of Object.entries(recovered.adopted)) {
          await env.ledger.recordPublished({
            anchor,
            fingerprint,
            // Generation 1: an adopted comment is the first time this finding
            // was said on this MR. A dead round cannot have republished
            // anything — it never reached the ledger to learn otherwise.
            generation: 1,
            externalId,
          })
        }
      }

      // Without a ledger there is no history to reconcile against, so every
      // finding is new. Stated rather than assumed: silently treating "no
      // ledger" as "nothing changed" would publish nothing at all.
      const ledger =
        env.ledger === undefined
          ? []
          : await env.ledger.read(anchorOf(target, env.codeHostEndpointId))

      // Both lists take part. A finding that could not be anchored still has an
      // identity, and leaving it out would make it "new" every single round —
      // the overview would repeat it forever.
      const all = [...placements.placed, ...placements.unplaced]
      const current = all.map((item) => ({
        fingerprint: item.fingerprint,
        // The NEW-side line, which is what a reader sees and what drift means.
        // A removed line has none, and null is the honest answer there rather
        // than falling back to the old-side number and reporting a line that
        // moved when nothing did.
        anchorLine: 'anchor' in item ? item.anchor.newLine : null,
      }))

      // T30 — adoption, observed before this round's own writes move anything.
      //
      // Two independent signals (design §6.1): a human resolving the thread, and
      // the anchored code changing. Recorded separately because they disagree in
      // the informative cases — code changed with no resolve is a quiet fix,
      // resolved with no change is a disagreement — and one "adopted" flag would
      // report both as success.
      if (env.ledger !== undefined) {
        const anchor = anchorOf(target, env.codeHostEndpointId)
        const previousAnchors = await env.ledger.readAnchors(anchor)
        for (const fingerprint of detectCodeChanged(current, previousAnchors)) {
          await env.ledger.markAdoption(anchor, fingerprint, 'code-changed')
        }

        const project = apiProjectAddress(target)
        if (project.ok) {
          const listed = await env.codeHost.call({
            action: 'comment.list',
            params: {
              project: project.value,
              mr: target.anchorId,
              per_page: '100',
              comment_scope: 'pulls',
            },
          })
          if (listed.ok) {
            const { resolved } = readResolvedFindings(target.provider, listed.body)
            for (const fingerprint of Object.keys(resolved)) {
              await env.ledger.markAdoption(anchor, fingerprint, 'resolved')
            }
          }
        }
      }

      const { actions } = reconcileFindings(current, ledger)

      const publishable = new Map<string, number>()
      const keeps: Array<{ fingerprint: string; anchorLine: number | null }> = []
      for (const action of actions) {
        if (action.kind === 'publish' || action.kind === 'republish') {
          publishable.set(action.fingerprint, action.generation)
        } else if (action.kind === 'keep') {
          keeps.push({ fingerprint: action.fingerprint, anchorLine: action.anchorLine })
        }
      }

      return done({
        reconciled: {
          actions,
          toPublish: {
            placed: placements.placed.filter((p) => publishable.has(p.fingerprint)),
            unplaced: placements.unplaced.filter((u) => publishable.has(u.fingerprint)),
          },
          keeps,
          generations: Object.fromEntries(publishable),
        } satisfies ReconciledArtifact,
      })
    },

    publish: async (ctx) => {
      const reconciled = required<ReconciledArtifact>(ctx.artifacts, 'reconciled')
      const target = required<RoundTarget>(ctx.artifacts, 'target')
      const meta = required<MrMeta>(ctx.artifacts, 'mrMeta')
      const gated = required<GatedArtifact>(ctx.artifacts, 'gated')
      const diff = required<DiffArtifact>(ctx.artifacts, 'diff')

      const placed = reconciled.toPublish.placed
      const unplaced = reconciled.toPublish.unplaced

      // The overview posts even with nothing new. Silence would leave the author
      // unable to tell a clean round from a review that never ran — and the MR
      // is where this platform is supposed to speak (product boundary). What
      // keeps it honest rather than noisy is `stillOpen`: a round with no new
      // findings but three unresolved threads says so, instead of "no findings"
      // directly above three open ones.
      const prelude = renderOverviewPrelude({
        posted: placed.length,
        carried: unplaced.length,
        truncated: gated.truncated,
        belowThreshold: gated.belowThreshold,
        omitted: diff.omitted,
        diffClipped: gated.diffClipped,
        headSha: target.headSha,
        stillOpen: reconciled.keeps.length,
      })

      // Written BEFORE the call, never after: the whole point is to survive a
      // crash during it. An intent written afterwards records only the batches
      // that already succeeded — precisely the ones that need no recovery.
      // Claim the merge request for THIS epoch before anything leaves the
      // process. A round whose epoch has been bumped — i.e. one that a newer
      // event already preempted — fails the CAS and must not write: its review
      // describes a revision the author has replaced, and posting it is worse
      // than posting nothing, because the remarks look current.
      const section = env.publishSection
      if (section !== undefined) {
        const held = await enterPublishSection(section.db, section.workItemId, section.epoch)
        if (!held) {
          return fail(
            'this round was superseded before it could publish; a newer revision is being reviewed instead',
          )
        }
      }
      const releaseSection = async (): Promise<void> => {
        if (section !== undefined) {
          await leavePublishSection(section.db, section.workItemId, section.epoch)
        }
      }

      const batchId = ulid()
      if (env.publishIntents !== undefined) {
        await writeIntent(env.publishIntents.db, {
          batchId,
          roundId: env.publishIntents.roundId,
          epoch: env.publishIntents.epoch,
          fingerprints: [...placed, ...unplaced].map((f) => f.fingerprint),
          anchorRef: env.publishIntents.anchorRef,
        })
      }

      const result = await publishReview({
        codeHost: env.codeHost,
        target,
        placed,
        unplaced,
        ...(meta.diffRefs !== undefined ? { diffRefs: meta.diffRefs } : {}),
        overviewPrelude: prelude,
      })

      if (result.failure !== null) {
        // Left pending, deliberately. A partial GitLab batch means some
        // comments ARE on the MR, and only a read-back can say which — that is
        // recovery's job next round, not a guess made here.
        //
        // The section IS released: it guards the window in which a write is in
        // flight, and holding it after a failed write would block the next
        // round from ever publishing.
        await releaseSection()
        return fail(`${result.failure.code}: ${result.failure.message}`)
      }

      if (env.publishIntents !== undefined) {
        await settleIntent(
          env.publishIntents.db,
          batchId,
          Object.fromEntries(
            result.publishedFindings
              .filter((f) => f.externalId !== null)
              .map((f) => [f.fingerprint, f.externalId as string]),
          ),
        )
      }
      await releaseSection()
      return done({
        published: {
          posted: result.posted,
          carried: result.carriedInOverview.length,
          overviewPosted: result.overviewPosted,
          findings: result.publishedFindings,
        },
      })
    },

    'settle-stale': async (ctx) => {
      const reconciled = required<ReconciledArtifact>(ctx.artifacts, 'reconciled')
      const target = required<RoundTarget>(ctx.artifacts, 'target')

      const settled: SettledArtifact = { resolved: 0, noted: 0, skipped: 0, failures: [] }
      const failures: Array<{ fingerprint: string; message: string }> = []
      const project = apiProjectAddress(target)

      for (const action of reconciled.actions) {
        if (action.kind !== 'settle-stale') continue

        const step = planSettleStale(target.provider, action, STALE_NOTE)
        if (step.kind === 'skip' || !project.ok) {
          settled.skipped += 1
          continue
        }

        const base = { project: project.value, mr: target.anchorId, thread: step.externalId }
        const result = await env.codeHost.call(
          step.kind === 'resolve-thread'
            ? { action: 'thread.resolve', params: base }
            : { action: 'comment.reply-thread', params: { ...base, body: step.body } },
        )
        if (!result.ok) {
          // NOT a round failure. The finding is gone and the review is already
          // published; refusing the round here would re-run everything above to
          // fix a note on a thread nobody is waiting for. But it is recorded,
          // because a host that rejects every resolve should be visible.
          failures.push({
            fingerprint: action.fingerprint,
            message: `${result.code}: ${result.message}`,
          })
          continue
        }
        if (step.kind === 'resolve-thread') settled.resolved += 1
        else settled.noted += 1
      }

      return done({ settled: { ...settled, failures } satisfies SettledArtifact })
    },

    ledger: async (ctx) => {
      const reconciled = required<ReconciledArtifact>(ctx.artifacts, 'reconciled')
      const target = required<RoundTarget>(ctx.artifacts, 'target')
      const published = required<{
        posted: number
        carried: number
        overviewPosted: boolean
        findings: readonly PublishedFinding[]
      }>(ctx.artifacts, 'published')
      const settled = required<SettledArtifact>(ctx.artifacts, 'settled')

      if (env.ledger === undefined) {
        return {
          status: 'done',
          produced: { ledgerEntry: { recorded: 0, refreshed: 0, closed: 0 } },
          counts: { posted: published.posted, carried: published.carried },
        }
      }

      const anchor = anchorOf(target, env.codeHostEndpointId)
      const externalIds = new Map(published.findings.map((f) => [f.fingerprint, f.externalId]))

      // Only what actually landed. Recording a finding the host rejected would
      // suppress it next round — the ledger would claim it was said, and the
      // author would never see it.
      let recorded = 0
      for (const [fingerprint, generation] of Object.entries(reconciled.generations)) {
        if (!externalIds.has(fingerprint)) continue
        await env.ledger.recordPublished({
          anchor,
          fingerprint,
          generation,
          externalId: externalIds.get(fingerprint) ?? null,
        })
        recorded += 1
      }

      let refreshed = 0
      for (const keep of reconciled.keeps) {
        await env.ledger.refreshSeen(anchor, keep.fingerprint, keep.anchorLine)
        refreshed += 1
      }

      // Last, and only after the provider action above: a crash between the two
      // leaves the row `active`, so the next round retries the action. The
      // reverse order would mark it settled and drop the action forever.
      let closed = 0
      for (const action of reconciled.actions) {
        if (action.kind !== 'settle-stale') continue
        if (await env.ledger.markDisappeared(anchor, action.fingerprint)) closed += 1
      }

      return {
        status: 'done',
        produced: {
          ledgerEntry: { recorded, refreshed, closed, settleFailures: settled.failures.length },
        },
        counts: { posted: published.posted, carried: published.carried },
      }
    },
  }
}

/** The single `ai` stage. Separate map: the engine dispatches by stage kind. */
export function mrReviewAiStages(
  env: MrReviewEnvironment,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  return {
    'review-shard': async (ctx) => {
      const shards = required<ShardsArtifact>(ctx.artifacts, 'shards')
      const meta = required<MrMeta>(ctx.artifacts, 'mrMeta')

      // Nothing reviewable — an MR of only binary files, say. Not a failure:
      // the round proceeds and the overview says what was omitted.
      if (shards.shards.length === 0) {
        return done({
          shardFindings: {
            findings: [],
            outcomes: [],
            degraded: false,
            diffClipped: false,
          } satisfies ShardFindingsArtifact,
        })
      }

      const result = await runReviewShards({
        shards: shards.shards,
        baselineSha: shards.baselineSha,
        repoPath: env.repoPath,
        // Siblings of the round's own tree, never inside it: a shard tree
        // created under the worktree would show up in the round's own diff.
        shardRoot: `${env.worktreePath}-shards`,
        git: env.git,
        makeCaller: env.makeCaller,
        nonce: env.nonce,
        budget: env.budget,
        mrTitle: meta.title,
        ...(env.shardRecorderFor !== undefined ? { recorderFor: env.shardRecorderFor } : {}),
        ...(env.shardConcurrency !== undefined ? { concurrency: env.shardConcurrency } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      })

      // Every shard failed: there is no review at all, so this is a failed
      // stage rather than an empty one. Publishing "no findings" here would
      // tell the author their code is clean when nothing actually read it.
      if (result.outcomes.length > 0 && result.outcomes.every((o) => o.status !== 'done')) {
        const canceled = result.outcomes.some((o) => o.status === 'canceled')
        if (canceled) return fail('the round was canceled')
        return fail(
          `no part of this change could be reviewed: ${result.outcomes[0]?.reason ?? 'unknown'}`,
        )
      }

      return done({
        shardFindings: {
          findings: result.findings,
          outcomes: result.outcomes,
          degraded: result.degraded,
          diffClipped: result.outcomes.some((o) => o.diffClipped),
        } satisfies ShardFindingsArtifact,
      })
    },

    'review-global': async (ctx) => {
      const shardFindings = required<ShardFindingsArtifact>(ctx.artifacts, 'shardFindings')
      const diff = required<DiffArtifact>(ctx.artifacts, 'diff')
      const meta = required<MrMeta>(ctx.artifacts, 'mrMeta')

      const { prompt, diffClipped } = buildGlobalReviewPrompt({
        unifiedDiff: diff.unifiedDiff,
        hunks: diff.hunks,
        omitted: diff.omitted,
        mrTitle: meta.title,
        shardFindingTitles: shardFindings.findings.map((f) => f.title),
        shardDirectories: shardFindings.outcomes.map((o) => o.directory),
      })

      const outcome = await runGuardedAiStage<ReviewEnvelope>({
        caller: env.makeCaller(prompt, REVIEW_PORT),
        schema: ReviewEnvelopeSchema,
        nonce: env.nonce,
        portName: REVIEW_PORT,
        budget: env.budget,
        semanticCheck: checkReviewSemantics,
        ...(env.attemptRecorder !== undefined ? { recorder: env.attemptRecorder } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      })

      if (outcome.status === 'canceled') return fail('the round was canceled')
      if (outcome.status === 'exhausted') {
        // Unlike a shard, this one does not sink the round: the per-shard
        // findings are real and already validated, and withholding them because
        // the cross-file pass misbehaved would lose genuine review over the
        // smaller half of the job. It IS recorded as degraded.
        return done({
          globalFindings: {
            findings: [],
            degraded: true,
            reason: `the cross-file pass did not produce a valid result after ${outcome.totalCalls} attempts`,
            diffClipped,
          } satisfies GlobalFindingsArtifact,
        })
      }

      return done({
        globalFindings: {
          findings: outcome.value.findings,
          degraded: false,
          reason: null,
          diffClipped,
        } satisfies GlobalFindingsArtifact,
      })
    },
  }
}
