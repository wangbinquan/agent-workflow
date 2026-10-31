import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { DigitalEmployeeWriterInstallation as ImportedDigitalEmployeeWriterInstallation } from '@/modules/digital-employee/composition'
// RFC-383: one digital-employee module and its satellites per provider session.
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
import { composeDigitalEmployeeBuiltinToolCatalog } from '@/modules/digital-employee/composition'
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
import {
  ensureDigitalEmployeeAgentTemplates,
  DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS,
  digitalEmployeeBuiltinAgentSuccessorId,
  digitalEmployeeBuiltinToolConfiguration,
  digitalEmployeeAgentToolPresentation,
} from '@/services/digitalEmployeeAgentTemplates'
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
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import type { Logger } from '@/util/log'
import type { SelectedDevelopmentPurposeRoot } from '@/modules/development-automation/composition'
import type { DaemonProviderCore } from './providerCore'
import type { DaemonResourceCatalogModules } from './resourceCatalog'
import type { DaemonRepositoryCredentials } from './repositoryCredentials'
import type { DaemonIntegrationModules } from './integration'
import type { DaemonTaskExecutionModules } from './taskExecution'
import type { selectDevelopmentWorkspaceEffectBinding } from '@/modules/development-automation/composition'
import {
  composeGraphDevelopment,
  createGraphCaseIntake,
  graphEmployeeTypePackage,
  graphEmployeeRuntimeCodec,
  graphExecutionContractRegistrations,
  isGraphPlan,
} from '@/modules/development-automation/composition/graphDevelopment'
import { composeGraphBuiltinResources } from '@/modules/development-automation/composition/graphBuiltinResources'
import { composeBuiltinWorkflowCatalog } from '@/modules/resource-catalog/composition/builtinWorkflowCatalog'
import { createCommittedHumanInputQueries } from '@/modules/collaboration/composition'
import { createEmployeeExecutionArtifactQueries } from '@/modules/task-execution/composition'
import { composeDesignAssistGeneration } from '@/modules/task-execution/composition/designAssistGeneration'
import { composeLocalRepositoryRevisionContent } from '@/modules/source-control/composition/repositoryRevisionContent'
import {
  createGraphDevelopmentArtifactBinding,
  createGraphDevelopmentVerificationBinding,
  graphDevelopmentRequestArtifacts,
} from '@/modules/development-automation/composition/graphDevelopmentBindings'
import { composeBuiltinEmployeeJobs } from '@/modules/digital-employee/composition/builtinJobTemplates'
import { buildGraphDeliveryJobs } from '@/modules/development-automation/composition/graphDeliveryJob'
import {
  composeGraphDeliveryLifecycleTypePackage,
  composeGraphDeliveryLifecycleRuntimeCodec,
} from '@/modules/development-automation/composition/graphDeliveryLifecycle'

type EmployeeOptions = Parameters<typeof composeDigitalEmployee>[0]
type WorkItemsInput = Parameters<typeof composeDevelopmentEmployeePlatformWorkItems>[0]
export interface DaemonDigitalEmployeeInput {
  readonly historyRestrictions: HistoryRestrictionPort
  readonly graphAssist: Parameters<typeof composeDesignAssistGeneration>[0]
  readonly verificationCommands?: Parameters<typeof createGraphDevelopmentVerificationBinding>[0]
  readonly repositoryRevisionContent?: Parameters<typeof composeGraphDevelopment>[0]['content']
  readonly content: Parameters<typeof createCommittedHumanInputQueries>[0]['content']
  readonly writerInstallation: ImportedDigitalEmployeeWriterInstallation
  readonly db: PersistenceDb
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
  }
}

