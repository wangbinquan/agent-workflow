// RFC-383: one digital-employee module and its satellites per provider session.
import type {
  EmployeeCaseDetailProjectionParticipant,
  DigitalEmployeePlatformToolCatalogParticipant,
} from '@/modules/digital-employee/public/types'
import {
  composeDigitalEmployee,
  createProgramArtifactStore,
  composeDigitalEmployeeWriterCutoverFor,
  createEmployeeReactionRoundQueries,
  createEmployeeInputArtifactStore,
  composeDigitalEmployeePlatformInventoryParticipant,
  composeDigitalEmployeeBootstrapReadsFor,
  composeDigitalEmployeeTaskCatalogSource,
} from '@/modules/digital-employee/composition'
import {
  composeDevelopmentEmployeeWorkspace,
  createDevelopmentEmployeeCaseWorkspaceDetailReader,
} from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import { composeDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { composeDevelopmentEmployeeCaseDetailProjection } from '@/modules/development-automation/composition/employeeCaseDetailProjection'
import {
  composeReactionExecutionProvider,
  composeDatabaseDigitalEmployeeExecutionPorts,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import { composeDigitalEmployeeBuiltinToolCatalog } from '@/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog'
import {
  developmentEmployeeTypePackage,
  developmentEmployeeRuntimeCodec,
  developmentImplicitAgentContractDeclarations,
  developmentExecutionContractRegistrations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import { composeExecutionContract } from '@/modules/execution-contract/composition'
import { createExecutionContractResourceAdapter } from '@/modules/resource-catalog/composition/executionContractResource'
import { createExecutionContractProgramFixtureAdapter } from '@/modules/task-execution/composition/executionContractFixture'
import { createArtifactProgramToolSource } from '@/modules/task-execution/composition/programTools'
import {
  bindEmployeeCaseWorkspaceParticipant,
  bindConflictMergeParticipant,
  bindChangeCandidateParticipant,
  bindCandidateDeliveryParticipant,
} from '@/modules/source-control/composition'
import { buildDevelopmentDeliveryDeps } from '@/services/developmentDeliveryDeps'
import { composeDevelopmentActivityOperations } from '@/modules/development-automation/composition/activityOperations'
import { type DigitalEmployeeWorkStartPort } from '@/modules/integration/public/participants'
import {
  type DigitalEmployeeAclResourceType,
  type DigitalEmployeeRoutePersistence,
} from '@/routes/digitalEmployees'
import { type ProviderResourceCatalogComposition } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import {
  resourceAclAudienceAuthority,
  type updateResourceAcl,
} from '@/modules/resource-catalog/composition/resourceAcl'
import { planMembersReplacement } from '@/modules/collaboration/composition'
import { canManageCaseMembers } from '@/services/employeeCaseMembers'
import { mountAclEndpoints } from '@/routes/resourceAcl'
import { tasksListBroadcaster, TASKS_LIST_CHANNEL } from '@/ws/broadcaster'
import { ValidationError, ForbiddenError } from '@/util/errors'
import { join } from 'node:path'
import { SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { ResourceAcl, UpdateResourceAclBody } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import type { Logger } from '@/util/log'
import type { SelectedDevelopmentPurposeRoot } from '@/server'
import type { DaemonProviderCore } from './providerCore'
import type { DaemonResourceCatalogModules } from './resourceCatalog'
import type { DaemonRepositoryCredentials } from './repositoryCredentials'
import type { DaemonIntegrationModules } from './integration'
import type { DaemonTaskExecutionModules } from './taskExecution'
import type { selectDevelopmentWorkspaceEffectBinding } from '@/modules/development-automation/composition'

type EmployeeOptions = Parameters<typeof composeDigitalEmployee>[0]
type WorkItemsInput = Parameters<typeof composeDevelopmentEmployeePlatformWorkItems>[0]
export interface DaemonDigitalEmployeeInput {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly configuration: ApplicationConfigurationQueries
  readonly log: Pick<Logger, 'info' | 'warn'>
  readonly typePackageDriftPolicy?: EmployeeOptions['typePackageDriftPolicy']
  readonly core: Pick<DaemonProviderCore, 'daemonActor'> &
    Pick<DaemonProviderCore['identityAccess'], 'userDirectory' | 'directAuthority'>
  readonly resources: Pick<
    DaemonResourceCatalogModules,
    'digitalEmployeeAgentTemplates' | 'resourceCatalog' | 'digitalEmployeeAcl'
  >
  readonly repository: Pick<
    DaemonRepositoryCredentials,
    | 'developmentDeliveryProvider'
    | 'repositoryPublicationTransport'
    | 'developmentWorkspaceRepositoryPreparation'
  >
  readonly integration: Pick<
    DaemonIntegrationModules,
    'eventCenter' | 'developmentToolConnections' | 'developmentApprovalGateway'
  >
  readonly taskExecution: Pick<
    DaemonTaskExecutionModules,
    'hostTasks' | 'routes' | 'readModels' | 'resources'
  >
  readonly developmentPurposeRoot: Pick<SelectedDevelopmentPurposeRoot, 'pipeline'>
  readonly workspaceEffects: ReturnType<typeof selectDevelopmentWorkspaceEffectBinding>
  readonly repositoryBaselines?: WorkItemsInput['repositoryBaselines']
  readonly evidenceArtifacts?: WorkItemsInput['evidenceArtifacts']
  readonly repositoryCandidateEffects?: NonNullable<
    Parameters<typeof bindChangeCandidateParticipant>[0]
  >['candidateEffects']
  readonly conflictMergeWorkspaceEffects?: NonNullable<
    Parameters<typeof bindConflictMergeParticipant>[0]
  >['effects']
  readonly adapters?: {
    readonly employeePrograms?: EmployeeOptions['programArtifacts']
    readonly employeeInputArtifacts?: EmployeeOptions['inputArtifacts']
    readonly employeeCaseWorkspaceEffects?: NonNullable<
      Parameters<typeof bindEmployeeCaseWorkspaceParticipant>[0]
    >['effects']
    readonly programFixtureProcess?: Parameters<
      typeof createExecutionContractProgramFixtureAdapter
    >[0]['process']
    /** Existing direct-HTTP fixture overrides; removed with those fallbacks in RFC-386. */
    readonly platformTools?: EmployeeOptions['platformTools'] & { load?(): Promise<void> }
    readonly executionContracts?: ReturnType<typeof composeExecutionContract>
    readonly caseDetailProjection?: EmployeeCaseDetailProjectionParticipant
  }
}

/** RFC-383: the authoring, HTTP, work-start and OS worker all share this passive session graph. */
export function composeDaemonDigitalEmployeeModules(input: DaemonDigitalEmployeeInput) {
  const { db, appHome, resources, repository, integration, taskExecution, log } = input
  const employeePrograms = input.adapters?.employeePrograms ?? createProgramArtifactStore(appHome)
  const programToolSource = createArtifactProgramToolSource(employeePrograms)
  const executionContracts =
    input.adapters?.executionContracts ??
    composeExecutionContract({
      resources: createExecutionContractResourceAdapter(
        db,
        developmentImplicitAgentContractDeclarations,
      ),
      registrations: developmentExecutionContractRegistrations,
      programFixtures: createExecutionContractProgramFixtureAdapter({
        appHome,
        programs: programToolSource,
        process: input.adapters?.programFixtureProcess,
      }),
    })
  const platformTools =
    input.adapters?.platformTools === undefined
      ? composeDigitalEmployeeBuiltinToolCatalog({
          agentTemplates: resources.digitalEmployeeAgentTemplates,
          typePackageDescriptorJsons: async () => [
            ...(await composeDigitalEmployeeBootstrapReadsFor(db).listTypePackageDescriptorJsons()),
            developmentEmployeeTypePackage.descriptorJson,
          ],
        })
      : Object.freeze({
          listJson: (
            ...args: Parameters<DigitalEmployeePlatformToolCatalogParticipant['listJson']>
          ) => input.adapters!.platformTools!.listJson(...args),
          getRevisionJson: (
            ...args: Parameters<DigitalEmployeePlatformToolCatalogParticipant['getRevisionJson']>
          ) => input.adapters!.platformTools!.getRevisionJson(...args),
          resolveCompatibleRevisionJson: (
            ...args: Parameters<
              NonNullable<
                DigitalEmployeePlatformToolCatalogParticipant['resolveCompatibleRevisionJson']
              >
            >
          ) => input.adapters!.platformTools!.resolveCompatibleRevisionJson?.(...args) ?? null,
          isPlatformTool: (id: string) => input.adapters!.platformTools!.isPlatformTool(id),
          load: () => input.adapters!.platformTools!.load?.() ?? Promise.resolve(),
        })
  const writerCutover = composeDigitalEmployeeWriterCutoverFor(db)
  const employeeInputArtifacts =
    input.adapters?.employeeInputArtifacts ??
    createEmployeeInputArtifactStore(join(appHome, 'artifacts', 'employee-inputs'))
  const reactionRounds = createEmployeeReactionRoundQueries(db)
  const conflictMerge = bindConflictMergeParticipant({
    effects: input.conflictMergeWorkspaceEffects,
  })
  const sourceControl = bindEmployeeCaseWorkspaceParticipant({
    publicationTransport: repository.repositoryPublicationTransport,
    effects: input.adapters?.employeeCaseWorkspaceEffects,
  })
  const employeeWorkspace = composeDevelopmentEmployeeWorkspace({
    automationWorkspaceEffects: input.workspaceEffects.automationWorkspaceEffects,
    db,
    appHome,
    reactionRounds,
    inputArtifacts: employeeInputArtifacts,
    repositoryPreparation: repository.developmentWorkspaceRepositoryPreparation,
    sourceControl,
    conflictMerge,
  })
  const reactionExecution = composeReactionExecutionProvider({
    ...composeDatabaseDigitalEmployeeExecutionPorts(db),
    ...taskExecution.hostTasks,
    appHome,
    programs: programToolSource,
    tasks: taskExecution.routes.tasks,
    workspace: employeeWorkspace,
    executionContracts,
  })
  const employeePlatformWorkItems = composeDevelopmentEmployeePlatformWorkItems({
    automationWorkspaceEffects: input.workspaceEffects.automationWorkspaceEffects,
    repositoryBaselines: input.repositoryBaselines,
    evidenceArtifacts: input.evidenceArtifacts,
    db,
    appHome,
    reactionRounds,
    approvalGateway: integration.developmentApprovalGateway,
    ...buildDevelopmentDeliveryDeps(
      repository.developmentDeliveryProvider,
      input.developmentPurposeRoot.pipeline.staging,
    ),
    conflictMerge,
    sourceControl: {
      ...bindChangeCandidateParticipant({ candidateEffects: input.repositoryCandidateEffects }),
      ...bindCandidateDeliveryParticipant({
        candidateEffects: input.repositoryCandidateEffects,
        publicationTransport: repository.repositoryPublicationTransport,
      }),
      ...sourceControl,
    },
  })
  const caseDetailProjection =
    input.adapters?.caseDetailProjection ??
    composeDevelopmentEmployeeCaseDetailProjection(
      createDevelopmentEmployeeCaseWorkspaceDetailReader(db),
    )
  const module = composeDigitalEmployee({
    db,
    appHome,
    writerCutover,
    programArtifacts: employeePrograms,
    typePackages: [developmentEmployeeTypePackage],
    typePackageDriftPolicy: input.typePackageDriftPolicy,
    platformTools,
    executionContracts,
    onAutomaticUpgradeIssue(issue) {
      log.warn('automatic digital employee type upgrade could not prove compatibility', {
        ...issue,
      })
    },
    retryLimits: {
      async current() {
        const current = await input.configuration.read()
        return {
          defaultNodeRetries: current.defaultNodeRetries,
          sessionRestartBudget: current.sessionRestartBudget,
        }
      },
    },
    inputArtifacts: employeeInputArtifacts,
    connectionCatalog: integration.developmentToolConnections,
    runtime: {
      eventCenter: integration.eventCenter.participant,
      codecs: [developmentEmployeeRuntimeCodec],
      detailProjectionParticipants: [caseDetailProjection],
      reactionExecution,
      platformWorkItems: employeePlatformWorkItems,
    },
  })
  const workStart = Object.freeze<DigitalEmployeeWorkStartPort>({
    async launch(request) {
      const result = await module.runtime.commands.launchWork({
        employeeId: request.employeeId,
        intake: request.intake,
        actorUserId: request.actorUserId,
        eventOrigin: request.origin,
      })
      return { caseId: result.caseRef.id }
    },
  })
  const routePersistence = composeDigitalEmployeeRoutePersistence({
    userDirectory: input.core.userDirectory,
    resourceCatalog: resources.resourceCatalog,
    acl: {
      getResourceAcl: (actor, type, row) =>
        resources.digitalEmployeeAcl[type].getResourceAcl(actor, type, row),
      updateResourceAcl: (actor, type, row, body, options) =>
        resources.digitalEmployeeAcl[type].updateResourceAcl(actor, type, row, body, {
          ...(options?.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
        }),
    },
  })
  return Object.freeze({
    module,
    executionContracts,
    platformTools,
    writerCutover,
    workStart,
    taskCatalogSource: composeDigitalEmployeeTaskCatalogSource(module.runtime),
    platformInventory: composeDigitalEmployeePlatformInventoryParticipant({
      queries: module.queries,
      access: resources.resourceCatalog.authorization,
    }),
    caseDetailProjection,
    activityOperations: composeDevelopmentActivityOperations(module.runtime.worker),
    routePersistence,
    reactionExecution,
  })
}
export type DaemonDigitalEmployeeModules = ReturnType<typeof composeDaemonDigitalEmployeeModules>

export function composeDigitalEmployeeRoutePersistence(input: {
  readonly userDirectory: DaemonProviderCore['identityAccess']['userDirectory']
  readonly resourceCatalog: ProviderResourceCatalogComposition
  readonly acl: {
    getResourceAcl(
      actor: Actor,
      type: DigitalEmployeeAclResourceType,
      row: {
        readonly id: string
        readonly ownerUserId?: string | null
        readonly visibility?: 'private' | 'public'
      },
    ): Promise<ResourceAcl>
    updateResourceAcl(
      actor: Actor,
      type: DigitalEmployeeAclResourceType,
      row: {
        readonly id: string
        readonly ownerUserId?: string | null
        readonly visibility?: 'private' | 'public'
      },
      body: UpdateResourceAclBody,
      options?: Parameters<typeof updateResourceAcl>[5],
    ): Promise<ResourceAcl>
  }
}): DigitalEmployeeRoutePersistence {
  async function assertActiveMembers(subject: {
    readonly ownerUserId?: string
    readonly members?: readonly { readonly userId: string }[]
  }): Promise<void> {
    const referenced = new Set((subject.members ?? []).map((member) => member.userId))
    if (subject.ownerUserId !== undefined) referenced.add(subject.ownerUserId)
    if (referenced.size === 0) return
    const people = await input.userDirectory.lookup([...referenced])
    const active = new Set(
      people.filter((person) => person.status === 'active').map((person) => person.id),
    )
    const invalid = [...referenced].filter(
      (userId) => userId === SYSTEM_USER_ID || !active.has(userId),
    )
    if (invalid.length === 0) return
    throw new ValidationError('members-user-invalid', 'referenced user(s) not active', {
      userIds: invalid,
    })
  }

  async function getCaseMembers(
    actor: Parameters<DigitalEmployeeRoutePersistence['getCaseMembers']>[0],
    runtime: Parameters<DigitalEmployeeRoutePersistence['getCaseMembers']>[1],
    row: Parameters<DigitalEmployeeRoutePersistence['getCaseMembers']>[2],
  ): ReturnType<DigitalEmployeeRoutePersistence['getCaseMembers']> {
    const memberRows = await runtime.queries.listCaseMembers(row.id)
    const wanted = [
      ...new Set([
        ...(row.ownerUserId === null ? [] : [row.ownerUserId]),
        ...memberRows.map((member) => member.userId),
      ]),
    ]
    const people = wanted.length === 0 ? [] : await input.userDirectory.lookup(wanted)
    const byId = new Map(people.map((person) => [person.id, person]))
    const owner =
      row.ownerUserId === null || row.ownerUserId === SYSTEM_USER_ID
        ? null
        : (byId.get(row.ownerUserId) ?? null)
    const members = memberRows.flatMap((member) => {
      const user = byId.get(member.userId)
      return user === undefined ? [] : [{ user, role: member.role }]
    })
    const canManage = canManageCaseMembers(actor, row)
    return {
      caseId: row.id,
      ownerUserId: row.ownerUserId,
      owner,
      members,
      canManage,
      canOperate:
        canManage ||
        memberRows.some(
          (member) => member.role === 'collaborator' && member.userId === actor.user.id,
        ),
    }
  }

  return Object.freeze({
    assertNameUnchangedForEditor: input.resourceCatalog.authorization.assertNameUnchangedForEditor,
    adapterVisibilitySubject(actor: Actor) {
      return { userId: actor.user.id, authority: resourceAclAudienceAuthority(actor) }
    },
    projectVisibleRowsWithAccess: (actor, type, rows) =>
      input.resourceCatalog.authorization.projectVisibleRowsWithAccess(actor, type, rows),
    filterVisibleRows: (actor, type, rows) =>
      input.resourceCatalog.authorization.filterVisibleRows(actor, type, rows),
    requireResourceEdit: (actor, type, row) =>
      input.resourceCatalog.authorization.requireResourceEdit(actor, type, row),
    requireResourceGovern: (actor, type, row) =>
      input.resourceCatalog.authorization.requireResourceGovern(actor, type, row),
    getCaseMembers,
    async updateCaseMembers(actor, runtime, row, body) {
      if (!canManageCaseMembers(actor, row)) {
        throw new ForbiddenError(
          'forbidden',
          'only the employee case owner or an actor with resource-acl:bypass can manage members',
        )
      }
      await assertActiveMembers(body)
      const current = await runtime.queries.listCaseMembers(row.id)
      const plan = planMembersReplacement({
        prevOwner: row.ownerUserId,
        requestedOwner: body.ownerUserId,
        requestedMembers: body.members,
        currentMembers: current,
      })
      const committed = await runtime.commands.replaceCaseMembers({
        caseId: row.id,
        ownerUserId: plan.nextOwner,
        members: [...plan.nextMembers].map(([userId, role]) => ({ userId, role })),
        addedBy: actor.user.id,
        now: Date.now(),
      })
      const visibleUserIds = new Set<string>()
      if (committed.previousOwnerUserId !== null) {
        visibleUserIds.add(committed.previousOwnerUserId)
      }
      if (plan.nextOwner !== null) visibleUserIds.add(plan.nextOwner)
      for (const userId of committed.previousMemberUserIds) visibleUserIds.add(userId)
      for (const userId of plan.nextMembers.keys()) visibleUserIds.add(userId)
      tasksListBroadcaster.broadcast(
        TASKS_LIST_CHANNEL,
        { type: 'employee-case.members.changed', caseId: row.id },
        { kind: 'employee-case.members-changed-audience', caseId: row.id, visibleUserIds },
      )
      return await getCaseMembers(actor, runtime, { ...row, ownerUserId: plan.nextOwner })
    },
    assertMembersUsersActive: assertActiveMembers,
    mountAcl({ app, type, base, load, notFoundCode }) {
      mountAclEndpoints(app, {
        type,
        base,
        param: 'id',
        load,
        canView: (actor, row) =>
          input.resourceCatalog.authorization.canViewResource(actor, type, row),
        read: (actor, row) => input.acl.getResourceAcl(actor, type, row),
        update: (actor, row, body, updatedAt) =>
          input.acl.updateResourceAcl(actor, type, row, body, {
            ...(updatedAt === undefined ? {} : { updatedAt }),
          }),
        ...(notFoundCode === undefined ? {} : { notFoundCode }),
      })
    },
  } satisfies DigitalEmployeeRoutePersistence)
}
