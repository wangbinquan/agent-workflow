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

import { buildProtocolBlock } from '@agent-workflow/shared'
import { resolveTarget } from '@/modules/code-capability/domain/resolveTarget'
import { findGateCommand, GATE_DOC_CANDIDATES } from '@/modules/code-capability/domain/targetGate'
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
import { buildScriptStages } from '@/modules/code-capability/composition/scriptStages'
import { lookupStageContract } from '@/modules/code-capability/domain/capabilityRegistry'
import { resolveMonitorScripts } from '@/services/codeCapabilityScripts'
import { join } from 'node:path'
import type { DbClient } from '@/db/client'
import type { CodeHostConnectionsService, FetchLike } from '@/services/codeHost/connections'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

/** Conservative by default, like the review budget. */
export const DEFAULT_CAPABILITY_BUDGET: RetryBudget = { sameSession: 2, freshSession: 1 }

export interface CapabilityWiring {
  programStages: Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>>
  aiStages: Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>>
  /**
   * Present only for a capability whose contract declares script stages, which
   * today is `ci-fix` alone. Absent is not "none needed" for it — an absent map
   * is why every `ci-fix` round used to die at stage zero.
   */
  scriptStages?: Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>>
  codeHostEndpointId: string | null
  /**
   * What a RESUMING round inherits from the one it continues.
   *
   * A round that resumes at `verify-baseline` marks every earlier stage
   * `inherited` — it does not run them, and so does not produce what they
   * produced. `verify-baseline` then asked for `target` and got "stage artifact
   * 'target' is missing though the contract requires it": the confirming round
   * failed at its first live stage, every time, so `/aw apply` could never
   * push. The engine has taken `inheritedArtifacts` since PR-1a and nothing
   * ever passed any.
   *
   * Only artifacts that are pure functions of the trigger context belong here.
   * `target` is exactly that — `resolve-target` reads the frozen webhook and
   * nothing else — so recomputing it is the same value the skipped stage would
   * have produced, not a guess at it. Anything a model or the merge request
   * decided is NOT reconstructible this way and must not be faked; it either
   * lives in the artifact ledger (the frozen change does) or the stage that
   * needs it cannot be skipped.
   */
  inheritedArtifacts: Readonly<Record<string, unknown>>
}

