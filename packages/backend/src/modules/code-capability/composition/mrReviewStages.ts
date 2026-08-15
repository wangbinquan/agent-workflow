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

import { fetchDiff } from '@/modules/code-capability/application/fetchDiff'
import { prepareWorktree } from '@/modules/code-capability/application/prepareWorktree'
import {
  publishReview,
  type PlacedFinding,
  type UnplacedFinding,
} from '@/modules/code-capability/application/publishReview'
import { runReviewStage } from '@/modules/code-capability/application/reviewStage'
import type {
  StageArtifacts,
  StageResult,
  StageRunContext,
} from '@/modules/code-capability/application/stageEngine'
import type { AiCaller, RetryBudget } from '@/modules/code-capability/application/determinismGuard'
import { hunkDigestFor, resolveAnchoredLine } from '@/modules/code-capability/domain/anchorLine'
import type { DiffHunk } from '@/modules/code-capability/domain/anchorResolve'
import { applyGate, type GateConfig } from '@/modules/code-capability/domain/findingGate'
import type { DiffOmission } from '@/modules/code-capability/domain/mrDiffNormalize'
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
import type { ReviewFinding } from '@/modules/code-capability/domain/reviewEnvelope'
import type { GitlabDiffRefs } from '@/modules/code-capability/domain/reviewPosition'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '@/modules/code-capability/ports/gitPort'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

/** Everything one round needs that is NOT produced by a stage. */
export interface MrReviewEnvironment {
  codeHost: CodeHostPort
  git: GitPort
  webhook: WebhookTriggerFields
  codeHostEndpointId: string
  repoPath: string
  worktreePath: string
  /** Injected: this module must not reach the scheduler (AC-10 negative scan). */
  makeCaller: (prompt: string) => AiCaller
  protocolBlock: string
  nonce: string
  budget: RetryBudget
  gate: GateConfig
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
      if (result.state === 'ready') return done({ worktree: env.worktreePath })
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
        } satisfies DiffArtifact,
        mrMeta: mr.meta,
      })
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
        const body = renderFindingComment(
          finding,
          fingerprintFor(finding, hunkDigestFor(location, diff.hunks)),
        )
        const label = `${finding.file}:${finding.line}`
        if (anchor === null) {
          // AC-3/AC-4: not a validation failure and not a retry — the remark may
          // be perfectly correct, it just cannot be attached.
          unplaced.push({ body, label, reason: 'this line is not part of the diff under review' })
          continue
        }
        placed.push({ body, anchor, label })
      }
      return done({ placements: { placed, unplaced } satisfies PlacementsArtifact })
    },

    publish: async (ctx) => {
      const placements = required<PlacementsArtifact>(ctx.artifacts, 'placements')
      const target = required<RoundTarget>(ctx.artifacts, 'target')
      const meta = required<MrMeta>(ctx.artifacts, 'mrMeta')
      const gated = required<GatedArtifact>(ctx.artifacts, 'gated')
      const diff = required<DiffArtifact>(ctx.artifacts, 'diff')

      const prelude = renderOverviewPrelude({
        posted: placements.placed.length,
        carried: placements.unplaced.length,
        truncated: gated.truncated,
        belowThreshold: gated.belowThreshold,
        omitted: diff.omitted,
        diffClipped: gated.diffClipped,
        headSha: target.headSha,
      })

      const result = await publishReview({
        codeHost: env.codeHost,
        target,
        placed: placements.placed,
        unplaced: placements.unplaced,
        ...(meta.diffRefs !== undefined ? { diffRefs: meta.diffRefs } : {}),
        overviewPrelude: prelude,
      })

      if (result.failure !== null) {
        return fail(`${result.failure.code}: ${result.failure.message}`)
      }
      return done({
        published: {
          posted: result.posted,
          carried: result.carriedInOverview.length,
          overviewPosted: result.overviewPosted,
        },
      })
    },

    ledger: async (ctx) => {
      // PR-4a writes the round's outcome only. The cross-round findings ledger
      // — three-set reconcile and the active/disappeared/reappeared lifecycle —
      // is PR-4b (T27/T27b); recording a partial ledger here would look like
      // dedup working while it silently did nothing.
      const published = required<{ posted: number; carried: number }>(ctx.artifacts, 'published')
      return { status: 'done', produced: { ledgerEntry: published }, counts: published }
    },
  }
}

/** The single `ai` stage. Separate map: the engine dispatches by stage kind. */
export function mrReviewAiStages(
  env: MrReviewEnvironment,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  return {
    review: async (ctx) => {
      const diff = required<DiffArtifact>(ctx.artifacts, 'diff')
      const meta = required<MrMeta>(ctx.artifacts, 'mrMeta')

      const result = await runReviewStage({
        makeCaller: env.makeCaller,
        nonce: env.nonce,
        budget: env.budget,
        unifiedDiff: diff.unifiedDiff,
        hunks: diff.hunks,
        omitted: diff.omitted,
        mrTitle: meta.title,
        protocolBlock: env.protocolBlock,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      })

      if (result.outcome.status === 'canceled') return fail('the round was canceled')
      if (result.outcome.status === 'exhausted') {
        // Constitution R5: nothing unvalidated escapes, so there is no partial
        // value to hand downstream — the stage fails and the round publishes
        // nothing rather than a best-effort review.
        return fail(
          `the reviewer did not produce a valid result after ${result.outcome.totalCalls} attempts`,
        )
      }
      return done({
        findings: {
          findings: result.outcome.value.findings,
          diffClipped: result.diffClipped,
        },
      })
    },
  }
}
