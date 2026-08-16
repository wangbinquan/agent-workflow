// RFC-304 — the join between the scheduler and the OTHER three capabilities.
//
// `mrReviewEnvironment.ts` did this for `mr-review`. The audit (plan §2bis)
// found the scheduler referenced that one builder and nothing else, so
// `mr-comment-fix`, `requirement` and `ci-fix` had complete, unit-tested stage
// compositions that production could never reach: a round for any of them got a
// runner with no stages and died at stage one with "has no runner registered
// yet".
//
// That gap was invisible for the usual reason — each half is green on its own,
// and an absent join raises no error. It got LOUDER rather than fixed when PR-9
// opened the `WorkPackage` union arms: the monitor began genuinely dispatching
// `ci-fix`, so a round would start, take the merge-request lease, and fail every
// stage. Opening the union was right; this file is the other half of it.
//
// ## Why the refusals are spelled out rather than left unregistered
//
// Same reasoning as the review builder. A stage with no implementation fails
// with "no runner registered", which tells an operator nothing about what to
// configure. A stage that refuses BY NAME — naming the slot, the repository,
// the missing endpoint — puts the resolution failure where somebody reads it.

import type { AiCaller, RetryBudget } from '@/modules/code-capability/application/determinismGuard'
import type {
  StageResult,
  StageRunContext,
} from '@/modules/code-capability/application/stageEngine'
import {
  ciFixAiStages,
  ciFixProgramStages,
  type CiFixEnvironment,
  type GateRun,
} from '@/modules/code-capability/composition/ciFixStages'
import {
  mrCommentFixAiStages,
  mrCommentFixProgramStages,
  type MrCommentFixEnvironment,
} from '@/modules/code-capability/composition/mrCommentFixStages'
import {
  requirementAiStages,
  requirementProgramStages,
  type RequirementEnvironment,
} from '@/modules/code-capability/composition/requirementStages'
import { createCodeHostAdapter } from '@/modules/code-capability/infrastructure/codeHostAdapter'
import { createGitAdapter } from '@/modules/code-capability/infrastructure/gitAdapter'
import { createSqliteAttemptRecorder } from '@/modules/code-capability/infrastructure/sqliteAttemptRecorder'
import { resolveCodeHostEndpointId } from '@/modules/code-capability/composition/mrReviewEnvironment'
import type { DbClient } from '@/db/client'
import type { CodeHostConnectionsService, FetchLike } from '@/services/codeHost/connections'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

/** Conservative by default, like the review budget. */
export const DEFAULT_CAPABILITY_BUDGET: RetryBudget = { sameSession: 2, freshSession: 1 }

export interface CapabilityWiring {
  programStages: Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>>
  aiStages: Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>>
  codeHostEndpointId: string | null
}

export interface CapabilityWiringInput {
  db: DbClient
  capability: 'mr-comment-fix' | 'requirement' | 'ci-fix'
  webhook: WebhookTriggerFields
  repoPath: string
  worktreePath: string
  protocolBlock: string
  nonce: string
  roundId: string
  roundSeq: number
  workItemId: string
  /** Absent means every AI stage refuses by name — see the header. */
  makeCaller?: (prompt: string, slot: string) => AiCaller
  /** Why no agent could be resolved, when that is the reason `makeCaller` is absent. */
  unresolvedAgentReason?: string
  budget?: RetryBudget
  codeHostEndpointId?: string
  codeHostConnections?: CodeHostConnectionsService | null
  codeHostFetch?: FetchLike
  /** Reads a file out of the worktree — `requirement` needs it for the gate doc. */
  readWorktreeFile?: (relativePath: string) => Promise<string | null>
  /** Runs the target repository's own gate; `requirement` and `ci-fix` use it. */
  runGateCommand?: (command: string) => Promise<{ exitCode: number; output: string }>
}

