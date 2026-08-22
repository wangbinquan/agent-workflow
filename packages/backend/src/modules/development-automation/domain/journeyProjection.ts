// RFC-310 PR-13 — server-owned, business-facing next-action projection.
//
// A page must not reverse-engineer the workflow from a bag of status fields.
// These pure projectors turn committed setup/Mission facts into one closed
// current/next/owner contract. The canonical digest lets HTTP, WS and browser
// refreshes agree on the exact projection they are presenting.

import { z } from 'zod'

import { canonicalDigest } from './canonicalJson'

export const journeyOwnerSchema = z.enum([
  'current-user',
  'committer',
  'platform',
  'digital-employee',
  'external-system',
])

export const journeyStepStateSchema = z.enum([
  'done',
  'current',
  'next',
  'pending',
  'blocked',
  'skipped',
])

export const journeyProjectionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    journey: z.enum(['employee-setup', 'mission-delivery']),
    current: z
      .object({
        key: z.string().min(1),
        ordinal: z.number().int().positive(),
        total: z.number().int().positive(),
        detailKey: z.string().min(1),
      })
      .strict(),
    next: z
      .object({
        key: z.string().min(1),
        kind: z.enum([
          'navigate',
          'command',
          'form',
          'automatic-wake',
          'external-human',
          'complete',
        ]),
        detailKey: z.string().min(1),
        owner: journeyOwnerSchema,
        href: z.string().min(1).nullable(),
        command: z.string().min(1).nullable(),
        available: z.boolean(),
        unavailableReason: z.string().min(1).nullable(),
        wake: z
          .object({
            source: z
              .enum(['webhook', 'timer', 'child-mission', 'approval', 'mr-facts'])
              .nullable(),
            resumeAt: z.number().int().nonnegative().nullable(),
            deadlineAt: z.number().int().nonnegative().nullable(),
            descriptionKey: z.string().min(1).nullable(),
          })
          .strict(),
      })
      .strict(),
    steps: z.array(
      z
        .object({
          key: z.string().min(1),
          state: journeyStepStateSchema,
          owner: journeyOwnerSchema,
          href: z.string().min(1).nullable(),
        })
        .strict(),
    ),
    reasonRefs: z.array(z.string().min(1)),
    projectionRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export type JourneyProjectionV1 = z.infer<typeof journeyProjectionV1Schema>
export type JourneyOwner = z.infer<typeof journeyOwnerSchema>
export type JourneyStepState = z.infer<typeof journeyStepStateSchema>

type JourneyWithoutRevision = Omit<JourneyProjectionV1, 'projectionRevision'>

function finalizeJourney(core: JourneyWithoutRevision): JourneyProjectionV1 {
  return journeyProjectionV1Schema.parse({
    ...core,
    projectionRevision: canonicalDigest(core),
  })
}

function wake(input?: {
  source?: JourneyProjectionV1['next']['wake']['source']
  resumeAt?: number | null
  deadlineAt?: number | null
  descriptionKey?: string | null
}): JourneyProjectionV1['next']['wake'] {
  return {
    source: input?.source ?? null,
    resumeAt: input?.resumeAt ?? null,
    deadlineAt: input?.deadlineAt ?? null,
    descriptionKey: input?.descriptionKey ?? null,
  }
}

export interface EmployeeSetupJourneyInput {
  readonly employee: {
    readonly id: string
    readonly publishedRevision: number | null
    readonly archived: boolean
    readonly hasAssignment: boolean
  } | null
  readonly canCreate: boolean
  readonly canUpdate: boolean
  readonly canAssign: boolean
  readonly canLaunch: boolean
  readonly readyToPublish?: boolean
}