export interface CapabilityWiringInput {
  db: DbClient
  capability: 'mr-comment-fix' | 'requirement' | 'ci-fix'
  webhook: WebhookTriggerFields
  repoPath: string
  worktreePath: string
  nonce: string
  roundId: string
  roundSeq: number
  workItemId: string
  /**
   * The patch generation artifacts are frozen at — the round's epoch. Hardcoded
   * to 1 before, which matched the wait handle only until a supersede bumped
   * one of them.
   */
  generation?: number
  /**
   * Absent means every AI stage refuses by name — see the header.
   *
   * Takes the port as well as the slot: the caller reads the model's reply out
   * of `outputs[port]`, and it used to be handed `mr-review`'s port for every
   * capability. The protocol block asking for that port is composed HERE, from
   * the same argument, so the instruction and the reader cannot drift apart.
   */
  makeCaller?: (prompt: string, slot: string, port: string) => AiCaller
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
  /**
   * The cached-repo id this round runs for — how the framework's SCRIPTS are
   * resolved (`repo_capability_config` → binding → framework).
   *
   * An id, never a path: the same distinction that made every AI stage refuse
   * before plan §2ter.2, and it is silent in exactly the same way here.
   */
  repoId?: string
  /** Where a script stage runs; defaults to the round's worktree. */
  scriptRunDir?: string
  interpreterPath?: string
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
      inheritedArtifacts: {},
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
        inheritedArtifacts: {},
        programStages: refuseAll(programNames, resolved.message),
        aiStages: refuseAll(aiNames, resolved.message),
      }
    }
    endpointId = resolved.id
  }

  /**
   * One place where a stage's port becomes an instruction and a reader.
   *
   * The block is built for THIS port rather than passed in already built: the
   * scheduler used to build one block per round out of `mr-review`'s port and
   * hand it to every capability, which asked `mr-comment-fix`'s agent for
   * `findings` while its stage waited for `fix`. Composing it from the argument
   * the stage supplies makes that impossible to spell.
   */
  /**
   * What a resuming round inherits — see `CapabilityWiring.inheritedArtifacts`.
   *
   * The SAME call `resolve-target` makes, on the same frozen trigger context,
   * so the skipped stage's value is reproduced rather than approximated. A
   * context that cannot resolve a target contributes nothing and the resuming
   * stage fails by name, which is the honest outcome: there is no target to
   * push to.
   */
  const resolvedTarget = resolveTarget(input.webhook, endpointId)
  const inheritedArtifacts: Record<string, unknown> = resolvedTarget.ok
    ? { target: resolvedTarget.target }
    : {}

  const callFor = (prompt: string, slot: string, port: string): AiCaller =>
    (input.makeCaller ?? throwUnwired)(
      `${prompt}\n${buildProtocolBlock([port], undefined, input.nonce)}`,
      slot,
      port,
    )

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
        generation: input.generation ?? 1,
        roundId: input.roundId,
        makeCaller: (prompt, port) => callFor(prompt, 'fixer', port),
        nonce: input.nonce,
        budget: input.budget ?? DEFAULT_CAPABILITY_BUDGET,
        attemptRecorder: recorderFor('apply-change'),
      }
      return {
        codeHostEndpointId: endpointId,
        inheritedArtifacts,
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
        makeCaller: (prompt, slot, port) => callFor(prompt, slot, port),
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
        inheritedArtifacts,
        programStages: requirementProgramStages(env),
        aiStages:
          input.makeCaller === undefined
            ? refuseAll(aiNames, agentRefusal)
            : requirementAiStages(env),
      }
    }

    case 'ci-fix': {
      /**
       * The gate `validate-fix` runs to prove red-before / green-after.
       *
       * The command is DISCOVERED from the repository's own contributor
       * document, exactly as `requirement`'s `run-target-gate` does — the
       * design's reason is that a platform hardcoding `npm test` would be wrong
       * in most repositories and confidently so.
       *
       * This used to call the runner with an empty string, so even once a
       * runner existed the gate could only ever answer "the gate command found
       * in the repository was empty" — a round that made a change and then
       * declared its own fix a failure, three times, before handing off to a
       * human who had been told nothing useful.
       */
      const runGate =
        input.runGateCommand === undefined || input.readWorktreeFile === undefined
          ? async (): Promise<GateRun> => {
              throw new Error('no gate runner is wired for this round')
            }
          : async (): Promise<GateRun> => {
              for (const candidate of GATE_DOC_CANDIDATES) {
                const contents = await input.readWorktreeFile!(candidate)
                if (contents === null) continue
                const found = findGateCommand(candidate, contents)
                if (found !== null) return await input.runGateCommand!(found.command)
              }
              // Not a throw: "this repository does not say how to check itself"
              // is a fact about the repository, and the round reports it on the
              // merge request instead of failing with a stack trace.
              return {
                exitCode: 1,
                output: `no gate command was found — none of ${GATE_DOC_CANDIDATES.join(', ')} says how to check this repository, so the fix cannot be proved`,
              }
            }
      const env: CiFixEnvironment = {
        db: input.db,
        codeHost,
        git,
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        reportTarget: {
          // Spread verbatim into `params` by the MR voice, so it takes the
          // explicit param name rather than the path placeholder's.
          project: input.webhook.project_id ?? '',
          mr: input.webhook.mr_iid ?? '',
        },
        sourceBranch: input.webhook.branch ?? '',
        workItemId: input.workItemId,
        roundId: input.roundId,
        makeCaller: (prompt, _slot, port) => callFor(prompt, 'ci-fixer', port),
        nonce: input.nonce,
        budget: input.budget ?? DEFAULT_CAPABILITY_BUDGET,
        attemptRecorder: recorderFor('fix'),
        runGate,
        readWorktreeDiff: async () => {
          const diff = await git.readWorktreeDiff({ worktreePath: input.worktreePath })
          return diff.ok ? diff.diff : ''
        },
      }
      // The four script stages that open a `ci-fix` round. Resolved from the
      // framework rather than defaulted: these are the deterministic half of
      // the capability (what failed, how it is classified, what to do, who
      // does it), and a default would silently make one team's policy stand in
      // for another's.
      const contract = lookupStageContract('ci-fix')
      const resolvedScripts =
        input.repoId === undefined || input.repoId === ''
          ? {
              ok: false as const,
              problem: 'this round has no repository, so no framework scripts could be resolved',
            }
          : await resolveMonitorScripts(input.db, { repoId: input.repoId, capability: 'ci-fix' })

      const scriptNames = (contract?.stages ?? [])
        .filter((stage) => stage.kind === 'script')
        .map((stage) => stage.name)

      const scriptStages = !resolvedScripts.ok
        ? refuseAll(
            scriptNames,
            `the framework's scripts could not be resolved: ${resolvedScripts.problem}`,
          )
        : contract === undefined
          ? refuseAll(scriptNames, 'no stage contract is registered for ci-fix')
          : buildScriptStages(contract, {
              scripts: resolvedScripts.scripts,
              makeEnv: (stageName) => ({
                worktreePath: input.worktreePath,
                runDir: input.scriptRunDir ?? join(input.worktreePath, '.aw-run', stageName),
                repos: [],
                interpreterPath: input.interpreterPath ?? '',
                workItem: {
                  capability: 'ci-fix',
                  anchorKind: 'mr',
                  anchorId: input.webhook.mr_iid ?? '',
                  roundId: input.roundId,
                  roundSeq: input.roundSeq,
                  baselineSha: input.webhook.commit_sha ?? null,
                },
                envelopeNonce: input.nonce,
              }),
            })

      return {
        codeHostEndpointId: endpointId,
        inheritedArtifacts,
        programStages: ciFixProgramStages(env),
        scriptStages,
        aiStages:
          input.makeCaller === undefined ? refuseAll(aiNames, agentRefusal) : ciFixAiStages(env),
      }
    }
  }
}

/** Reached only if an AI stage runs without a caller; the refusal replaces it. */
const throwUnwired: (prompt: string, slot: string, port: string) => AiCaller = () => () => {
  throw new Error('no agent caller is wired for this capability')
}
