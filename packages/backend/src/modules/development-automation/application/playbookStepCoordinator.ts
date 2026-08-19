// RFC-310 PR-11/PR-12 — deterministic business-step coordinator.
//
// The published employee revision chooses the next step. Agent/script output
// cannot select another executor or recursively call an employee: it can only
// settle the exact StepRun claimed here. Child Missions and approvals are
// durable, idempotent program arms with short observations and deferred wakes.

import { ulid } from 'ulid'

import { actionTemplateContentSchema } from '../domain/actionTemplate'
import { canonicalDigest } from '../domain/canonicalJson'
import {
  digitalEmployeeContentSchema,
  type DigitalEmployeeContent,
} from '../domain/digitalEmployee'
import { evaluatePredicate, type MissionFactSnapshot } from '../domain/facts'
import type { FactPredicate } from '../domain/predicate'
import type { NextDecision } from '../domain/decision'
import type { MissionRow } from './ports/missionStore'
import type { StepRunRow } from './ports/playbookSagaStore'
import type { ReconcileDeps, ReconcileOutcome } from './missionReconciler'
import {
  childMissionIntentSchema,
  childMissionReceiptSchema,
  evaluateStepJoin,
  type JoinMemberState,
} from '../domain/stepSaga'

type EmployeeStep = NonNullable<DigitalEmployeeContent['steps']>[number]
type ProblemProducer = NonNullable<DigitalEmployeeContent['problemProducers']>[number]
type ProblemHandler = NonNullable<DigitalEmployeeContent['problemHandlers']>[number]
type StepTarget = EmployeeStep['onSuccess']

type Handled = Extract<ReconcileOutcome, { kind: 'decided' }>['handled']

const MAX_CHILD_DEPTH = 8
const MAX_CHILDREN_PER_MISSION = 16
const MAX_CHILD_WALL_MS = 30 * 24 * 60 * 60 * 1_000

async function employeeContent(
  deps: ReconcileDeps,
  mission: MissionRow,
): Promise<DigitalEmployeeContent | null> {
  if (mission.employeeId === null || mission.employeeRevision === null) return null
  const raw = await deps.lookup.getEmployeeRevisionContent(
    mission.employeeId,
    mission.employeeRevision,
  )
  if (raw === null) return null
  return digitalEmployeeContentSchema.parse(raw)
}

function knownString(snapshot: MissionFactSnapshot, factId: string): string | null {
  const cell = snapshot.cells[factId]
  return cell?.state === 'known' && typeof cell.value === 'string' ? cell.value : null
}

function knownStrings(snapshot: MissionFactSnapshot, factId: string): readonly string[] {
  const cell = snapshot.cells[factId]
  return cell?.state === 'known' && Array.isArray(cell.value) ? cell.value : []
}

/** Root-to-current lineage reconstructed from durable parent links. */
function missionAncestry(deps: ReconcileDeps, missionId: string): string[] | null {
  const store = deps.ports.playbookSaga
  if (store === undefined) return null
  const seen = new Set<string>()
  const ancestry: string[] = []
  let cursor: string | null = missionId
  while (cursor !== null) {
    if (seen.has(cursor) || ancestry.length >= MAX_CHILD_DEPTH) return null
    seen.add(cursor)
    ancestry.unshift(cursor)
    cursor = store.findParentMissionLink(cursor)?.parentMissionId ?? null
  }
  return ancestry
}

function stepInput(
  deps: ReconcileDeps,
  mission: MissionRow,
  snapshot: MissionFactSnapshot,
  input: NonNullable<DigitalEmployeeContent['steps']>[number]['input'],
): { ref: string; digest: string } | null {
  const store = deps.ports.playbookSaga
  if (store === undefined) return null
  if (input.kind === 'mission-requirement') {
    const ref = mission.requirementBundleRef ?? mission.sourceContentDigest
    return ref === null ? null : { ref, digest: canonicalDigest({ kind: input.kind, ref }) }
  }
  if (input.kind === 'selected-problems') {
    const ref = knownString(snapshot, '__problem.setRef')
    const evidenceDigest = knownString(snapshot, '__problem.evidenceDigest')
    return ref === null || evidenceDigest === null
      ? null
      : { ref, digest: canonicalDigest({ kind: input.kind, ref, evidenceDigest }) }
  }
  const runs = store.listStepRuns(mission.id)
  if (input.kind === 'step-output') {
    const source = [...runs]
      .reverse()
      .find(
        (run) => run.stepId === input.stepId && run.state === 'succeeded' && run.outputRef !== null,
      )
    return source?.outputRef === undefined || source.outputRef === null
      ? null
      : {
          ref: source.outputRef,
          digest: canonicalDigest({
            kind: input.kind,
            stepId: input.stepId,
            ref: source.outputRef,
          }),
        }
  }
  const refs = input.sources.map((source) => {
    const run = [...runs]
      .reverse()
      .find((candidate) => candidate.stepId === source.stepId && candidate.state === 'succeeded')
    return run?.outputRef === null || run?.outputRef === undefined
      ? null
      : { name: source.name, stepId: source.stepId, ref: run.outputRef }
  })
  if (refs.some((value) => value === null)) return null
  const complete = refs as { name: string; stepId: string; ref: string }[]
  return { ref: `compose:${canonicalDigest(complete)}`, digest: canonicalDigest(complete) }
}

function predicateFactIds(predicate: FactPredicate): string[] {
  if (predicate.kind === 'all' || predicate.kind === 'any') {
    return predicate.predicates.flatMap(predicateFactIds)
  }
  if (predicate.kind === 'not') return predicateFactIds(predicate.predicate)
  if (predicate.kind === 'path-class-any') return ['repository.changedPathClasses']
  return [predicate.fact]
}

function stepExecutionInput(
  deps: ReconcileDeps,
  mission: MissionRow,
  snapshot: MissionFactSnapshot,
  step: EmployeeStep,
): { ref: string; digest: string } | null {
  const input = stepInput(deps, mission, snapshot, step.input)
  if (input === null || step.when.length === 0) return input
  const factIds = [...new Set(step.when.flatMap(predicateFactIds))].sort()
  const trigger = factIds.map((factId) => [factId, snapshot.cells[factId] ?? null] as const)
  return {
    ref: input.ref,
    digest: canonicalDigest({ inputDigest: input.digest, trigger }),
  }
}

function matches(
  snapshot: MissionFactSnapshot,
  predicates: readonly DigitalEmployeeContent['supportedRepositoryFacts'][number][],
): boolean {
  for (const predicate of predicates) {
    if (evaluatePredicate(snapshot, predicate).value !== true) return false
  }
  return true
}

function failureDecision(target: string, reason: string): NextDecision | null {
  if (target === 'block') return { kind: 'block', reason }
  if (target === 'handoff') return { kind: 'handoff', reason }
  return null
}

function waitForPlaybook(
  reason: string,
  attemptOrdinal: number,
  resumeAt: number | null = null,
): NextDecision {
  return {
    kind: 'wait',
    reason,
    resumeAt: resumeAt === null ? null : new Date(resumeAt).toISOString().replace('Z', '+00:00'),
    wakeSources: resumeAt === null ? ['webhook', 'manual'] : ['webhook', 'timer', 'manual'],
    attemptOrdinal,
  }
}