export function projectEmployeeSetupJourney(input: EmployeeSetupJourneyInput): JourneyProjectionV1 {
  const employeeHref =
    input.employee === null
      ? null
      : `/code/config/employees/${encodeURIComponent(input.employee.id)}`
  const stages = ['define', 'publish', 'assign', 'launch'] as const
  let currentIndex = 0
  let next: JourneyProjectionV1['next']
  const reasonRefs: string[] = []

  if (input.employee === null) {
    next = {
      key: 'createEmployee',
      kind: 'navigate',
      detailKey: 'createEmployeeDetail',
      owner: 'current-user',
      href: '/code/config/employees?create=1',
      command: null,
      available: input.canCreate,
      unavailableReason: input.canCreate ? null : 'digital-employees:create',
      wake: wake(),
    }
    reasonRefs.push('employee-missing')
  } else if (input.employee.archived) {
    next = {
      key: 'employeeArchived',
      kind: 'complete',
      detailKey: 'employeeArchivedDetail',
      owner: 'current-user',
      href: '/code/config/employees?create=1',
      command: null,
      available: input.canCreate,
      unavailableReason: input.canCreate ? null : 'digital-employees:create',
      wake: wake(),
    }
    reasonRefs.push('employee-archived')
  } else if (input.employee.publishedRevision === null) {
    currentIndex = 1
    next =
      input.readyToPublish === true
        ? {
            key: 'publishEmployee',
            kind: 'command',
            detailKey: 'publishEmployeeDetail',
            owner: 'current-user',
            href: employeeHref,
            command: 'publish-employee',
            available: input.canUpdate,
            unavailableReason: input.canUpdate ? null : 'digital-employees:update',
            wake: wake(),
          }
        : {
            key: 'configureAndPublish',
            kind: 'form',
            detailKey: 'configureAndPublishDetail',
            owner: 'current-user',
            href: employeeHref,
            command: 'open-employee-editor',
            available: input.canUpdate,
            unavailableReason: input.canUpdate ? null : 'digital-employees:update',
            wake: wake(),
          }
    reasonRefs.push('employee-unpublished')
  } else if (!input.employee.hasAssignment) {
    currentIndex = 2
    next = {
      key: 'assignRepository',
      kind: 'navigate',
      detailKey: 'assignRepositoryDetail',
      owner: 'current-user',
      href: `/code/assignments?employee=${encodeURIComponent(input.employee.id)}&create=1`,
      command: null,
      available: input.canAssign,
      unavailableReason: input.canAssign ? null : 'repository-employee-assignments:update',
      wake: wake(),
    }
    reasonRefs.push('employee-assignment-missing')
  } else {
    currentIndex = 3
    next = {
      key: 'launchFirstMission',
      kind: 'navigate',
      detailKey: 'launchFirstMissionDetail',
      owner: 'current-user',
      href: `/code/missions/new?employee=${encodeURIComponent(input.employee.id)}`,
      command: null,
      available: input.canLaunch,
      unavailableReason: input.canLaunch ? null : 'development-missions:launch',
      wake: wake(),
    }
  }

  return finalizeJourney({
    schemaVersion: 1,
    journey: 'employee-setup',
    current: {
      key: stages[currentIndex]!,
      ordinal: currentIndex + 1,
      total: stages.length,
      detailKey: `setup${stages[currentIndex]![0]!.toUpperCase()}${stages[currentIndex]!.slice(1)}Detail`,
    },
    next,
    steps: stages.map((key, index) => ({
      key,
      state:
        index < currentIndex
          ? 'done'
          : index === currentIndex
            ? 'current'
            : index === currentIndex + 1
              ? 'next'
              : 'pending',
      owner: 'current-user',
      href:
        key === 'define' || key === 'publish'
          ? (employeeHref ?? '/code/config/employees?create=1')
          : key === 'assign'
            ? input.employee === null
              ? null
              : `/code/assignments?employee=${encodeURIComponent(input.employee.id)}`
            : input.employee === null
              ? null
              : `/code/missions/new?employee=${encodeURIComponent(input.employee.id)}`,
    })),
    reasonRefs,
  })
}

