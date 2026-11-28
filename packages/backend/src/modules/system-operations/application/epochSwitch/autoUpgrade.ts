import type { JsonObject } from '@/platform/contracts/json'
import { errorCode, errorText } from '@/platform/persistence/migration/errorText'
import { epochArtifactPath } from '@/platform/persistence/migration/run/paths'
import { persistenceDialect } from '@/platform/persistence/nativeDialect'
import type { EpochSwitchApplication } from '../../public/commands'
import type { EpochSwitchPlanInput, EpochSwitchStatusView } from '../../public/types'
import type {
  AutoUpgradeEnvironmentPort,
  AutoUpgradeRecordPort,
  LegacyMigrationFinalizePort,
  EpochTargetProvisioningPort,
  SessionLockPort,
  SourcePrecheck,
} from '../ports/epochSwitch'
import { classifyEpochInstallation } from '../../domain/epochSwitch/classification'
import {
  autoUpgradePlanRecords,
  autoUpgradeTrigger,
  autoUpgradeRollbackCommitment,
  classifyAutoUpgradeRun,
  evaluateAutoUpgradePlan,
  AUTO_UPGRADE_REAPPROVAL_LIMIT,
  AUTO_UPGRADE_RETRY_GUIDANCE,
  type AutoUpgradeConclusion,
  type AutoUpgradeSession,
} from '../../domain/epochSwitch/autoUpgrade'
import { estimateDirectUpgradeCapacity } from '../../domain/epochSwitch/capacity'
import {
  PlanResolutionsSchema,
  parseMigrationPlanDocument,
  type MigrationPlanDocument,
} from '../../domain/epochSwitch/documents'
import {
  capacityRefusal,
  environmentRefusalConclusion,
  sourceOutOfSpace,
  sourceOutOfSpaceRefusal,
  sourceRefusal,
  type EnvironmentRefusal,
} from '../../domain/epochSwitch/environmentPrecheck'
import { resolutionReportLines } from '../../domain/epochSwitch/planDocument'
import { epochRunIdentity, phaseIndex } from '../../domain/epochSwitch/transitions'
import type { EpochSwitchJournal } from '../../domain/epochSwitch/model'
import {
  directRunMismatch,
  readPinnedPlan,
  readPlanPin,
  type EpochSwitchDependencies,
} from './session'

export interface AutoUpgradeDependencies {
  readonly epoch: EpochSwitchDependencies
  readonly application: EpochSwitchApplication
  readonly records: AutoUpgradeRecordPort
  readonly lock: SessionLockPort
  readonly legacy: LegacyMigrationFinalizePort
  readonly provisioning?: EpochTargetProvisioningPort
  /** RFC-626 §3.5: read-only measurements for the check that precedes a new session. */
  readonly environment?: AutoUpgradeEnvironmentPort
  /**
   * RFC-626 §3.5: the refusal of the home `config.json` as the conversion would judge it, null
   * when the file passes. The first check before a new session, and only there: an
   * installation that is already upgraded, or a session that resumes, is not refused for it
   * (implementation gate G4-5).
   */
  readonly homeConfigRefusal?: EnvironmentRefusal | null
  readonly enabled: boolean
  readonly standalone: boolean
  readonly log?: (line: string, warning?: boolean) => void
}

/** Every other kind of decision is logged up to this many entries; ended tasks are all named. */
const LOGGED_DECISIONS = 50
/**
 * A run that answers the approval it was just given by asking for the same approval again is
 * not progressing. Within one process it may do so this often before the session refuses.
 */
const SAME_APPROVAL_REQUESTS = 3

type PlanDecision =
  | { readonly kind: 'approve'; readonly digest: string }
  | {
      readonly kind: 'refuse'
      readonly reason: 'approval-retry-limit' | 'plan-blocked'
      readonly detail: unknown
      readonly guidance: readonly string[]
    }