function latestRun(
  runs: readonly StepRunRow[],
  stepId: string,
  inputDigest?: string,
): StepRunRow | undefined {
  return [...runs]
    .reverse()
    .find(
      (run) =>
        run.stepId === stepId && (inputDigest === undefined || run.inputDigest === inputDigest),
    )
}

function failureTarget(step: EmployeeStep, run: StepRunRow): StepTarget {
  const code = run.failureCode ?? ''
  if (/rejected|denied/.test(code) && step.onFailure.onRejected !== null) {
    return step.onFailure.onRejected
  }
  if (/expired|deadline|timeout/.test(code) && step.onFailure.onExpired !== null) {
    return step.onFailure.onExpired
  }
  return step.onFailure.onExhausted
}

function actionOwnsRetryBudget(step: EmployeeStep): boolean {
  return (
    step.producer.kind === 'agent' ||
    step.producer.kind === 'script' ||
    step.producer.kind === 'approval-prepare'
  )
}

function claimRun(
  deps: ReconcileDeps,
  mission: MissionRow,
  step: NonNullable<DigitalEmployeeContent['steps']>[number],
  inputDigest: string,
  attempt: number,
): StepRunRow {
  const deadlineMs =
    step.producer.kind === 'digital-employee' || step.producer.kind === 'approval-observe'
      ? step.producer.deadlineMs
      : step.join?.deadlineMs
  return deps.ports.playbookSaga!.claimStepRun({
    id: ulid(),
    missionId: mission.id,
    employeeId: mission.employeeId!,
    employeeRevision: mission.employeeRevision!,
    stepId: step.stepId,
    attempt,
    inputDigest,
    producerKind: step.producer.kind,
    deadlineAt: deadlineMs === undefined ? null : deps.now() + deadlineMs,
    now: deps.now(),
  }).row
}

function templateDecision(
  deps: ReconcileDeps,
  run: StepRunRow,
  implementationRef: { id: string; revision: number },
  workSetRef: string,
  context: Pick<
    Extract<NextDecision, { kind: 'run-agent-action' }>,
    'problemInput' | 'approvalInput'
  > = {},
  retryBudget?: { readonly sameScene: number; readonly freshScene: number },
): NextDecision {
  const raw = deps.ports.actionTemplates?.content(implementationRef.id, implementationRef.revision)
  if (raw === null || raw === undefined) {
    return {
      kind: 'block',
      reason: `step-template-unavailable:${implementationRef.id}@${implementationRef.revision}`,
    }
  }
  const template = actionTemplateContentSchema.safeParse(raw)
  if (!template.success) return { kind: 'block', reason: 'step-template-invalid' }
  return {
    kind: 'run-agent-action',
    capabilityId: template.data.capabilityId,
    templateRef: `${implementationRef.id}@${implementationRef.revision}`,
    workSetRef,
    stepRunRef: run.id,
    ...(context.problemInput === undefined ? {} : { problemInput: context.problemInput }),
    ...(context.approvalInput === undefined ? {} : { approvalInput: context.approvalInput }),
    ...(retryBudget === undefined
      ? {}
      : {
          retryBudget: {
            sameSession: retryBudget.sameScene,
            freshSession: retryBudget.freshScene,
          },
        }),
  }
}

function passivePlatformOutput(
  snapshot: MissionFactSnapshot,
  capabilityId: Extract<EmployeeStep['producer'], { kind: 'platform' }>['capabilityId'],
): { ref: string; revision: string } | null {
  const fact = (id: string): unknown => {
    const cell = snapshot.cells[id]
    return cell?.state === 'known' ? cell.value : null
  }
  if (capabilityId === 'verification.run') {
    const rows = Object.entries(snapshot.cells)
      .filter(([id, cell]) => id.startsWith('__verification.') && cell.state === 'known')
      .map(([id, cell]) => [id, cell.state === 'known' ? cell.value : null] as const)
    if (rows.length === 0 || rows.some(([, value]) => value !== 'passed')) return null
    return { ref: `verification:${canonicalDigest(rows)}`, revision: snapshot.digest }
  }
  if (capabilityId === 'change.publish') {
    const sha = fact('__delivery.commitSha')
    return fact('__delivery.publishState') === 'pushed' && typeof sha === 'string'
      ? { ref: `commit:${sha}`, revision: sha }
      : null
  }
  if (capabilityId === 'pipeline.rerun' || capabilityId === 'pipeline.trigger') {
    const manifest = fact('__pipeline.manifestRef')
    return fact('pipeline.requiredGatesAllPass') === true && typeof manifest === 'string'
      ? { ref: manifest, revision: snapshot.digest }
      : null
  }
  return null
}

function claimNamedRun(
  deps: ReconcileDeps,
  mission: MissionRow,
  stepId: string,
  producerKind: string,
  inputDigest: string,
  attempt: number,
): StepRunRow {
  return deps.ports.playbookSaga!.claimStepRun({
    id: ulid(),
    missionId: mission.id,
    employeeId: mission.employeeId!,
    employeeRevision: mission.employeeRevision!,
    stepId,
    attempt,
    inputDigest,
    producerKind,
    deadlineAt: null,
    now: deps.now(),
  }).row
}

function problemEvidence(
  snapshot: MissionFactSnapshot,
  producer: ProblemProducer,
): NonNullable<Extract<NextDecision, { kind: 'run-agent-action' }>['problemInput']> | null {
  const headSha =
    knownString(snapshot, '__pipeline.headSha') ?? knownString(snapshot, '__mr.headSha')
  if (headSha === null || !/^[0-9a-f]{40}$/.test(headSha)) return null
  const allowedTypeIds = [...new Set(producer.allowedTypeIds)].sort()
  for (const domain of producer.evidenceDomains) {
    let subjects: string[] = []
    let sourceRevision: string | null = null
    if (domain === 'pipeline') {
      subjects = [
        ...knownStrings(snapshot, 'pipeline.failingRequiredGateKeys'),
        ...knownStrings(snapshot, 'pipeline.missingRequiredGateKeys'),
      ]
      sourceRevision = knownString(snapshot, '__pipeline.manifestDigest')
    } else if (domain === 'feedback') {
      const raw = knownString(snapshot, '__mr.unresolvedFeedback')
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw) as {
            items?: { threadRef?: unknown; revision?: unknown }[]
          }
          subjects = (parsed.items ?? []).flatMap((item) =>
            typeof item.threadRef === 'string' && typeof item.revision === 'string'
              ? [`${item.threadRef}@${item.revision}`]
              : [],
          )
        } catch {
          subjects = []
        }
      }
      sourceRevision = raw === null ? null : canonicalDigest(raw)
    } else if (domain === 'conflict') {
      if (
        snapshot.cells['mr.conflict']?.state === 'known' &&
        snapshot.cells['mr.conflict'].value === true
      ) {
        subjects = ['mr-conflict']
        sourceRevision = snapshot.digest
      }
    } else if (domain === 'verification') {
      subjects = Object.entries(snapshot.cells)
        .filter(
          ([id, cell]) =>
            id.startsWith('__verification.') && cell.state === 'known' && cell.value === 'failed',
        )
        .map(([id]) => id.slice('__verification.'.length))
      sourceRevision = subjects.length === 0 ? null : snapshot.digest
    } else if (domain === 'mr') {
      const mrHead = knownString(snapshot, '__mr.headSha')
      if (mrHead !== null) {
        subjects = [`mr-head:${mrHead}`]
        sourceRevision = snapshot.digest
      }
    }
    subjects = [...new Set(subjects)].sort()
    if (subjects.length > 0 && sourceRevision !== null) {
      return {
        producerId: producer.producerId,
        evidenceDigest: canonicalDigest({ domain, sourceRevision, headSha, subjects }),
        headSha,
        allowedTypeIds,
        subjectRefs: subjects,
        requiredSubjectRefs: subjects,
      }
    }
  }
  return null
}