export interface MissionJourneyInput {
  readonly missionId: string
  readonly status: string
  readonly automationMode: string
  readonly transitionFence: string
  readonly blockCode: string | null
  readonly hasQuestions: boolean
  readonly hasMergeRequest: boolean
  readonly mergeRequestHref: string | null
  readonly canInteract: boolean
  readonly canRetry: boolean
  readonly canAttach: boolean
  readonly canResume: boolean
  readonly collaboration?:
    | {
        readonly kind: 'child-mission'
        readonly href: string
        readonly resumeAt: number | null
        readonly deadlineAt: number | null
      }
    | {
        readonly kind: 'approval'
        readonly href: string | null
        readonly resumeAt: number | null
        readonly deadlineAt: number | null
        readonly needsHuman: boolean
      }
    | null
}

const MISSION_STAGES = ['intake', 'develop', 'publish', 'care', 'merged'] as const

function missionStageIndex(status: string): number {
  if (status === 'merged' || status === 'completed-no-change') return 4
  if (
    status === 'watching' ||
    status === 'ready-to-merge' ||
    status === 'waiting-committer' ||
    status === 'closed-unmerged'
  ) {
    return 3
  }
  if (status === 'publishing') return 2
  if (status === 'working') return 1
  return 0
}

export function projectMissionJourney(input: MissionJourneyInput): JourneyProjectionV1 {
  const index = missionStageIndex(input.status)
  const detailHref = `/code/missions/${encodeURIComponent(input.missionId)}`
  const reasonRefs = [
    ...(input.blockCode === null ? [] : [input.blockCode]),
    ...(input.transitionFence === 'none' ? [] : [input.transitionFence]),
  ]
  let next: JourneyProjectionV1['next']

  if (input.status === 'merged' || input.status === 'completed-no-change') {
    next = {
      key: input.status === 'merged' ? 'viewOutcome' : 'viewNoChangeOutcome',
      kind: 'complete',
      detailKey: 'terminalCompleteDetail',
      owner: 'platform',
      href: '/digital-employees',
      command: null,
      available: true,
      unavailableReason: null,
      wake: wake(),
    }
  } else if (input.status === 'closed-unmerged' || input.status === 'canceled') {
    next = {
      key: 'launchAnotherMission',
      kind: 'navigate',
      detailKey: 'terminalStoppedDetail',
      owner: 'current-user',
      href: '/code/missions/new',
      command: null,
      available: true,
      unavailableReason: null,
      wake: wake(),
    }
  } else if (input.transitionFence !== 'none') {
    next = {
      key: 'settleTransition',
      kind: 'automatic-wake',
      detailKey: 'settleTransitionDetail',
      owner: 'platform',
      href: detailHref,
      command: null,
      available: true,
      unavailableReason: null,
      wake: wake({ source: 'timer', descriptionKey: 'settleTransitionWake' }),
    }
  } else if (input.hasQuestions || input.status === 'awaiting-information') {
    next = {
      key: 'answerQuestions',
      kind: 'form',
      detailKey: 'answerQuestionsDetail',
      owner: 'current-user',
      href: `${detailHref}#mission-questions`,
      command: 'submit-answers',
      available: input.canInteract,
      unavailableReason: input.canInteract ? null : 'development-missions:interact',
      wake: wake(),
    }
  } else if (input.collaboration?.kind === 'child-mission') {
    next = {
      key: 'waitChildMission',
      kind: 'automatic-wake',
      detailKey: 'waitChildMissionDetail',
      owner: 'digital-employee',
      href: input.collaboration.href,
      command: null,
      available: true,
      unavailableReason: null,
      wake: wake({
        source: 'child-mission',
        resumeAt: input.collaboration.resumeAt,
        deadlineAt: input.collaboration.deadlineAt,
        descriptionKey: 'waitChildMissionWake',
      }),
    }
  } else if (input.collaboration?.kind === 'approval') {
    next = {
      key: input.collaboration.needsHuman ? 'openApproval' : 'waitApproval',
      kind: input.collaboration.needsHuman ? 'external-human' : 'automatic-wake',
      detailKey: input.collaboration.needsHuman ? 'openApprovalDetail' : 'waitApprovalDetail',
      owner: input.collaboration.needsHuman ? 'committer' : 'external-system',
      href: input.collaboration.href,
      command: null,
      available: true,
      unavailableReason: null,
      wake: wake({
        source: 'approval',
        resumeAt: input.collaboration.resumeAt,
        deadlineAt: input.collaboration.deadlineAt,
        descriptionKey: 'waitApprovalWake',
      }),
    }
  } else if (input.status === 'blocked' || input.status === 'failed') {
    next = {
      key: 'retryMission',
      kind: 'command',
      detailKey: 'retryMissionDetail',
      owner: 'current-user',
      href: detailHref,
      command: 'retry',
      available: input.canRetry,
      unavailableReason: input.canRetry ? null : 'development-missions:retry',
      wake: wake(),
    }
  } else if (input.automationMode === 'tracking-only' && !input.hasMergeRequest) {
    next = {
      key: 'attachMergeRequest',
      kind: 'form',
      detailKey: 'attachMergeRequestDetail',
      owner: 'current-user',
      href: detailHref,
      command: 'attach-merge-request',
      available: input.canAttach,
      unavailableReason: input.canAttach ? null : 'development-missions:attach',
      wake: wake(),
    }
  } else if (input.automationMode === 'tracking-only') {
    next = {
      key: 'resumeAutomation',
      kind: 'command',
      detailKey: 'resumeAutomationDetail',
      owner: 'current-user',
      href: detailHref,
      command: 'resume',
      available: input.canResume,
      unavailableReason: input.canResume ? null : 'development-missions:resume',
      wake: wake(),
    }
  } else if (input.status === 'ready-to-merge' || input.status === 'waiting-committer') {
    next = {
      key: 'reviewAndMerge',
      kind: 'external-human',
      detailKey: 'reviewAndMergeDetail',
      owner: 'committer',
      href: input.mergeRequestHref,
      command: null,
      available: input.mergeRequestHref !== null,
      unavailableReason: input.mergeRequestHref === null ? 'merge-request-link-unavailable' : null,
      wake: wake({ source: 'mr-facts', descriptionKey: 'waitMergeWake' }),
    }
  } else {
    next = {
      key: input.status === 'watching' ? 'watchMergeRequest' : 'continueAutomatically',
      kind: 'automatic-wake',
      detailKey:
        input.status === 'watching' ? 'watchMergeRequestDetail' : 'continueAutomaticallyDetail',
      owner: 'platform',
      href: detailHref,
      command: null,
      available: true,
      unavailableReason: null,
      wake: wake({
        source: input.status === 'watching' ? 'webhook' : 'timer',
        descriptionKey:
          input.status === 'watching' ? 'watchMergeRequestWake' : 'continueAutomaticallyWake',
      }),
    }
  }

  return finalizeJourney({
    schemaVersion: 1,
    journey: 'mission-delivery',
    current: {
      key: MISSION_STAGES[index]!,
      ordinal: index + 1,
      total: MISSION_STAGES.length,
      detailKey: `mission${MISSION_STAGES[index]![0]!.toUpperCase()}${MISSION_STAGES[index]!.slice(1)}Detail`,
    },
    next,
    steps: MISSION_STAGES.map((key, stepIndex) => ({
      key,
      state:
        input.status === 'blocked' && stepIndex === index
          ? 'blocked'
          : stepIndex < index
            ? 'done'
            : stepIndex === index
              ? 'current'
              : stepIndex === index + 1
                ? 'next'
                : 'pending',
      owner: key === 'merged' ? 'committer' : 'platform',
      href: detailHref,
    })),
    reasonRefs,
  })
}