/** RFC-398 §2.4 A–H. All phase authority comes from the existing epoch-switch journal. */
export async function autoUpgrade(
  deps: AutoUpgradeDependencies,
  input: { retry?: boolean } = {},
): Promise<AutoUpgradeConclusion> {
  const { epoch, application: app, records, lock } = deps
  let operationId: string | null = null
  const checkpoint = async (name: string) => {
    await epoch.autoUpgradeCheckpoint?.(name)
  }
  const conclusion = (
    outcome: AutoUpgradeConclusion['outcome'],
    guidance: readonly string[],
    extra: { readonly receipt?: JsonObject; readonly code?: string | null } = {},
  ): AutoUpgradeConclusion => ({
    mode: 'auto',
    outcome,
    exitCode: outcome === 'done' || outcome === 'noop' ? 0 : outcome === 'error' ? 1 : 3,
    operationId,
    guidance,
    ...(extra.receipt ? { receipt: extra.receipt } : {}),
    ...(extra.code ? { code: extra.code } : {}),
    // RFC-626 §3.6: where to look when the upgrade did not finish.
    ...(operationId !== null && outcome !== 'done' && outcome !== 'noop'
      ? { artifactRoot: epoch.journal.operationRoot(operationId) }
      : {}),
  })
  /** RFC-626 §3.6: the reason in words, with the code, the operation and its directory. */
  const failed = (value: unknown, hint: string): AutoUpgradeConclusion => {
    const failure = describeFailure(value)
    const where = [
      ...(failure.code ? [`error code ${failure.code}`] : []),
      ...(operationId !== null
        ? [`operation ${operationId}`, `artifacts in ${epoch.journal.operationRoot(operationId)}`]
        : []),
    ]
    return conclusion(
      'error',
      [
        `Automatic database upgrade failed: ${failure.text}`,
        ...(where.length ? [where.join('; ')] : []),
        hint,
      ],
      { code: failure.code },
    )
  }
  const append = (
    kind: Parameters<AutoUpgradeRecordPort['append']>[1],
    data: Readonly<Record<string, unknown>>,
  ) => records.append(operationId!, kind, data)
  const session = async (): Promise<AutoUpgradeSession> =>
    (await records.list()).find((s) => s.operationId === operationId)!
  const refuse = async (reason: string, detail: unknown, guidance: readonly string[]) => {
    await append('refused', { reason, detail, guidance })
    await checkpoint('refused')
    return conclusion('refused', guidance, { code: reason })
  }
  const rollback = async (reason: string, detail: unknown) => {
    if (!(await session()).verificationFailed) await append('verify-failed', { reason, detail })
    await checkpoint('verify-failed')
    await lock.assertHeld()
    await app.rollback({ operationId: operationId! })
    if (!(await session()).records.some((r) => r.kind === 'rolled-back'))
      await append('rolled-back', { reason: 'verification-failed' })
    await append('failed', { reason: 'verification-failed', guidance: AUTO_UPGRADE_RETRY_GUIDANCE })
    return conclusion('failed', [AUTO_UPGRADE_RETRY_GUIDANCE, JSON.stringify(detail)], {
      code: 'verification-failed',
    })
  }
  /**
   * RFC-626 §4.2: the session's decision about one plan of one run, recorded once per approval
   * digest. Used by the loop and by the callback that approves the plan of the actual result
   * inside the run; a refusal is recorded by the loop, which is where the session ends.
   */
  const decide = async (
    plan: MigrationPlanDocument,
    runId: string,
    reapproval: boolean,
  ): Promise<PlanDecision> => {
    const recorded = autoUpgradePlanRecords(await session(), runId, plan.approvalDigest)
    if (reapproval && !recorded.evaluated && recorded.reapprovals >= AUTO_UPGRADE_REAPPROVAL_LIMIT)
      return {
        kind: 'refuse',
        reason: 'approval-retry-limit',
        detail: { runId },
        guidance: [
          `Review agent-workflow db migration status ${operationId}; this run requested approval more than three times.`,
        ],
      }
    const evaluation = evaluateAutoUpgradePlan(plan)
    if (!recorded.evaluated)
      await append('plan-evaluated', {
        runId,
        planDigest: plan.digest,
        approvalDigest: plan.approvalDigest,
        blocks: plan.payload.blocks.length,
        restrictions: evaluation.restrictions,
        reapproval,
      })
    if (evaluation.kind === 'refuse')
      return {
        kind: 'refuse',
        reason: 'plan-blocked',
        detail: evaluation.reasons,
        guidance: epoch.direct
          ? [
              // A direct run's plan blocks only on its environment: data is never a reason.
              ...evaluation.reasons.map(
                (reason) => `${reason.block.code}: ${reason.remediation.message}`,
              ),
              ...evaluation.reasons.map((reason) => JSON.stringify(reason)),
              `Correct the reported condition, then start again; the upgrade checks it again. Details: agent-workflow db migration status ${operationId}.`,
            ]
          : [
              ...evaluation.reasons.map((reason) => JSON.stringify(reason)),
              `Review agent-workflow db migration status ${operationId}; explicitly acknowledge eligible items with db migration acknowledge ${operationId} --item ID --reason TEXT, then start again.`,
            ],
      }
    if (!recorded.approved) await append('approved', { runId, approvalDigest: evaluation.digest })
    return { kind: 'approve', digest: evaluation.digest }
  }
  const previousApproval = epoch.approveActualPlan
  await lock.acquire()
  try {
    // A. Lock precedes inspection; intent precedes finalize, allocation and discovery.
    const sessions = await records.list()
    const installation = await epoch.installation()
    const facts = { ...installation.facts, autoUpgradeSessions: sessions }
    const trigger = autoUpgradeTrigger({
      facts,
      installation: classifyEpochInstallation(facts),
      standalone: deps.standalone,
      enabled: deps.enabled,
      retry: input.retry,
    })
    if (trigger.kind === 'noop') return conclusion('noop', [trigger.reason])
    if (trigger.kind === 'refuse') {
      operationId = trigger.operationId ?? null
      return conclusion('refused', [trigger.guidance ?? trigger.reason], { code: trigger.reason })
    }
    // C below finishes an RFC-349 provider move that reached its last phase; one that did not
    // is a reason not to begin.
    const legacyId =
      facts.rfc349Operation ??
      (facts.pointer?.payload.version === 1 ? facts.pointer.payload.operationId : null)
    const legacyUnfinished = (status: Awaited<ReturnType<LegacyMigrationFinalizePort['status']>>) =>
      !['accepting-writes', 'finalized'].includes(status.phase) || status.rolledBackAt !== null
    const legacyGuidance = (id: string) => [
      `Use the old binary: db migration status ${id}; db migration resume ${id} or db migration cancel ${id}`,
    ]
    let legacyStatus: Awaited<ReturnType<LegacyMigrationFinalizePort['status']>> | null = null
    let candidate: string | null = null
    if (trigger.kind === 'start') {
      // A'. RFC-626 §3.5: the environment, judged by reading only and before the intent is
      // recorded. A refusal here leaves no session record, no operation directory, no
      // allocation file and no new database; the operation id is only a name so far. A
      // session that already exists is not judged again: its copies are on the disk the
      // estimate would count as missing.
      candidate = epoch.newOperationId?.() ?? `dbm_e2_${crypto.randomUUID().replaceAll('-', '')}`
      const root = epoch.journal.operationRoot(candidate)
      const refused = async (refusal: EnvironmentRefusal) => {
        await checkpoint('environment-refused')
        return environmentRefusalConclusion(refusal)
      }
      if (deps.homeConfigRefusal) return await refused(deps.homeConfigRefusal)
      let liveBytes: number | null = null
      if (epoch.source.precheck) {
        let source: SourcePrecheck
        try {
          source = await epoch.source.precheck({
            location: installation.source,
            emptyTables: [],
            operationRoot: epochArtifactPath(
              root,
              `runs/${epochRunIdentity(candidate, 0).runId}/source`,
            ),
            scratchOwner: candidate,
            resolution: 'automatic',
          })
        } catch (error) {
          // Opening the old database is the check; why it failed is the answer.
          const code = errorCode(error)
          source = {
            ok: false,
            reason: 'unreadable',
            message: errorText(error),
            detail: code === null ? {} : { code },
          }
        }
        if (!source.ok) {
          // A disk without free space fails the opening first: report the lack of space.
          if (sourceOutOfSpace(source))
            return await refused(
              sourceOutOfSpaceRefusal({
                error:
                  typeof source.detail.error === 'string' ? source.detail.error : source.message,
                availableBytes: (await deps.environment?.availableBytes(root)) ?? null,
                directory: root,
              }),
            )
          return await refused(sourceRefusal(source))
        }
        liveBytes = source.liveBytes
      }
      const availableBytes = (await deps.environment?.availableBytes(root)) ?? null
      if (deps.environment && liveBytes !== null && availableBytes !== null) {
        const refusal = capacityRefusal({
          capacity: estimateDirectUpgradeCapacity({
            liveBytes,
            contentFiles: await deps.environment.contentFiles(epoch.defaultContentRoot),
            targetOnOperationFilesystem:
              persistenceDialect(facts.provider).targetLocationKind === 'sqlite-file',
            artifactHardLinks: (await deps.environment.artifactHardLinks?.(root)) ?? true,
          }),
          availableBytes,
          directory: root,
        })
        if (refusal) return await refused(refusal)
      }
      if (
        persistenceDialect(facts.provider).requiresScratchProfile &&
        deps.provisioning?.precheck
      ) {
        const databases = await deps.provisioning.precheck()
        if (!databases.ok)
          return await refused({
            reason: databases.code,
            guidance: [
              databases.message,
              'Prepare the reported empty databases, then run agent-workflow migrate again.',
            ],
          })
      }
      if (legacyId) {
        legacyStatus = await deps.legacy.status(legacyId)
        if (legacyUnfinished(legacyStatus))
          return await refused({
            reason: 'rfc349-operation-unfinished',
            guidance: legacyGuidance(legacyId),
          })
      }
    }
    operationId = trigger.kind === 'resume' ? trigger.operationId! : candidate!
    await lock.bind(operationId)
    if (trigger.kind === 'start')
      await append('intent', {
        candidateBuild: epoch.candidateBuild,
        provider: facts.provider,
        trigger: trigger.reason,
        sessionSequence: (sessions.at(-1)?.sessionSequence ?? 0) + 1,
      })
    await checkpoint('intent')
    let journal = await epoch.journal.read(operationId)
    // B. Published negative evidence commits rollback even if the journal reference was never written.
    const commitment = autoUpgradeRollbackCommitment({
      session: await session(),
      runId: journal?.payload.run?.runId ?? null,
      failure: journal?.payload.failure ?? null,
      artifacts: journal?.payload.run
        ? await records.acceptance(operationId, journal.payload.run.runId)
        : [],
    })
    if (commitment)
      return await rollback(
        commitment,
        journal?.payload.failure ??
          (await records.acceptance(operationId, journal!.payload.run!.runId)),
      )
    if (journal && ['rolled-back', 'abandoned'].includes(journal.payload.status)) {
      await append('failed', { reason: 'external-rollback', status: journal.payload.status })
      return conclusion(
        'failed',
        [
          'The automatic operation was rolled back or discarded externally. Run agent-workflow db migration auto --retry to start again.',
        ],
        { code: 'external-rollback' },
      )
    }
    // C. Finalized replay also refreshes a v1 pointer left behind by an interrupted T4 finalize.
    if (
      legacyId &&
      !(await session()).records.some(
        (r) => r.kind === 'rfc349-finalized' && r.data.operationId === legacyId,
      )
    ) {
      // A session that resumes was not judged above; a new one was, and is not asked twice.
      const status = legacyStatus ?? (await deps.legacy.status(legacyId))
      if (legacyUnfinished(status))
        return await refuse('rfc349-operation-unfinished', status, legacyGuidance(legacyId))
      const result = await deps.legacy.finalize(legacyId)
      await append('rfc349-finalized', { operationId: legacyId, result })
    }
    // RFC-626 §4.2: a binary other than the one that began the run cannot continue it. The
    // difference is found from the pin alone, before the target is prepared or opened, and is
    // recorded the way every failure of a step is: by the step failing. The run step compares
    // first thing, so asking it to run is that step; with the failure in the journal the
    // branches below start a new run. Recording comes first because a new run retires the old
    // target before it rewrites the journal — were it killed in between without the failure,
    // the next start would prepare the retired generation and be refused every time.
    if (
      epoch.direct &&
      journal &&
      classifyAutoUpgradeRun(journal.payload.failure) !== 'new-run' &&
      (await directRunMismatch(epoch, journal)).length
    ) {
      try {
        await app.run({ operationId })
      } catch (error) {
        if (classifyAutoUpgradeRun(error) !== 'new-run') throw error
      }
      journal = await epoch.journal.read(operationId)
    }
    // D. T3 records allocations before creation; nextTargetLocation does the same before a new-run CAS.
    let planInput: EpochSwitchPlanInput = {}
    if (
      persistenceDialect(facts.provider).requiresScratchProfile &&
      (!journal || phaseIndex(journal.payload.phase) < phaseIndex('activated')) &&
      // A persisted source change goes straight to the new-run branch, whose
      // nextTargetLocation provisions the next run. The current run's target may already be
      // retired by an interrupted new-run (retire, then death before the journal CAS), and
      // preparing it again would refuse that retired generation forever.
      classifyAutoUpgradeRun(journal?.payload.failure) !== 'new-run'
    ) {
      if (!deps.provisioning) throw new Error('auto-upgrade-provisioning-required')
      const identity = journal?.payload.run
        ? { runId: journal.payload.run.runId, generationId: journal.payload.target.generationId! }
        : epochRunIdentity(operationId, 0)
      try {
        const prepared = await deps.provisioning.prepare({
          sessionOperationId: operationId,
          ...identity,
        })
        planInput = {
          target: { provider: facts.provider, profileRef: prepared.target.profileRef },
          scratchProfileRef: prepared.scratch.profileRef,
        }
      } catch (error) {
        if (isProvisioningRefusal(error))
          return await refuse(error.code, error.detail, [
            error.message,
            'Prepare the reported empty databases, then run agent-workflow migrate again.',
          ])
        throw error
      }
    }
    // RFC-626 §4.2: the plan a direct run writes after its conversion is approved where the
    // run stands. For the duration of the loop only.
    epoch.approveActualPlan = async ({ runId, plan }) => {
      const decision = await decide(plan, runId, true)
      return decision.kind === 'approve' ? decision.digest : null
    }
    let pending = false
    // Declared through a cast: an initializer of `null` would narrow the variable to `null`
    // for the whole loop body, and the loop assigns it only after its first read.
    let awaited = null as { digest: string; times: number } | null
    // RFC-626 §4.2: starting a new run plans it. The run this process has just planned that
    // way is not planned a second time on the way to its execution step — a direct run's plan
    // step is a freeze and a whole inventory.
    let plannedRun: string | null = null
    const newRunPlanned = async (): Promise<string | null> =>
      epoch.direct ? ((await epoch.journal.read(operationId!))?.payload.run?.runId ?? null) : null
    for (;;) {
      await lock.assertHeld()
      journal = await epoch.journal.read(operationId)
      if (journal && classifyAutoUpgradeRun(journal.payload.failure) === 'new-run') {
        try {
          await app.run({ operationId, newRun: true })
        } catch (error) {
          if (isProvisioningRefusal(error))
            return await refuse(error.code, error.detail, [error.message])
          throw error
        }
        plannedRun = await newRunPlanned()
        continue
      }
      // E. A frozen run's pending plan is authoritative. Never call plan past planned.
      if (journal && ['verified', 'completed'].includes(journal.payload.phase)) break
      if (journal?.payload.phase === 'activated') {
        // G. Every verify error commits rollback before attempting it.
        await checkpoint('before-verify')
        try {
          await app.verify({ operationId })
        } catch (error) {
          return await rollback('verification-failed', describeError(error))
        }
        continue
      }
      let plan: MigrationPlanDocument | null = null
      // RFC-626 §4.2: a pinned plan is no longer made again. The run that pinned it has begun
      // to write artifacts that are written once from that plan's inventory; before the pin
      // every start plans afresh, which is what re-checks a target that was refused.
      const pin = journal ? await readPlanPin(epoch, journal) : null
      // The plan the new run of this process made a moment ago, when that is where it stands.
      const made =
        journal &&
        plannedRun !== null &&
        plannedRun === journal.payload.run?.runId &&
        journal.payload.phase === 'planned' &&
        !pin
          ? await readResultPlan(epoch, journal)
          : null
      plannedRun = null
      if (made) plan = made
      else if (!journal || (phaseIndex(journal.payload.phase) <= phaseIndex('planned') && !pin)) {
        const view = await app.plan(
          journal ? { operationId } : { ...planInput, requestedOperationId: operationId },
        )
        plan = view.plan
        journal = (await epoch.journal.read(operationId))!
      } else if (phaseIndex(journal.payload.phase) <= phaseIndex('planned')) {
        if (pin === null || pin === 'unreadable')
          throw new Error('auto-upgrade-plan-pin-unreadable')
        plan = await readPinnedPlan(epoch, journal, pin)
      } else if (journal.payload.status === 'awaiting-approval' || pending) {
        const status = (await app.status({ operationId })) as EpochSwitchStatusView
        const reference = status.approval?.planDigest ?? journal.payload.plan?.digest
        if (!reference) throw new Error('auto-upgrade-pending-plan-missing')
        const bytes = await epoch.journal.readArtifact(operationId, `plans/${reference}.json`)
        if (!bytes) throw new Error('auto-upgrade-pending-plan-missing')
        plan = parseMigrationPlanDocument(Buffer.from(bytes).toString('utf8'))
        if (
          plan.digest !== reference ||
          plan.payload.target.generationId !== journal.payload.target.generationId
        )
          throw new Error('auto-upgrade-pending-plan-mismatch')
      }
      const runId = journal!.payload.run!.runId
      let approval: string | null = null
      if (plan) {
        const decision = await decide(
          plan,
          runId,
          phaseIndex(journal!.payload.phase) > phaseIndex('planned'),
        )
        if (decision.kind === 'refuse')
          return await refuse(decision.reason, decision.detail, decision.guidance)
        approval = decision.digest
      }
      pending = false
      approval ??= String(
        [...(await session()).records]
          .reverse()
          .find((r) => r.kind === 'approved' && r.data.runId === runId)?.data.approvalDigest ?? '',
      )
      // A persisted source-changed failure must go through new-run even after process death.
      let result: unknown = journal!.payload.failure
      if (classifyAutoUpgradeRun(result) !== 'new-run') {
        if (!approval) throw new Error('auto-upgrade-approved-digest-missing')
        // The same approval, asked for again by the run it was given to, changes nothing.
        if (awaited?.digest === approval && awaited.times > SAME_APPROVAL_REQUESTS)
          return await refuse('approval-retry-limit', { runId }, [
            `Review agent-workflow db migration status ${operationId}; this run requested approval more than three times.`,
          ])
        try {
          result = await app.run({ operationId, approve: approval })
        } catch (error) {
          result = error
        }
      }
      // F. session.ts records structured failures and then rethrows them.
      switch (classifyAutoUpgradeRun(result)) {
        case 'awaiting-approval':
          pending = true
          awaited =
            approval && awaited?.digest === approval
              ? { digest: approval, times: awaited.times + 1 }
              : { digest: approval ?? '', times: 1 }
          continue
        case 'new-run':
          try {
            await app.run({ operationId, newRun: true })
          } catch (error) {
            if (isProvisioningRefusal(error))
              return await refuse(error.code, error.detail, [error.message])
            throw error
          }
          plannedRun = await newRunPlanned()
          continue
        case 'activated':
          await checkpoint('run-returned')
          continue
        default:
          return failed(
            result,
            `Resume with agent-workflow db migration auto (operation ${operationId}).`,
          )
      }
    }
    // H. Complete the auto session, not RFC-395's separate retention registration command.
    const s = await session()
    const receipt = await records.receipt(operationId, await buildReceipt(deps, journal!, s))
    await checkpoint('receipt')
    await append('completed', { receipt })
    await checkpoint('completed')
    // The decisions are logged line by line below; the summary line carries the rest.
    const { resolutions: published, ...summary } = receipt
    deps.log?.(`Automatic database upgrade completed: ${JSON.stringify(summary)}`)
    for (const restriction of receipt.restrictions as readonly unknown[])
      deps.log?.(`restriction: ${JSON.stringify(restriction)}`, true)
    // RFC-626 §3.7: what the upgrade decided in place of a person, as the receipt published it
    // (which is the plan of the actual result). Something to read when anything was decided.
    const decided = PlanResolutionsSchema.safeParse(published)
    if (decided.success) {
      const notable = Object.values(decided.data.totals).some((total) => total > 0)
      for (const line of resolutionReportLines(decided.data, { listed: LOGGED_DECISIONS }))
        deps.log?.(line, notable)
    }
    return conclusion(
      'done',
      [
        'Database upgraded and verified. Source, backups and scratch are retained; run db migration complete after operational acceptance.',
      ],
      { receipt },
    )
  } catch (error) {
    return failed(
      error,
      'The automatic session remains resumable; run agent-workflow db migration auto.',
    )
  } finally {
    epoch.approveActualPlan = previousApproval
    await lock.release()
  }
}