function syntheticRun(
  deps: ReconcileDeps,
  mission: MissionRow,
  stepId: string,
  kind: string,
  inputDigest: string,
): StepRunRow {
  return (
    latestRun(deps.ports.playbookSaga!.listStepRuns(mission.id), stepId, inputDigest) ??
    claimNamedRun(deps, mission, stepId, kind, inputDigest, 0)
  )
}

type ProblemProducerSelection =
  | { readonly kind: 'decision'; readonly decision: NextDecision }
  | { readonly kind: 'settled' }
  | { readonly kind: 'none' }

function problemProducerDecision(
  deps: ReconcileDeps,
  mission: MissionRow,
  snapshot: MissionFactSnapshot,
  employee: DigitalEmployeeContent,
): ProblemProducerSelection {
  const producers = employee.problemProducers ?? []
  const byId = new Map(producers.map((producer) => [producer.producerId, producer]))
  const fallbackIds = new Set(
    producers.flatMap((producer) =>
      producer.fallbackProducerId === null ? [] : [producer.fallbackProducerId],
    ),
  )
  const roots = producers.filter((producer) => !fallbackIds.has(producer.producerId))
  if (producers.length > 0 && roots.length === 0) {
    return {
      kind: 'decision',
      decision: { kind: 'block', reason: 'problem-producer-fallback-cycle' },
    }
  }

  const decide = (producer: ProblemProducer, visited: Set<string>): ProblemProducerSelection => {
    if (visited.has(producer.producerId)) {
      return {
        kind: 'decision',
        decision: {
          kind: 'block',
          reason: `problem-producer-fallback-cycle:${producer.producerId}`,
        },
      }
    }
    if (!matches(snapshot, producer.when)) return { kind: 'none' }
    const evidence = problemEvidence(snapshot, producer)
    if (evidence === null) return { kind: 'none' }
    const inputDigest = canonicalDigest(evidence)
    const run = syntheticRun(
      deps,
      mission,
      `problem-producer:${producer.producerId}`,
      producer.kind,
      inputDigest,
    )
    if (run.state === 'succeeded' || run.state === 'observation-only') {
      return { kind: 'settled' }
    }
    if (run.state === 'failed') {
      const fallback =
        producer.fallbackProducerId === null
          ? null
          : (byId.get(producer.fallbackProducerId) ?? null)
      if (fallback === null) {
        return {
          kind: 'decision',
          decision: {
            kind: 'block',
            reason: `problem-producer-exhausted:${producer.producerId}:${run.failureCode ?? 'failed'}`,
          },
        }
      }
      return decide(fallback, new Set([...visited, producer.producerId]))
    }
    return {
      kind: 'decision',
      decision: templateDecision(
        deps,
        run,
        producer.implementationRef,
        `problem-evidence:${evidence.evidenceDigest}`,
        { problemInput: evidence },
        producer.retry,
      ),
    }
  }

  for (const producer of roots) {
    const selected = decide(producer, new Set())
    if (selected.kind !== 'none') return selected
  }
  return { kind: 'none' }
}

async function problemHandlerDecision(
  deps: ReconcileDeps,
  mission: MissionRow,
  snapshot: MissionFactSnapshot,
  employee: DigitalEmployeeContent,
  stepsById: ReadonlyMap<string, EmployeeStep>,
): Promise<NextDecision | null> {
  const setRef = knownString(snapshot, '__problem.setRef')
  const evidenceDigest = knownString(snapshot, '__problem.evidenceDigest')
  const typeIds = new Set(knownStrings(snapshot, '__problem.typeIds'))
  if (setRef === null || evidenceDigest === null || typeIds.size === 0) return null
  const handlers = employee.problemHandlers ?? []
  const byRuleId = new Map(handlers.map((handler) => [handler.ruleId, handler]))
  const problemTypes = new Map((employee.problemTypes ?? []).map((type) => [type.typeId, type]))
  const orderedTypes = [...typeIds].sort((a, b) => {
    const left = problemTypes.get(a)?.priority ?? Number.MAX_SAFE_INTEGER
    const right = problemTypes.get(b)?.priority ?? Number.MAX_SAFE_INTEGER
    return left - right || a.localeCompare(b)
  })

  const decideHandler = async (
    handler: ProblemHandler,
    visited: Set<string>,
  ): Promise<NextDecision | null> => {
    if (visited.has(handler.ruleId)) {
      return { kind: 'block', reason: `problem-handler-fallback-cycle:${handler.ruleId}` }
    }
    if (!matches(snapshot, handler.when)) return null
    const inputDigest = canonicalDigest({ setRef, evidenceDigest, ruleId: handler.ruleId })
    const run = syntheticRun(
      deps,
      mission,
      `problem-handler:${handler.ruleId}`,
      handler.handler.kind,
      inputDigest,
    )
    if (run.state === 'failed') {
      const fallback =
        handler.fallbackRuleId === null ? null : (byRuleId.get(handler.fallbackRuleId) ?? null)
      if (fallback === null) {
        return {
          kind: 'block',
          reason: `problem-handler-exhausted:${handler.ruleId}:${run.failureCode ?? 'failed'}`,
        }
      }
      return await decideHandler(fallback, new Set([...visited, handler.ruleId]))
    }
    if (run.state !== 'succeeded' && run.state !== 'observation-only') {
      return templateDecision(
        deps,
        run,
        handler.handler.implementationRef,
        setRef,
        {},
        handler.retry,
      )
    }

    for (const verifyStepId of handler.verifyStepIds) {
      const step = stepsById.get(verifyStepId)
      if (step === undefined) {
        return { kind: 'block', reason: `problem-verification-step-missing:${verifyStepId}` }
      }
      const verification = await inspectStep(deps, mission, snapshot, step)
      if (verification.kind === 'decision') return verification.decision
      if (verification.kind === 'defer') return null
      if (verification.kind === 'unavailable') {
        return {
          kind: 'block',
          reason: `problem-verification-input-unavailable:${verifyStepId}`,
        }
      }
      if (verification.kind === 'failed') {
        return await decisionFromTarget(
          deps,
          mission,
          snapshot,
          stepsById,
          failureTarget(step, verification.run),
          `problem-verification-failed:${verifyStepId}`,
          new Set([verifyStepId]),
        )
      }
    }
    return null
  }

  for (const typeId of orderedTypes) {
    const typeHandlers = handlers.filter((handler) => handler.typeId === typeId)
    const fallbackRuleIds = new Set(
      typeHandlers.flatMap((handler) =>
        handler.fallbackRuleId === null ? [] : [handler.fallbackRuleId],
      ),
    )
    const roots = typeHandlers.filter((handler) => !fallbackRuleIds.has(handler.ruleId))
    if (typeHandlers.length > 0 && roots.length === 0) {
      return { kind: 'block', reason: `problem-handler-fallback-cycle:${typeId}` }
    }
    const applicable = roots.find((handler) => matches(snapshot, handler.when))
    if (applicable === undefined) {
      return { kind: 'block', reason: `problem-handler-missing:${typeId}` }
    }
    const decision = await decideHandler(applicable, new Set())
    if (decision !== null) return decision
  }
  return null
}