/** Stage names per capability, so a refusal can name every one of them. */
const PROGRAM_STAGES: Readonly<Record<CapabilityWiringInput['capability'], readonly string[]>> = {
  'mr-comment-fix': [
    'resolve-target',
    'collect-thread',
    'prepare-worktree',
    'decide-form',
    'validate-change',
    'post-suggestion',
    'post-patch',
    'verify-baseline',
    'push',
    'ledger',
  ],
  requirement: [
    'resolve-input',
    'materialize-attachments',
    'prepare-worktree',
    'clarify',
    'run-target-gate',
    'open-mr',
    'ledger',
  ],
  'ci-fix': ['prepare-worktree', 'validate-fix', 'anti-cheat-check', 'push', 'ledger'],
}

const AI_STAGES: Readonly<Record<CapabilityWiringInput['capability'], readonly string[]>> = {
  'mr-comment-fix': ['apply-change'],
  requirement: ['comprehend', 'implement'],
  'ci-fix': ['fix'],
}

function refuseAll(
  names: readonly string[],
  reason: string,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      async (): Promise<StageResult> => ({ status: 'failed', error: reason }),
    ]),
  )
}

/**
 * Assemble one round's stages for a capability other than `mr-review`.
 *
 * Returns REFUSING stages rather than throwing when the environment cannot be
 * built: a round that fails with "this platform does not drive provider X" is
 * diagnosable, and one that throws out of composition is a stack trace in a log
 * nobody is reading.
 */