function describeError(error: unknown): unknown {
  return error instanceof Error ? { ...error, message: error.message } : error
}
/**
 * RFC-626 §3.6: the reason of a failure as text a person can read, and its code. A database
 * client throws values that are not errors; a run that stopped returns its status view.
 */
function describeFailure(value: unknown): { readonly text: string; readonly code: string | null } {
  if (value !== null && typeof value === 'object' && !(value instanceof Error)) {
    const view = value as {
      readonly message?: unknown
      readonly failure?: { readonly category?: unknown; readonly detailCode?: unknown } | null
      readonly category?: unknown
      readonly detailCode?: unknown
      readonly phase?: unknown
      readonly status?: unknown
    }
    if (typeof view.message !== 'string') {
      const failure = view.failure ?? (typeof view.detailCode === 'string' ? view : null)
      if (failure && typeof failure.detailCode === 'string')
        return {
          text: `${failure.detailCode} (${String(failure.category)})`,
          code: failure.detailCode,
        }
      if (typeof view.phase === 'string')
        return {
          text: `the run stopped in phase ${view.phase} with status ${String(view.status)}`,
          code: null,
        }
    }
  }
  const code = errorCode(value)
  const category = (value as { readonly category?: unknown } | null)?.category
  const text = errorText(value)
  return {
    text: typeof category === 'string' && category !== code ? `${text} (${category})` : text,
    code,
  }
}
function isProvisioningRefusal(
  error: unknown,
): error is Error & { code: string; detail: Readonly<Record<string, unknown>> } {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('postgresql-') &&
    'detail' in error
  )
}
/**
 * The plan the journal names, which after `validated` is the plan of the actual result. A
 * report must not fail the upgrade it reports: a plan that cannot be read is no plan.
 */