function platformDecision(
  mission: MissionRow,
  snapshot: MissionFactSnapshot,
  run: StepRunRow,
  capabilityId: NonNullable<DigitalEmployeeContent['steps']>[number]['producer'] extends infer P
    ? P extends { kind: 'platform'; capabilityId: infer C }
      ? C
      : never
    : never,
): NextDecision | null {
  switch (capabilityId) {
    case 'requirement.acquire':
      if (mission.sourceKind === 'direct') {
        return mission.sourceContentDigest === null
          ? { kind: 'block', reason: 'direct-submission-digest-missing' }
          : {
              kind: 'materialize-direct-requirement',
              submissionRef: mission.sourceContentDigest,
              stepRunRef: run.id,
            }
      }
      return mission.resolvedAdapterId === null || mission.resolvedAdapterRevision === null
        ? { kind: 'block', reason: 'requirement-adapter-unresolved' }
        : {
            kind: 'collect-external-requirement',
            adapterBindingRef: `${mission.resolvedAdapterId}@${mission.resolvedAdapterRevision}`,
            stepRunRef: run.id,
          }
    case 'repository.inspect':
      return { kind: 'collect-repository-facts', stepRunRef: run.id }
    case 'mr.collect':
      return { kind: 'collect-mr-facts', stepRunRef: run.id }
    case 'pipeline.collect': {
      const keys = [
        ...new Set([
          ...knownStrings(snapshot, 'pipeline.failingRequiredGateKeys'),
          ...knownStrings(snapshot, 'pipeline.missingRequiredGateKeys'),
        ]),
      ]
      return {
        kind: 'collect-pipeline-evidence',
        gateKeys: keys.length === 0 ? ['default'] : keys,
        stepRunRef: run.id,
      }
    }
    case 'mr.ensure':
      return { kind: 'ensure-merge-request', stepRunRef: run.id }
    case 'readiness.evaluate':
      return { kind: 'publish-readiness', stepRunRef: run.id }
    // These actions require exact candidate/profile/run refs derived by the
    // normal closed policy chain. Returning null hands control back to that
    // chain instead of inventing parameters.
    case 'verification.run':
    case 'change.publish':
    case 'pipeline.rerun':
    case 'pipeline.trigger':
      return null
  }
}

async function decisionForStep(
  deps: ReconcileDeps,
  mission: MissionRow,
  snapshot: MissionFactSnapshot,
  step: NonNullable<DigitalEmployeeContent['steps']>[number],
  run: StepRunRow,
  inputRef: string,
): Promise<NextDecision | null> {
  const producer = step.producer
  if (producer.kind === 'platform') {
    return platformDecision(mission, snapshot, run, producer.capabilityId)
  }
  if (producer.kind === 'agent' || producer.kind === 'script') {
    return templateDecision(
      deps,
      run,
      producer.implementationRef,
      inputRef,
      {},
      step.onFailure.retry,
    )
  }
  if (producer.kind === 'approval-prepare') {
    return templateDecision(
      deps,
      run,
      producer.implementationRef,
      inputRef,
      {
        approvalInput: {
          stepRunRef: run.id,
          approvalType: producer.approvalType,
          evidenceRefs: [inputRef],
          requestedScopes: [],
        },
      },
      step.onFailure.retry,
    )
  }
  if (producer.kind === 'digital-employee') {
    const targetRepositoryRef =
      producer.repository.kind === 'fixed'
        ? producer.repository.repositoryId
        : knownString(snapshot, producer.repository.factId)
    if (targetRepositoryRef === null)
      return { kind: 'block', reason: 'child-target-repository-unresolved' }
    const ancestry = missionAncestry(deps, mission.id)
    if (ancestry === null) return { kind: 'block', reason: 'child-mission-ancestry-invalid' }
    if (ancestry.length >= MAX_CHILD_DEPTH) {
      return { kind: 'block', reason: 'child-mission-depth-exhausted' }
    }
    const repeatsEmployee = ancestry.some((ancestorId) => {
      const ancestor = deps.store.getMission(ancestorId)
      // Revisions are immutable execution pins, not distinct employee
      // identities. A@1 → B@1 → A@2 is still a recursive call graph.
      return ancestor?.employeeId === producer.employeeRef.id
    })
    if (repeatsEmployee) return { kind: 'block', reason: 'child-mission-cycle' }
    const existingLink = deps.ports.playbookSaga!.getMissionLinkByStepRun(run.id)
    if (
      existingLink === null &&
      deps.ports.playbookSaga!.listMissionLinks(mission.id).length >= MAX_CHILDREN_PER_MISSION
    ) {
      return { kind: 'block', reason: 'child-mission-budget-exhausted' }
    }
    const root = deps.store.getMission(ancestry[0]!)
    const wallDeadline = (root?.createdAt ?? mission.createdAt) + MAX_CHILD_WALL_MS
    if (deps.now() >= wallDeadline) {
      return { kind: 'block', reason: 'child-mission-wall-time-exhausted' }
    }
    const deadlineAt = new Date(
      Math.min(run.deadlineAt ?? deps.now() + producer.deadlineMs, wallDeadline),
    )
      .toISOString()
      .replace('Z', '+00:00')
    const idempotencyKey = canonicalDigest({
      missionId: mission.id,
      epoch: mission.epoch,
      stepId: step.stepId,
      attempt: run.attempt,
      targetRepositoryRef,
      employeeRef: producer.employeeRef,
      inputDigest: run.inputDigest,
    })
    return {
      kind: 'invoke-child-mission',
      stepRunRef: run.id,
      targetRepositoryRef,
      targetEmployeeRef: producer.employeeRef,
      inputEnvelopeRef: inputRef,
      completion: producer.completion,
      deadlineAt,
      idempotencyKey,
      ancestry,
    }
  }
  if (producer.kind === 'approval-submit') {
    const deadlineAt = new Date(run.deadlineAt ?? deps.now() + 24 * 60 * 60 * 1_000)
      .toISOString()
      .replace('Z', '+00:00')
    return {
      kind: 'submit-approval',
      stepRunRef: run.id,
      adapterRef: producer.adapterRef,
      validatedDraftRef: inputRef,
      deadlineAt,
      idempotencyKey: canonicalDigest({
        missionId: mission.id,
        epoch: mission.epoch,
        stepId: step.stepId,
        attempt: run.attempt,
        adapterRef: producer.adapterRef,
        inputDigest: run.inputDigest,
      }),
    }
  }
  const sagaId = inputRef.startsWith('approval-saga:')
    ? inputRef.slice('approval-saga:'.length)
    : inputRef
  return {
    kind: 'observe-approval',
    stepRunRef: run.id,
    approvalSagaRef: sagaId,
    pollIntervalMs: producer.pollIntervalMs,
  }
}

