import { canonicalJson } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  EmployeeCaseDetailProjectionParticipant,
  EmployeeCaseDetailProjectionInputV1,
  EmployeeReactionRoundQueryPort,
} from '@/modules/digital-employee/public/types'
import type { GraphExecutionFacts, GraphHumanInputFacts } from '../application/ports/graphHostFacts'
import type {
  CandidateDeliveryParticipant,
  ChangeCandidateParticipant,
} from '@/modules/source-control/public/types'
import type { RepositoryRevisionContentFactory } from '@/modules/source-control/public/participants'
import { createGraphDesignCommands } from '../application/graph-development/designCommands'
import { createGraphDesignQueries } from '../application/graph-development/designQueries'
import {
  createGraphViewPlanning,
  graphDesignAssistPrompt,
} from '../application/graph-development/viewPlanning'
import { createGraphExecutionConsumption } from '../application/graph-development/executionConsumption'
import { createGraphVerification } from '../application/graph-development/verification'
import { createGraphLimitationReview } from '../application/graph-development/limitationReview'
import { createGraphPlatformWorkItems } from '../application/graph-development/platformWorkItems'
import { createGraphDeliveryBridge } from '../application/graph-development/deliveryBridge'
import { createGraphDesignExecution } from '../application/graph-development/designExecution'
import {
  createGraphEvidenceAcceptance,
  listGraphVerificationProfileContents,
} from '../application/graph-development/evidenceAcceptance'
import type { GraphDesignCasePort } from '../application/ports/graphDesignExecution'
import type { EvidenceArtifactPort } from '../application/ports/evidenceArtifacts'
import type { VerificationCommandEffectsFactory } from '../application/ports/verificationCommandEffects'
import { createGraphDesignStore } from '../infrastructure/graph-development/designStore'
import { createGraphDesignArtifacts } from '../infrastructure/graph-development/designArtifacts'
import { createGraphEmployeeWorkspace } from '../infrastructure/graph-development/employeeWorkspace'
import { createVerificationProfilePersistence } from '../infrastructure/configResourceStore'
import { GraphEmployeeContextSchema } from '../application/graph-development/employeeCodec'
import {
  GRAPH_CONTEXT_TYPE,
  GRAPH_EMPLOYEE_TYPE,
} from '../application/graph-development/employeeType'
import { mountGraphDesignRoutes } from '../infrastructure/http/graphDesignRoutes'
import type { Hono } from 'hono'
import type { Actor } from '@/auth/actor'
import { createEmployeeWorkspacePersistence } from '../infrastructure/employeeWorkspacePersistence'
import { createEmployeePlatformWorkItemPersistence } from '../infrastructure/employeePlatformWorkItemPersistence'
import { createDevelopmentEmployeeCaseWorkspaceDetailReader } from './digitalEmployeeWorkspace'
import { projectDevelopmentEmployeeCaseDetail } from './employeeCaseDetailProjection'

export { graphEmployeeTypePackage } from '../application/graph-development/employeeType'
export { graphEmployeeRuntimeCodec } from '../application/graph-development/employeeCodec'
export { graphExecutionContractRegistrations } from '../application/graph-development/toolContracts'
export { createGraphCaseIntake } from '../application/graph-development/caseIntake'
export { isGraphPlan } from '../application/graph-development/reactionMaterial'