async function readResultPlan(
  epoch: EpochSwitchDependencies,
  journal: EpochSwitchJournal,
): Promise<MigrationPlanDocument | null> {
  const plan = journal.payload.plan
  if (!plan) return null
  try {
    const bytes = await epoch.journal.readArtifact(
      journal.payload.operationId,
      `plans/${plan.digest}.json`,
    )
    return bytes ? parseMigrationPlanDocument(Buffer.from(bytes).toString('utf8')) : null
  } catch {
    return null
  }
}
async function buildReceipt(
  deps: AutoUpgradeDependencies,
  journal: EpochSwitchJournal,
  session: AutoUpgradeSession,
) {
  const p = journal.payload
  const evaluations = session.records.filter(
    (r) => r.kind === 'plan-evaluated' && r.data.runId === p.run?.runId,
  )
  const checkpoints = [{ phase: 'intent', committedAt: session.records[0]!.at }, ...p.checkpoints]
  // RFC-626 §3.7: an automatic upgrade reports from the plan of its actual result — the
  // decisions it made and the restrictions that plan lists. A plan without decisions is not
  // such a plan, and its receipt keeps the restrictions of the last evaluation as before.
  const decided = (await readResultPlan(deps.epoch, journal))?.payload
  return {
    operationId: p.operationId,
    runId: p.run?.runId,
    sourceFingerprint: p.source.fingerprintDigest,
    source: p.source.location,
    target: p.target.location,
    restrictions: decided?.resolutions
      ? decided.restrictions
      : (evaluations.at(-1)?.data.restrictions ?? []),
    ...(decided?.resolutions ? { resolutions: decided.resolutions } : {}),
    rfc349: session.records.filter((r) => r.kind === 'rfc349-finalized').map((r) => r.data),
    provisioning: session.records.filter((r) => r.kind === 'provisioned').map((r) => r.data),
    retainedDatabases: (await deps.provisioning?.retained()) ?? [],
    backup: p.backup,
    phaseTimings: checkpoints.map((c, i) => ({
      phase: c.phase,
      elapsedMs: Math.max(0, (checkpoints[i + 1]?.committedAt ?? Date.now()) - c.committedAt),
    })),
    rollbackGuidance:
      'Before the first business write use db migration rollback. After daemon startup, restore the pre-switch backup with the old binary; later writes are lost.',
    completedAt: Date.now(),
  }
}