type StepInspection =
  | { readonly kind: 'decision'; readonly decision: NextDecision }
  | { readonly kind: 'defer' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'succeeded'; readonly run: StepRunRow }
  | { readonly kind: 'failed'; readonly run: StepRunRow }

async function inspectStep(
  deps: ReconcileDeps,
  mission: MissionRow,
  snapshot: MissionFactSnapshot,
  step: EmployeeStep,
): Promise<StepInspection> {
  const store = deps.ports.playbookSaga!
  if (!matches(snapshot, step.when)) return { kind: 'unavailable' }
  const input = stepExecutionInput(deps, mission, snapshot, step)
  if (input === null) return { kind: 'unavailable' }

  if (
    step.producer.kind === 'platform' &&
    (step.producer.capabilityId === 'verification.run' ||
      step.producer.capabilityId === 'change.publish' ||
      step.producer.capabilityId === 'pipeline.rerun' ||
      step.producer.capabilityId === 'pipeline.trigger')
  ) {
    const observed = passivePlatformOutput(snapshot, step.producer.capabilityId)
    if (observed === null) return { kind: 'defer' }
    const passive =
      latestRun(store.listStepRuns(mission.id), step.stepId, input.digest) ??
      claimNamedRun(deps, mission, step.stepId, step.producer.kind, input.digest, 0)
    if (passive.state !== 'succeeded' && passive.state !== 'observation-only') {
      store.updateStepRun({
        id: passive.id,
        from: ['claimed', 'running', 'waiting'],
        state: 'succeeded',
        outputRef: observed.ref,
        outputRevision: observed.revision,
        now: deps.now(),
      })
    }
    return {
      kind: 'succeeded',
      run: store.getStepRun(passive.id) ?? { ...passive, state: 'succeeded' },
    }
  }

  let run = latestRun(store.listStepRuns(mission.id), step.stepId, input.digest)
  if (
    run?.state === 'succeeded' ||
    (run?.state === 'observation-only' && run.failureCode === null)
  ) {
    return { kind: 'succeeded', run }
  }
  if (run?.state === 'failed' || (run?.state === 'observation-only' && run.failureCode !== null)) {
    const target = failureTarget(step, run)
    const categoricalFailure =
      target !== step.onFailure.onExhausted &&
      /rejected|denied|expired|deadline|timeout/.test(run.failureCode ?? '')
    const retryLimit = step.onFailure.retry.sameScene + step.onFailure.retry.freshScene
    if (!categoricalFailure && !actionOwnsRetryBudget(step) && run.attempt < retryLimit) {
      run = claimRun(deps, mission, step, input.digest, run.attempt + 1)
    } else {
      return { kind: 'failed', run }
    }
  }
  if (run === undefined) run = claimRun(deps, mission, step, input.digest, 0)
  const decision = await decisionForStep(deps, mission, snapshot, step, run, input.ref)
  return decision === null ? { kind: 'defer' } : { kind: 'decision', decision }
}

async function decisionAfterSucceededStep(
  deps: ReconcileDeps,
  mission: MissionRow,
  snapshot: MissionFactSnapshot,
  stepsById: ReadonlyMap<string, EmployeeStep>,
  step: EmployeeStep,
  run: StepRunRow,
  visited: Set<string>,
): Promise<NextDecision | null> {
  const join = step.join
  if (join === null) {
    return await decisionFromTarget(
      deps,
      mission,
      snapshot,
      stepsById,
      step.onSuccess,
      `step-succeeded:${step.stepId}`,
      visited,
    )
  }

  const store = deps.ports.playbookSaga!
  const previous = store.listJoinMembers(mission.id, join.groupId)
  const settledResult =
    previous.find((member) => member.settledResult !== null)?.settledResult ?? null
  if (settledResult !== null) {
    const target =
      settledResult === 'satisfied'
        ? step.onSuccess
        : settledResult === 'deadline'
          ? join.onDeadline
          : join.onPartial
    return await decisionFromTarget(
      deps,
      mission,
      snapshot,
      stepsById,
      target,
      `step-join-${settledResult}:${join.groupId}`,
      visited,
    )
  }

  const deadlineAt = run.createdAt + join.deadlineMs
  const memberRuns = new Map<string, StepRunRow | undefined>()
  const memberStates: JoinMemberState[] = []
  for (const memberStepId of join.memberStepIds) {
    const memberStep = stepsById.get(memberStepId)
    const input =
      memberStep === undefined ? null : stepExecutionInput(deps, mission, snapshot, memberStep)
    const memberRun =
      input === null
        ? undefined
        : latestRun(store.listStepRuns(mission.id), memberStepId, input.digest)
    memberRuns.set(memberStepId, memberRun)
    const memberState: JoinMemberState =
      memberRun === undefined ||
      memberRun.state === 'claimed' ||
      memberRun.state === 'running' ||
      memberRun.state === 'waiting'
        ? 'pending'
        : memberRun.failureCode === null
          ? 'succeeded'
          : /expired|deadline|timeout/.test(memberRun.failureCode)
            ? 'expired'
            : 'failed'
    memberStates.push(memberState)
    store.upsertJoinMember({
      missionId: mission.id,
      groupId: join.groupId,
      memberStepId,
      mode: join.mode,
      quorum: join.quorum,
      deadlineAt,
      memberState,
      receiptRevision: memberRun?.outputRevision ?? null,
      settledResult: null,
      now: deps.now(),
    })
  }

  const verdict = evaluateStepJoin({
    mode: join.mode,
    quorum: join.quorum,
    deadlineAt,
    now: deps.now(),
    members: memberStates,
  })
  if (verdict.kind !== 'pending') {
    store.settleJoin(mission.id, join.groupId, verdict.kind, deps.now())
    if (verdict.kind === 'satisfied') {
      for (const memberStepId of join.memberStepIds) {
        const member = memberRuns.get(memberStepId)
        if (member?.state !== 'waiting') continue
        store.updateStepRun({
          id: member.id,
          from: ['waiting'],
          state: 'observation-only',
          now: deps.now(),
        })
      }
    }
    const target =
      verdict.kind === 'satisfied'
        ? step.onSuccess
        : verdict.kind === 'deadline'
          ? join.onDeadline
          : join.onPartial
    return await decisionFromTarget(
      deps,
      mission,
      snapshot,
      stepsById,
      target,
      `step-join-${verdict.kind}:${join.groupId}`,
      visited,
    )
  }

  // Launch every not-yet-started member before repeatedly observing an
  // already-waiting child/approval. This gives all/any/quorum joins real
  // durable fan-out while preserving the single active Agent workspace rule.
  for (const memberStepId of join.memberStepIds) {
    if (memberRuns.get(memberStepId) !== undefined) continue
    const memberStep = stepsById.get(memberStepId)
    if (memberStep === undefined) continue
    const inspection = await inspectStep(deps, mission, snapshot, memberStep)
    if (inspection.kind === 'decision') return inspection.decision
    if (inspection.kind === 'defer') return null
  }
  for (const memberStepId of join.memberStepIds) {
    const member = memberRuns.get(memberStepId)
    if (
      member === undefined ||
      (member.state !== 'claimed' && member.state !== 'running' && member.state !== 'waiting')
    ) {
      continue
    }
    const memberStep = stepsById.get(memberStepId)
    if (memberStep === undefined) continue
    const inspection = await inspectStep(deps, mission, snapshot, memberStep)
    if (inspection.kind === 'decision') return inspection.decision
    if (inspection.kind === 'defer') return null
  }
  return waitForPlaybook(`step-join-pending:${join.groupId}`, verdict.settled, deadlineAt)
}