/** RFC-383: the authoring, HTTP, work-start and OS worker all share this passive session graph. */
export function composeDaemonDigitalEmployeeModules(input: DaemonDigitalEmployeeInput) {
  const { db, appHome, resources, repository, integration, taskExecution, log } = input
  const graphDeliveryTypePackage =
    composeGraphDeliveryLifecycleTypePackage(graphEmployeeTypePackage)
  const employeePrograms = input.adapters?.employeePrograms ?? createProgramArtifactStore(appHome)
  const programToolSource = createArtifactProgramToolSource(employeePrograms)
  const executionContracts = composeExecutionContract({
    resources: createExecutionContractResourceAdapter(
      db,
      developmentImplicitAgentContractDeclarations,
    ),
    registrations: [
      ...developmentExecutionContractRegistrations,
      ...graphExecutionContractRegistrations,
    ],
    programFixtures: createExecutionContractProgramFixtureAdapter({
      appHome,
      programs: programToolSource,
      process: input.adapters?.programFixtureProcess,
    }),
  })
  const legacyPlatformTools = composeDigitalEmployeeBuiltinToolCatalog({
    templateHelpers: {
      DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS,
      digitalEmployeeBuiltinAgentSuccessorId,
      digitalEmployeeBuiltinToolConfiguration,
      digitalEmployeeAgentToolPresentation,
    },
    agentTemplates: resources.digitalEmployeeAgentTemplates,
    typePackageDescriptorJsons: async () => [
      ...(await composeDigitalEmployeeBootstrapReadsFor(db).listTypePackageDescriptorJsons()),
      developmentEmployeeTypePackage.descriptorJson,
      graphDeliveryTypePackage.descriptorJson,
    ],
  })
  const graphPlatformTools = composeGraphBuiltinResources({
    agents: resources.digitalEmployeeAgentTemplates,
    workflows: composeBuiltinWorkflowCatalog(db),
  })
  const platformTools: typeof legacyPlatformTools = {
    async load() {
      await ensureDigitalEmployeeAgentTemplates(resources.digitalEmployeeAgentTemplates)
      await legacyPlatformTools.load()
      await graphPlatformTools.load()
    },
    listJson(ref, item) {
      return JSON.stringify([
        ...JSON.parse(legacyPlatformTools.listJson(ref, item)),
        ...JSON.parse(graphPlatformTools.listJson(ref, item)),
      ])
    },
    getRevisionJson(ref) {
      return graphPlatformTools.getRevisionJson(ref) ?? legacyPlatformTools.getRevisionJson(ref)
    },
    isPlatformTool(id) {
      return graphPlatformTools.isPlatformTool(id) || legacyPlatformTools.isPlatformTool(id)
    },
    resolveCompatibleRevisionJson(...args) {
      return legacyPlatformTools.resolveCompatibleRevisionJson?.(...args) ?? null
    },
  }
  const writerCutover = composeDigitalEmployeeWriterCutoverFor(db, input.writerInstallation)
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
  const candidates = {
    ...bindChangeCandidateParticipant({ candidateEffects: input.repositoryCandidateEffects }),
    ...bindCandidateDeliveryParticipant({
      candidateEffects: input.repositoryCandidateEffects,
      publicationTransport: repository.repositoryPublicationTransport,
    }),
  }
  const humanInputs = createCommittedHumanInputQueries({
    db,
    content: input.content,
  })
  const graphArtifacts = createGraphDevelopmentArtifactBinding(appHome, input.evidenceArtifacts)
  const graphCases = createGraphCaseIntake({
    readCase: (caseId) => module.runtime.queries.getCase(caseId),
    owner: (caseId) => module.runtime.queries.getCaseAcl(caseId),
    launchWork: (request) => module.runtime.commands.launchWork(request),
    cancelTask: (taskId) => taskExecution.routes.tasks.cancel(taskId),
    events: integration.eventCenter.participant,
    humanInputs,
    artifacts: graphDevelopmentRequestArtifacts(graphArtifacts),
  })
  const graph = composeGraphDevelopment({
    db,
    appHome,
    cases: graphCases,
    readCase: (caseId) => module.runtime.queries.getCase(caseId),
    artifacts: graphArtifacts,
    rounds: reactionRounds,
    humanInputs,
    executions: createEmployeeExecutionArtifactQueries(db, input.content),
    workspace: {
      factory: input.workspaceEffects.automationWorkspaceEffects,
      sourceControl,
      repositoryPreparation: repository.developmentWorkspaceRepositoryPreparation,
      inputArtifacts: employeeInputArtifacts,
    },
    candidates,
    publication: {
      async remoteUrl(repositoryId) {
        const binding = await repository.developmentDeliveryProvider.resolveRepository(repositoryId)
        if (!binding) throw new Error('graph-publication-repository-missing')
        return binding.remoteUrl
      },
    },
    content: input.repositoryRevisionContent ?? composeLocalRepositoryRevisionContent(),
    verification: createGraphDevelopmentVerificationBinding(input.verificationCommands),
    assist: composeDesignAssistGeneration(input.graphAssist),
    changed: (caseId) => {
      void Promise.all([
        module.runtime.queries.getCaseAcl(caseId),
        module.runtime.queries.listCaseMembers(caseId),
      ])
        .then(([owner, members]) => {
          const visibleUserIds = new Set(members.map((member) => member.userId))
          if (owner?.ownerUserId) visibleUserIds.add(owner.ownerUserId)
          tasksListBroadcaster.broadcast(
            TASKS_LIST_CHANNEL,
            { type: 'employee-case.changed', caseId },
            { kind: 'employee-case.members-changed-audience', caseId, visibleUserIds },
          )
        })
        .catch((error) =>
          log.warn('graph design refresh unavailable', { caseId, error: String(error) }),
        )
    },
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
    graphDelivery: graph.care,
  })
  const reactionExecution = composeReactionExecutionProvider({
    ...composeDatabaseDigitalEmployeeExecutionPorts(
      db,
      input.historyRestrictions,
      composeHumanGateOpenParticipantFactory(),
    ),
    ...taskExecution.hostTasks,
    appHome,
    programs: programToolSource,
    tasks: taskExecution.routes.tasks,
    workspace: {
      prepare: (request) =>
        isGraphPlan(request.planJson)
          ? graph.workspace.prepare(request)
          : employeeWorkspace.prepare(request),
      async validate(request) {
        const frozen = await reactionRounds.frozenPlan(request.roundRef)
        return frozen && isGraphPlan(frozen.planJson)
          ? await graph.workspace.validate(request)
          : await employeeWorkspace.validate(request)
      },
    },
    committedProgress: graph.progress,
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
    graphDelivery: graph.care,
    sourceControl: {
      ...candidates,
      ...sourceControl,
    },
  })
  const caseDetailProjection = composeDevelopmentEmployeeCaseDetailProjection(
    createDevelopmentEmployeeCaseWorkspaceDetailReader(db),
  )
  const module = composeDigitalEmployee({
    db,
    appHome,
    writerCutover,
    programArtifacts: employeePrograms,
    typePackages: [
      developmentEmployeeTypePackage,
      graphEmployeeTypePackage,
      graphDeliveryTypePackage,
    ],
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
      codecs: [
        developmentEmployeeRuntimeCodec,
        composeGraphDeliveryLifecycleRuntimeCodec(graphEmployeeRuntimeCodec),
      ],
      detailProjectionParticipants: [caseDetailProjection, graph.detailProjection],
      reactionExecution,
      platformWorkItems: {
        execute: (plan, context) =>
          isGraphPlan(JSON.stringify(plan))
            ? graph.platformWorkItems.execute(plan, context)
            : employeePlatformWorkItems.execute(plan, context),
      },
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
    graph,
    async initializeGraph() {
      await graph.recover()
      const defaults = ['design-and-clarify', 'review-design', 'implement-change'].map(
        (workItemRef) => {
          const tools = JSON.parse(
            graphPlatformTools.listJson(
              JSON.stringify({ typeId: 'graph-development', revision: 1 }),
              workItemRef,
            ),
          ) as { id: string; publishedRevision: number }[]
          const tool = tools[0]
          if (!tool) throw new Error(`graph-default-tool-missing:${workItemRef}`)
          return {
            workItemRef,
            slotRef: 'default',
            registrationRef: { id: tool.id, revision: tool.publishedRevision },
          }
        },
      )
      await composeBuiltinEmployeeJobs(db, (request) =>
        module.commands.publishJobTemplate(request),
      ).ensure({
        id: 'platform:graph-development:job:v2',
        name: '图驱动研发 v2',
        content: {
          schemaVersion: 1,
          typeRef: { typeId: 'graph-development', revision: 1 },
          description: '自适应视图设计、澄清、批准依据、代码和测试生成与实际验证。',
          defaultToolBindings: defaults,
          defaultAdapterBindings: [],
          defaultCollaborationBindings: [],
          orderedDispatchConfigurations: [],
          reactionLaneOrder: [],
        },
      })
      const mrJobs = buildGraphDeliveryJobs({ catalog: platformTools })
      const builtinJobs = composeBuiltinEmployeeJobs(db, (request) =>
        module.commands.publishJobTemplate(request),
      )
      await builtinJobs.ensure(mrJobs.defaultJob)
      await builtinJobs.ensureDraft(mrJobs.pipelineJobDraft)
    },
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