export function composeGraphDevelopment(input: {
  db: PersistenceDb
  appHome: string
  cases: GraphDesignCasePort
  readCase(caseId: string): Promise<{ projectionJson: string }>
  artifacts: EvidenceArtifactPort
  rounds: EmployeeReactionRoundQueryPort
  humanInputs: GraphHumanInputFacts
  executions: GraphExecutionFacts
  workspace: Omit<
    Parameters<typeof createGraphEmployeeWorkspace>[0],
    | 'appHome'
    | 'store'
    | 'artifacts'
    | 'commands'
    | 'rounds'
    | 'consumeResult'
    | 'verificationProfiles'
  >
  candidates: CandidateDeliveryParticipant & ChangeCandidateParticipant
  publication?: Parameters<typeof createGraphPlatformWorkItems>[0]['publication']
  content: RepositoryRevisionContentFactory
  verification: VerificationCommandEffectsFactory
  assist: {
    generate(input: {
      caseId: string
      requestId: string
      prompt: string
      signal: AbortSignal
    }): Promise<{ invocationRef: string; outputJson: string }>
  }
  changed?: (caseId: string) => void
}) {
  const store = createGraphDesignStore(input.db),
    artifacts = createGraphDesignArtifacts(input.artifacts)
  const profiles = createVerificationProfilePersistence(input.db)
  const execution = createGraphDesignExecution({
    executions: input.executions,
    readCase: input.readCase,
    artifacts,
    humanSources: (caseId, sources) => consumption.humanSources(caseId, sources),
    reviewReceipt: (request) => consumption.reviewReceipt(request),
    resolveBaseline: (repositoryId, targetBranch) =>
      workspace.resolveBaseline(repositoryId, targetBranch),
    continuationWorkspace: (designId) => care.continuationWorkspace(designId),
  })
  const dependencies = { store, artifacts, cases: input.cases, execution, changed: input.changed }
  const commands = createGraphDesignCommands(dependencies)
  const consumption = createGraphExecutionConsumption({
    ...dependencies,
    commands,
    rounds: input.rounds,
    executions: input.executions,
    humanInputs: input.humanInputs,
  })
  const workspace = createGraphEmployeeWorkspace({
    ...input.workspace,
    appHome: input.appHome,
    store,
    artifacts,
    commands,
    rounds: input.rounds,
    consumeResult: consumption.consume,
    verificationProfiles: () => listGraphVerificationProfileContents(profiles),
    continuationWorkspace: (designId) => care.continuationWorkspace(designId),
  })
  const queries = createGraphDesignQueries({ ...dependencies, commands })
  const planning = createGraphViewPlanning({
    store,
    artifacts,
    commands,
    changed: input.changed,
    assist: {
      generate: (request) =>
        input.assist.generate({
          caseId: request.caseId,
          requestId: request.request.requestId,
          signal: request.signal,
          prompt: graphDesignAssistPrompt(request),
        }),
    },
  })
  const verification = createGraphVerification({
    store,
    commands,
    artifacts,
    profiles,
    candidates: input.candidates,
    content: input.content,
    verification: input.verification,
    evidence: input.artifacts,
  })
  const care = createGraphDeliveryBridge({
    appHome: input.appHome,
    factory: input.workspace.factory,
    sourceControl: input.workspace.sourceControl,
    candidates: input.candidates,
    workspacePersistence: createEmployeeWorkspacePersistence(input.db),
    platformPersistence: createEmployeePlatformWorkItemPersistence(input.db),
    store,
    commands,
    execution,
    verification,
    now: Date.now,
  })
  const platformWorkItems = createGraphPlatformWorkItems({
    publication: input.publication,
    store,
    commands,
    artifacts,
    workspace,
    verification,
    candidates: input.candidates,
    mergeRequestDelivery: care,
  })
  const acceptance = createGraphEvidenceAcceptance({
    store,
    artifacts,
    commands,
    queries,
    profiles,
    cases: input.cases,
    candidates: input.candidates,
    verification: input.verification,
    continuationWorkspace: (designId) => care.continuationWorkspace(designId),
    workspaceState: (designId) => workspace.state(designId),
    changed: input.changed,
  })
  const detailProjection: EmployeeCaseDetailProjectionParticipant = {
    typeId: GRAPH_EMPLOYEE_TYPE.typeId,
    async projectJson(json) {
      const value = JSON.parse(json) as EmployeeCaseDetailProjectionInputV1
      const context = value.contexts.find((context) => context.typeId === GRAPH_CONTEXT_TYPE)
      const work = context ? GraphEmployeeContextSchema.parse(JSON.parse(context.stateJson)) : null
      const deliveryDetail = projectDevelopmentEmployeeCaseDetail({
        snapshot: value,
        workspace: await createDevelopmentEmployeeCaseWorkspaceDetailReader(input.db).getByCaseId(
          value.case.id,
        ),
      })
      return canonicalJson({
        schemaVersion: 1,
        input: {
          source: value.case.launchOrigin,
          ingressRef: null,
          kind: work?.request.kind ?? 'unknown',
          subjectRef: value.case.id,
          repositoryRef: work?.repositoryId ?? null,
          body: work?.request.body ?? null,
          externalId: null,
          uploads: work?.request.uploads ?? [],
          executionOptions: {},
          advancedOptions: work?.request.targetBranch
            ? { 'working-branch': work.request.targetBranch }
            : {},
        },
        workspace: deliveryDetail.workspace,
        changeCandidate: deliveryDetail.changeCandidate,
        delivery: deliveryDetail.delivery,
      })
    },
  }
  const graph = {
    mountRoutes(
      app: Hono,
      access: { authorize(actor: Actor, caseId: string, edit: boolean): Promise<unknown> },
    ): void {
      mountGraphDesignRoutes(app, graph, access)
    },
    commands,
    queries,
    planning,
    workspace,
    care,
    platformWorkItems,
    detailProjection,
    progress: { observe: consumption.progress },
    recover: planning.recoverInterrupted,
    basis: acceptance.basis,
    evidence: acceptance.evidence,
    verificationProfiles: acceptance.verificationProfiles,
    reviewLimitations: createGraphLimitationReview({
      store,
      artifacts,
      commands,
      queries,
      latestVerification: acceptance.latestVerification,
      currentEvidenceTarget: acceptance.currentEvidenceTarget,
      changed: input.changed,
    }),
    accept: acceptance.accept,
    requestVerification: acceptance.requestVerification,
    exportBasis: acceptance.exportBasis,
  }
  return graph
}
export type GraphDevelopment = ReturnType<typeof composeGraphDevelopment>