async function decisionFromTarget(
  deps: ReconcileDeps,
  mission: MissionRow,
  snapshot: MissionFactSnapshot,
  stepsById: ReadonlyMap<string, EmployeeStep>,
  target: StepTarget,
  reason: string,
  visited: Set<string>,
): Promise<NextDecision | null> {
  const terminal = failureDecision(target, reason)
  if (terminal !== null) return terminal
  if (target === 'reconcile' || target === 'complete') return null
  if (visited.has(target)) return { kind: 'block', reason: `step-runtime-cycle:${target}` }
  const step = stepsById.get(target)
  if (step === undefined) return { kind: 'block', reason: `step-target-missing:${target}` }
  const inspection = await inspectStep(deps, mission, snapshot, step)
  if (inspection.kind === 'decision') return inspection.decision
  if (inspection.kind === 'defer') return null
  if (inspection.kind === 'unavailable') {
    return waitForPlaybook(`step-target-not-ready:${target}`, 0)
  }
  const nextVisited = new Set([...visited, target])
  if (inspection.kind === 'failed') {
    return await decisionFromTarget(
      deps,
      mission,
      snapshot,
      stepsById,
      failureTarget(step, inspection.run),
      `step-failed:${target}:${inspection.run.failureCode ?? 'failed'}`,
      nextVisited,
    )
  }
  return await decisionAfterSucceededStep(
    deps,
    mission,
    snapshot,
    stepsById,
    step,
    inspection.run,
    nextVisited,
  )
}

/** Overlay the policy decision only when a published business step is ready. */
export async function selectPlaybookStepDecision(
  deps: ReconcileDeps,
  mission: MissionRow,
  snapshot: MissionFactSnapshot,
): Promise<NextDecision | null> {
  const store = deps.ports.playbookSaga
  if (store === undefined || mission.employeeId === null || mission.employeeRevision === null)
    return null
  const employee = await employeeContent(deps, mission)
  const steps = employee?.steps ?? []
  if (employee === null) return null
  const stepsById = new Map(steps.map((step) => [step.stepId, step]))
  const producerSelection = problemProducerDecision(deps, mission, snapshot, employee)
  if (producerSelection.kind === 'decision') return producerSelection.decision
  const handlerDecision = await problemHandlerDecision(deps, mission, snapshot, employee, stepsById)
  if (handlerDecision !== null) return handlerDecision
  if (steps.length === 0) return null

  // A referenced step is entered only through its published success/failure,
  // join or verification edge. Scanning every row as an independent entry
  // would execute a failure-recovery step after a successful predecessor and
  // would make `complete` indistinguishable from fall-through. Unreferenced
  // roots remain independent trigger-driven duties (for example MR feedback
  // and pipeline repair).
  const referenced = new Set<string>()
  const addTarget = (target: StepTarget): void => {
    if (!['reconcile', 'complete', 'block', 'handoff'].includes(target)) referenced.add(target)
  }
  for (const step of steps) {
    addTarget(step.onSuccess)
    addTarget(step.onFailure.onExhausted)
    if (step.onFailure.onRejected !== null) addTarget(step.onFailure.onRejected)
    if (step.onFailure.onExpired !== null) addTarget(step.onFailure.onExpired)
    if (step.join !== null) {
      addTarget(step.join.onDeadline)
      addTarget(step.join.onPartial)
      for (const member of step.join.memberStepIds) {
        if (member !== step.stepId) referenced.add(member)
      }
    }
  }
  for (const handler of employee.problemHandlers ?? []) {
    for (const verifyStepId of handler.verifyStepIds) referenced.add(verifyStepId)
  }
  const roots = steps.filter((step) => !referenced.has(step.stepId))
  if (roots.length === 0) return { kind: 'block', reason: 'step-root-missing' }

  for (const step of roots) {
    const inspection = await inspectStep(deps, mission, snapshot, step)
    if (inspection.kind === 'decision') return inspection.decision
    if (inspection.kind === 'defer') return null
    if (inspection.kind === 'unavailable') continue
    if (inspection.kind === 'failed') {
      const decision = await decisionFromTarget(
        deps,
        mission,
        snapshot,
        stepsById,
        failureTarget(step, inspection.run),
        `step-failed:${step.stepId}:${inspection.run.failureCode ?? 'failed'}`,
        new Set([step.stepId]),
      )
      if (decision !== null) return decision
      continue
    }
    const decision = await decisionAfterSucceededStep(
      deps,
      mission,
      snapshot,
      stepsById,
      step,
      inspection.run,
      new Set([step.stepId]),
    )
    if (decision !== null) return decision
  }
  return null
}