export async function buildCapabilityWiring(
  input: CapabilityWiringInput,
): Promise<CapabilityWiring> {
  const provider = input.webhook.provider
  const programNames = PROGRAM_STAGES[input.capability]
  const aiNames = AI_STAGES[input.capability]

  if (provider !== 'gitlab' && provider !== 'github') {
    const message = `the trigger context names provider '${String(provider)}', which this platform does not drive`
    return {
      codeHostEndpointId: null,
      programStages: refuseAll(programNames, message),
      aiStages: refuseAll(aiNames, message),
    }
  }

  let endpointId = input.codeHostEndpointId
  if (endpointId === undefined) {
    const resolved = await resolveCodeHostEndpointId(input.db, provider)
    if (!resolved.ok) {
      return {
        codeHostEndpointId: null,
        programStages: refuseAll(programNames, resolved.message),
        aiStages: refuseAll(aiNames, resolved.message),
      }
    }
    endpointId = resolved.id
  }

  const codeHost = createCodeHostAdapter({
    db: input.db,
    provider,
    ...(input.codeHostConnections !== undefined ? { connections: input.codeHostConnections } : {}),
    ...(input.codeHostFetch !== undefined ? { fetchImpl: input.codeHostFetch } : {}),
  })
  const git = createGitAdapter()

  // Absent `makeCaller` means no agent is bound to this capability's slot. The
  // program stages still run for real — worktree, diff, gate, push are all
  // exercised — and only the AI stages refuse, naming what to configure.
  const agentRefusal =
    input.unresolvedAgentReason ??
    `no agent is bound to this capability's agent slot for this repository, so its AI stages have nothing to run — bind one in the capability configuration`

  const recorderFor = (stageName: string) =>
    createSqliteAttemptRecorder(input.db, { roundId: input.roundId, stageName, shardKey: '' })

  switch (input.capability) {
    case 'mr-comment-fix': {
      const env: MrCommentFixEnvironment = {
        db: input.db,
        codeHost,
        git,
        webhook: input.webhook,
        codeHostEndpointId: endpointId,
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        // The thread this round answers travels on the trigger context; without
        // one there is nothing to reply to, and `collect-thread` says so rather
        // than guessing a thread.
        threadId: input.webhook.comment_thread_id ?? '',
        workItemId: input.workItemId,
        generation: 1,
        roundId: input.roundId,
        makeCaller: (prompt) => (input.makeCaller ?? throwUnwired)(prompt, 'fixer'),
        protocolBlock: input.protocolBlock,
        nonce: input.nonce,
        budget: input.budget ?? DEFAULT_CAPABILITY_BUDGET,
        attemptRecorder: recorderFor('apply-change'),
      }
      return {
        codeHostEndpointId: endpointId,
        programStages: mrCommentFixProgramStages(env),
        aiStages:
          input.makeCaller === undefined
            ? refuseAll(aiNames, agentRefusal)
            : mrCommentFixAiStages(env),
      }
    }

    case 'requirement': {
      const env: RequirementEnvironment = {
        db: input.db,
        codeHost,
        git,
        codeHostEndpointId: endpointId,
        provider,
        projectRef: input.webhook.project_id ?? '',
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        targetBranch: input.webhook.default_branch ?? input.webhook.branch ?? 'main',
        // Null means the requirement arrived as a reference rather than as
        // content; `resolve-input` refuses rather than fetching, because
        // fetching "issue 88" needs to know which system and whose credentials.
        input: null,
        // An issue-labelled requirement can be answered where it was asked
        // (design D2) only when the framework supplies a write-back handle.
        // Both flags default FALSE: `routeClarify` then refuses to start rather
        // than asking into a channel nobody is watching, which is the failure
        // that rule exists to prevent.
        origin: { kind: 'issue', hasWritebackHandle: false, frameworkSupportsWriteback: false },
        workItemId: input.workItemId,
        roundId: input.roundId,
        roundSeq: input.roundSeq,
        makeCaller: (prompt, slot) => (input.makeCaller ?? throwUnwired)(prompt, slot),
        protocolBlock: input.protocolBlock,
        nonce: input.nonce,
        budget: input.budget ?? DEFAULT_CAPABILITY_BUDGET,
        attemptRecorder: recorderFor('comprehend'),
        readWorktreeFile: input.readWorktreeFile ?? (async () => null),
        runGateCommand:
          input.runGateCommand ??
          (async () => {
            // Not "assume it passed": `describeGateOutcome` reports
            // `unrunnable` distinctly from `passed`, and claiming a gate ran
            // when nothing did is the one outcome that misleads a reviewer.
            throw new Error('no gate runner is wired for this round')
          }),
      }
      return {
        codeHostEndpointId: endpointId,
        programStages: requirementProgramStages(env),
        aiStages:
          input.makeCaller === undefined
            ? refuseAll(aiNames, agentRefusal)
            : requirementAiStages(env),
      }
    }

    case 'ci-fix': {
      const runGate =
        input.runGateCommand === undefined
          ? async (): Promise<GateRun> => {
              throw new Error('no gate runner is wired for this round')
            }
          : async (): Promise<GateRun> => await input.runGateCommand!('')
      const env: CiFixEnvironment = {
        db: input.db,
        codeHost,
        git,
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        reportTarget: {
          __project__: input.webhook.project_id ?? '',
          mr: input.webhook.mr_iid ?? '',
        },
        sourceBranch: input.webhook.branch ?? '',
        workItemId: input.workItemId,
        roundId: input.roundId,
        makeCaller: (prompt) => (input.makeCaller ?? throwUnwired)(prompt, 'ci-fixer'),
        protocolBlock: input.protocolBlock,
        nonce: input.nonce,
        budget: input.budget ?? DEFAULT_CAPABILITY_BUDGET,
        attemptRecorder: recorderFor('fix'),
        runGate,
        readWorktreeDiff: async () => {
          const diff = await git.readWorktreeDiff({ worktreePath: input.worktreePath })
          return diff.ok ? diff.diff : ''
        },
      }
      return {
        codeHostEndpointId: endpointId,
        programStages: ciFixProgramStages(env),
        aiStages:
          input.makeCaller === undefined ? refuseAll(aiNames, agentRefusal) : ciFixAiStages(env),
      }
    }
  }
}

/** Reached only if an AI stage runs without a caller; the refusal replaces it. */
const throwUnwired: (prompt: string, slot: string) => AiCaller = () => () => {
  throw new Error('no agent caller is wired for this capability')
}