export async function handleChildMissionDecision(
  deps: ReconcileDeps,
  mission: MissionRow,
  selected: Extract<NextDecision, { kind: 'invoke-child-mission' }>,
  decisionId: string,
): Promise<Handled> {
  const store = deps.ports.playbookSaga
  const port = deps.ports.childMissions
  if (store === undefined || port === undefined) return 'blocked'
  const intent = childMissionIntentSchema.parse({
    parentMissionRef: `${mission.id}@${mission.revision}`,
    parentStepRunRef: selected.stepRunRef,
    targetRepositoryRef: selected.targetRepositoryRef,
    targetEmployeeRef: selected.targetEmployeeRef,
    inputEnvelopeRef: selected.inputEnvelopeRef,
    completion: selected.completion,
    deadlineAt: selected.deadlineAt,
    idempotencyKey: selected.idempotencyKey,
    ancestry: selected.ancestry,
  })
  const claimed = store.claimMissionLink({
    id: ulid(),
    parentMissionId: mission.id,
    parentStepRunId: selected.stepRunRef,
    targetRepositoryId: selected.targetRepositoryRef,
    targetEmployeeId: selected.targetEmployeeRef.id,
    targetEmployeeRevision: selected.targetEmployeeRef.revision,
    inputDigest: canonicalDigest({ inputEnvelopeRef: selected.inputEnvelopeRef }),
    idempotencyKey: selected.idempotencyKey,
    completion: selected.completion,
    now: deps.now(),
  })
  const expectedIntentDigest = receiptDigest(intent)
  let received: Awaited<ReturnType<typeof port.createOrAdopt>>
  try {
    received =
      claimed.row.childMissionId === null
        ? await port.createOrAdopt(intent)
        : await port.observe({
            childMissionRef: claimed.row.childMissionId,
            completion: selected.completion,
            intentDigest: expectedIntentDigest,
          })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'child-mission-port-failed'
    store.updateStepRun({
      id: selected.stepRunRef,
      from: ['claimed', 'running', 'waiting'],
      state: 'failed',
      decisionId,
      failureCategory: message.startsWith('child-mission-') ? 'business-failure' : 'transient',
      failureCode: message.slice(0, 200),
      now: deps.now(),
    })
    return 'collected'
  }
  const parsed = childMissionReceiptSchema.safeParse(received)
  const receipt = parsed.success ? parsed.data : null
  if (
    receipt === null ||
    receipt.intentDigest !== expectedIntentDigest ||
    (claimed.row.childMissionId !== null && receipt.childMissionRef !== claimed.row.childMissionId)
  ) {
    store.updateStepRun({
      id: selected.stepRunRef,
      from: ['claimed', 'running', 'waiting'],
      state: 'failed',
      decisionId,
      failureCategory: 'contract-violation',
      failureCode: !parsed.success
        ? 'child-receipt-invalid'
        : claimed.row.childMissionId !== null &&
            parsed.data.childMissionRef !== claimed.row.childMissionId
          ? 'child-mission-ref-mismatch'
          : 'child-intent-digest-mismatch',
      now: deps.now(),
    })
    return 'collected'
  }
  store.observeMissionLink({
    id: claimed.row.id,
    childMissionId: receipt.childMissionRef,
    childRevision: receipt.childRevision,
    status: receipt.observedStatus,
    completionSatisfied: receipt.completionSatisfied,
    outputRef: receipt.outputEnvelopeRef,
    observedAt: Date.parse(receipt.observedAt),
  })
  if (receipt.completionSatisfied) {
    store.updateStepRun({
      id: selected.stepRunRef,
      from: ['claimed', 'running', 'waiting'],
      state: 'succeeded',
      decisionId,
      outputRef: receipt.outputEnvelopeRef ?? `child-mission:${receipt.childMissionRef}`,
      outputRevision: String(receipt.childRevision),
      now: deps.now(),
    })
    return 'collected'
  }
  const terminalFailure = ['blocked', 'handoff', 'canceled', 'closed-unmerged'].includes(
    receipt.observedStatus,
  )
  if (terminalFailure || deps.now() >= Date.parse(selected.deadlineAt)) {
    store.updateStepRun({
      id: selected.stepRunRef,
      from: ['claimed', 'running', 'waiting'],
      state: 'failed',
      decisionId,
      failureCategory: 'business-failure',
      failureCode: terminalFailure ? `child-${receipt.observedStatus}` : 'child-deadline',
      now: deps.now(),
    })
    return 'collected'
  }
  store.updateStepRun({
    id: selected.stepRunRef,
    from: ['claimed', 'running', 'waiting'],
    state: 'waiting',
    decisionId,
    outputRevision: String(receipt.childRevision),
    now: deps.now(),
  })
  deps.store.armWake({
    id: ulid(),
    missionId: mission.id,
    decisionId,
    reason: `child-mission:${receipt.childMissionRef}`,
    resumeAt: Math.min(Date.parse(selected.deadlineAt), deps.now() + 30_000),
    wakeSources: ['webhook', 'timer', 'manual'],
    attemptOrdinal: receipt.childRevision,
    now: deps.now(),
  })
  return 'wake-armed'
}

function receiptDigest(value: unknown): string {
  return canonicalDigest(value)
}

export async function handleApprovalSubmitDecision(
  deps: ReconcileDeps,
  mission: MissionRow,
  selected: Extract<NextDecision, { kind: 'submit-approval' }>,
  decisionId: string,
): Promise<Handled> {
  const store = deps.ports.playbookSaga
  const gateway = deps.ports.approvalGateway
  if (store === undefined || gateway === undefined) return 'blocked'
  const submitIntent = {
    stepRunRef: selected.stepRunRef,
    adapterRef: selected.adapterRef,
    validatedDraftRef: selected.validatedDraftRef,
    deadlineAt: selected.deadlineAt,
    idempotencyKey: selected.idempotencyKey,
  }
  const submitIntentDigest = canonicalDigest(submitIntent)
  const claimed = store.claimApprovalSaga({
    id: ulid(),
    missionId: mission.id,
    stepRunId: selected.stepRunRef,
    adapterId: selected.adapterRef.id,
    adapterRevision: selected.adapterRef.revision,
    draftRef: selected.validatedDraftRef,
    submitIntentDigest,
    idempotencyKey: selected.idempotencyKey,
    deadlineAt: Date.parse(selected.deadlineAt),
    now: deps.now(),
  })
  let receipt =
    claimed.row.correlationRef === null
      ? null
      : {
          intentDigest: submitIntentDigest,
          correlationRef: claimed.row.correlationRef,
          externalRequestRef: claimed.row.externalRequestRef!,
          submittedRevision: claimed.row.submittedRevision!,
          submittedAt: new Date(claimed.row.updatedAt ?? deps.now()).toISOString(),
        }
  if (receipt === null) {
    const submitted = await gateway.submit(submitIntent)
    if (submitted.ok && submitted.receipt.intentDigest === submitIntentDigest) {
      receipt = submitted.receipt
    } else {
      const submitFailure = submitted.ok
        ? { category: 'contract-violation', code: 'approval-intent-digest-mismatch' }
        : submitted.failure
      receipt = await gateway.lookupByIdempotencyKey({
        adapterRef: selected.adapterRef,
        idempotencyKey: selected.idempotencyKey,
      })
      if (receipt?.intentDigest !== submitIntentDigest) receipt = null
      if (receipt === null) {
        store.updateStepRun({
          id: selected.stepRunRef,
          from: ['claimed', 'running', 'waiting'],
          state: 'failed',
          decisionId,
          failureCategory: submitFailure.category,
          failureCode: submitFailure.code,
          now: deps.now(),
        })
        return 'collected'
      }
    }
    store.recordApprovalSubmitted({
      id: claimed.row.id,
      correlationRef: receipt.correlationRef,
      externalRequestRef: receipt.externalRequestRef,
      submittedRevision: receipt.submittedRevision,
      now: deps.now(),
    })
  }
  store.updateStepRun({
    id: selected.stepRunRef,
    from: ['claimed', 'running', 'waiting'],
    state: 'succeeded',
    decisionId,
    outputRef: `approval-saga:${claimed.row.id}`,
    outputRevision: receipt.submittedRevision,
    now: deps.now(),
  })
  return 'collected'
}

export async function handleApprovalObserveDecision(
  deps: ReconcileDeps,
  mission: MissionRow,
  selected: Extract<NextDecision, { kind: 'observe-approval' }>,
  decisionId: string,
): Promise<Handled> {
  const store = deps.ports.playbookSaga
  const gateway = deps.ports.approvalGateway
  const saga = store?.getApprovalSaga(selected.approvalSagaRef) ?? null
  if (
    store === undefined ||
    gateway === undefined ||
    saga === null ||
    saga.correlationRef === null
  ) {
    return 'blocked'
  }
  const observed = await gateway.observe({
    adapterRef: { id: saga.adapterId, revision: saga.adapterRevision },
    correlationRef: saga.correlationRef,
  })
  if (!observed.ok) {
    store.updateStepRun({
      id: selected.stepRunRef,
      from: ['claimed', 'running', 'waiting'],
      state: 'failed',
      decisionId,
      failureCategory: observed.failure.category,
      failureCode: observed.failure.code,
      now: deps.now(),
    })
    return 'collected'
  }
  const receipt = observed.receipt
  if (receipt.correlationRef !== saga.correlationRef) {
    store.updateStepRun({
      id: selected.stepRunRef,
      from: ['claimed', 'running', 'waiting'],
      state: 'failed',
      decisionId,
      failureCategory: 'contract-violation',
      failureCode: 'approval-correlation-ref-mismatch',
      now: deps.now(),
    })
    return 'collected'
  }
  const pending = receipt.status === 'pending' && deps.now() < saga.deadlineAt
  const effectiveStatus = receipt.status === 'pending' && !pending ? 'expired' : receipt.status
  store.recordApprovalObservation({
    id: saga.id,
    status: effectiveStatus,
    observedRevision: receipt.observedRevision,
    evidenceRef: receipt.evidenceRef,
    nextObserveAt: pending ? deps.now() + selected.pollIntervalMs : null,
    now: deps.now(),
  })
  if (pending) {
    store.updateStepRun({
      id: selected.stepRunRef,
      from: ['claimed', 'running', 'waiting'],
      state: 'waiting',
      decisionId,
      outputRevision: receipt.observedRevision,
      now: deps.now(),
    })
    deps.store.armWake({
      id: ulid(),
      missionId: mission.id,
      decisionId,
      reason: `approval:${saga.correlationRef}`,
      resumeAt: Math.min(saga.deadlineAt, deps.now() + selected.pollIntervalMs),
      wakeSources: ['webhook', 'timer', 'manual'],
      attemptOrdinal: saga.attemptOrdinal + 1,
      now: deps.now(),
    })
    return 'wake-armed'
  }
  const approved = effectiveStatus === 'approved'
  store.updateStepRun({
    id: selected.stepRunRef,
    from: ['claimed', 'running', 'waiting'],
    state: approved ? 'succeeded' : 'failed',
    decisionId,
    outputRef: receipt.evidenceRef,
    outputRevision: receipt.observedRevision,
    ...(approved
      ? {}
      : { failureCategory: 'business-failure', failureCode: `approval-${effectiveStatus}` }),
    now: deps.now(),
  })
  return 'collected'
}

export function settlePlaybookDecision(
  deps: ReconcileDeps,
  selected: NextDecision,
  decisionId: string,
  handled: Handled,
): void {
  const store = deps.ports.playbookSaga
  if (store === undefined || !('stepRunRef' in selected) || selected.stepRunRef === undefined)
    return
  if (
    selected.kind === 'invoke-child-mission' ||
    selected.kind === 'submit-approval' ||
    selected.kind === 'observe-approval'
  ) {
    return
  }
  if (selected.kind === 'run-agent-action' && handled === 'action-launched') {
    const mission = store.getStepRun(selected.stepRunRef)
    const current = mission === null ? null : deps.store.getMission(mission.missionId)
    store.updateStepRun({
      id: selected.stepRunRef,
      from: ['claimed', 'running'],
      state: 'running',
      decisionId,
      actionRunId: current?.currentActionRunId ?? null,
      now: deps.now(),
    })
    return
  }
  if (handled === 'blocked' || handled === 'action-launch-failed') {
    store.updateStepRun({
      id: selected.stepRunRef,
      from: ['claimed', 'running', 'waiting'],
      state: 'failed',
      decisionId,
      failureCategory: 'configuration',
      failureCode: `decision-${handled}`,
      now: deps.now(),
    })
    return
  }
  if (handled === 'wake-armed') {
    store.updateStepRun({
      id: selected.stepRunRef,
      from: ['claimed', 'running', 'waiting'],
      state: 'waiting',
      decisionId,
      now: deps.now(),
    })
    return
  }
  if (
    handled === 'collected' ||
    handled === 'placement-done' ||
    handled === 'readiness-published'
  ) {
    const row = store.getStepRun(selected.stepRunRef)
    const mission = row === null ? null : deps.store.getMission(row.missionId)
    const outputRef =
      mission === null
        ? `decision:${decisionId}`
        : selected.kind === 'materialize-direct-requirement' ||
            selected.kind === 'collect-external-requirement'
          ? (mission.requirementBundleRef ?? `decision:${decisionId}`)
          : selected.kind === 'collect-repository-facts' || selected.kind === 'collect-mr-facts'
            ? (mission.repositoryFactsRef ?? `decision:${decisionId}`)
            : selected.kind === 'ensure-merge-request'
              ? mission.mrClaimId === null
                ? `decision:${decisionId}`
                : `mr-claim:${mission.mrClaimId}`
              : selected.kind === 'publish-readiness'
                ? `readiness:${canonicalDigest(mission.readinessJson ?? 'unavailable')}`
                : `decision:${decisionId}`
    store.updateStepRun({
      id: selected.stepRunRef,
      from: ['claimed', 'running', 'waiting'],
      state: 'succeeded',
      decisionId,
      outputRef,
      outputRevision: mission === null ? null : String(mission.revision),
      now: deps.now(),
    })
  }
}

export function settlePlaybookAction(
  deps: ReconcileDeps,
  actionRunId: string,
  result:
    | { readonly kind: 'action-collected'; readonly disposition: string }
    | { readonly kind: 'action-failed'; readonly blockCode: string },
): void {
  const store = deps.ports.playbookSaga
  const step = store?.findStepRunByAction(actionRunId) ?? null
  if (store === undefined || step === null) return
  const action = deps.store.getActionRun(actionRunId)
  const waiting = result.kind === 'action-collected' && result.disposition === 'needs-information'
  const successful =
    result.kind === 'action-collected' &&
    result.disposition !== 'agent-blocked' &&
    result.disposition !== 'needs-information'
  store.updateStepRun({
    id: step.id,
    from: ['claimed', 'running', 'waiting'],
    state: waiting ? 'waiting' : successful ? 'succeeded' : 'failed',
    // A completed read-only/no-change capability can legitimately have no
    // candidate artifact. Keep a durable opaque action receipt so a following
    // step-output mapping still has an exact producer result to reference.
    outputRef: action?.resultRef ?? (successful ? `action-run:${actionRunId}` : null),
    outputRevision: action?.resultRef ?? String(deps.now()),
    ...(successful || waiting
      ? {}
      : {
          failureCategory: 'business-failure',
          failureCode: result.kind === 'action-failed' ? result.blockCode : result.disposition,
        }),
    now: deps.now(),
  })
}
