import { z } from 'zod'
import {
  canonicalJson,
  GraphEvidenceBindingSchema,
  repositoryMaterializationCommit,
  type GraphImplementationBasis,
} from '@agent-workflow/shared'
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
import { createGraphPlatformWorkItems } from '../application/graph-development/platformWorkItems'
import type {
  GraphDesignCasePort,
  GraphDesignExecutionPort,
} from '../application/ports/graphDesignExecution'
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
import { graphDigest, staleGraphReads } from '../domain/graph-development/model'
import { mountGraphDesignRoutes } from '../infrastructure/http/graphDesignRoutes'
import type { Hono } from 'hono'
import type { Actor } from '@/auth/actor'
import { createGraphDeliveryBridge } from './graphDeliveryBridge'
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
  const execution: GraphDesignExecutionPort = {
    async committedArtifacts(request) {
      const task = await input.executions.read(request)
      return (
        task?.artifacts.map((artifact) => ({
          taskId: task.taskId,
          nodeRunId: artifact.nodeRunId,
          outputPort: artifact.portName,
          digest: artifact.digest,
          content: artifact.content,
        })) ?? []
      )
    },
    humanSources: (request) => consumption.humanSources(request.caseId, request.sources),
    reviewReceipt: (request) => consumption.reviewReceipt(request),
    async assertMaterialsReadable({ basis, artifact }) {
      const files = await artifacts.files(artifact)
      for (const expected of basis.files)
        if (
          !files.some(
            (file) => file.path === expected.path && graphDigest(file.content) === expected.digest,
          )
        )
          throw new Error(`graph-material-unreadable:${expected.path}`)
    },
    async resolveRepositoryBaseline(request) {
      const projection = z
        .object({
          contexts: z.array(z.object({ typeId: z.string(), stateJson: z.string() }).passthrough()),
        })
        .passthrough()
        .parse(JSON.parse((await input.readCase(request.caseId)).projectionJson))
      const context = projection.contexts.find((context) => context.typeId === GRAPH_CONTEXT_TYPE)
      const target = context
        ? GraphEmployeeContextSchema.parse(JSON.parse(context.stateJson)).request.targetBranch
        : null
      return (await workspace.resolveBaseline(request.repositoryId, target)).baseline
        .contentBaseline!
    },
    async resolveImplementationBaseline({ designId }) {
      return (await care.continuationWorkspace(designId))?.baseline ?? null
    },
  }
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
    verificationProfiles: async () =>
      await Promise.all(
        (await profiles.list())
          .filter((profile) => profile.publishedRevision && !profile.archivedAt)
          .map(async (profile) => {
            const revision = (await profiles.getRevision(profile.id, profile.publishedRevision!))!
            return {
              id: profile.id,
              name: profile.name,
              revision: revision.revision,
              digest: revision.contentDigest,
              content: JSON.parse(revision.contentJson) as unknown,
            }
          }),
      ),
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
  async function latestVerification(id: string) {
    const record = (await store.records(id))
      .filter((row) => row.kind === 'verification' && row.status === 'completed')
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    return record
      ? (JSON.parse(record.payloadJson) as {
          basisId: string
          basisDigest: string
          candidate: { treeOid: string }
          environmentDigest: string
          profileDigests: Record<string, string>
        })
      : null
  }
  async function currentEvidenceTarget(id: string) {
    const continuation = await care.continuationWorkspace(id)
    const current = continuation ?? (await workspace.state(id))
    // Publication advances the baseline to the verified commit. Deriving a new
    // delivery candidate then correctly reports no delta, but evidence still
    // needs the actual current tree, including any later workspace drift.
    const candidate = await input.candidates.stage({
      baselineRepoPath: current.baselineRepoPath,
      baselineSha: repositoryMaterializationCommit(current.baseline),
      overlayRoot: current.workspacePath,
      uploadPlan: current.uploadPlan,
    })
    try {
      return {
        candidateTreeOid: candidate.ok ? candidate.treeOid : null,
        commitSha: continuation?.remoteHeadSha ?? null,
        environmentDigest:
          (await input.verification.environment?.(current.workspacePath))?.digest ?? null,
      }
    } finally {
      if (candidate.ok) await candidate.cleanup()
    }
  }
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
    async basis(id: string, basisId: string) {
      const value = await commands.basis(id, basisId)
      const document = await commands.document(id)
      return { ...value, staleIds: staleGraphReads(document, value.basis.readSet) }
    },
    async evidence(id: string) {
      const latest = await latestVerification(id)
      const links = await store.links(id)
      const delivery = links.filter((link) => link.id.startsWith('delivery:')).at(-1)
      const commitSha = delivery
        ? (JSON.parse(delivery.payloadJson) as { commitSha: string }).commitSha
        : null
      const currentProfiles: Record<string, string> = {}
      for (const profile of await profiles.list())
        if (profile.publishedRevision && !profile.archivedAt) {
          const digest =
            (await profiles.getRevision(profile.id, profile.publishedRevision))?.contentDigest ?? ''
          currentProfiles[profile.id] = digest
          currentProfiles[`${profile.id}@${profile.publishedRevision}`] = digest
        }
      // Approved work pins an immutable profile revision. Publishing or
      // archiving its resource does not silently replace or revoke that pin.
      for (const link of links.filter((link) => link.kind === 'evidence')) {
        const ref = GraphEvidenceBindingSchema.parse(JSON.parse(link.payloadJson)).profileRef
        if (ref)
          currentProfiles[`${ref.id}@${ref.revision}`] =
            (await profiles.getRevision(ref.id, ref.revision))?.contentDigest ?? ''
      }
      // A retained passing receipt describes an earlier tree. Read the active
      // workspace so a repair invalidates it even before the next verification.
      const current = latest ? await currentEvidenceTarget(id).catch(() => null) : null
      const projected = await queries.evidence(id, {
        basisDigest: latest?.basisDigest ?? null,
        candidateTreeOid: current?.candidateTreeOid ?? null,
        profileDigests: currentProfiles,
        environmentDigest: current?.environmentDigest ?? null,
        commitSha: current?.commitSha ?? commitSha,
      })
      const approvedBasis =
        latest && current?.candidateTreeOid === latest.candidate.treeOid
          ? await commands.basis(id, latest.basisId).catch(() => null)
          : null
      const candidate =
        approvedBasis &&
        staleGraphReads(await commands.document(id), approvedBasis.basis.readSet).length === 0
          ? {
              basisId: approvedBasis.basis.id,
              basisDigest: approvedBasis.basis.digest,
              candidateTreeOid: current!.candidateTreeOid!,
              obligationIds: approvedBasis.basis.obligationIds,
            }
          : null
      return { ...projected, candidate }
    },
    async verificationProfiles() {
      return await Promise.all(
        (await profiles.list())
          .filter((profile) => profile.publishedRevision && !profile.archivedAt)
          .map(async (profile) => {
            const revision = (await profiles.getRevision(profile.id, profile.publishedRevision!))!
            return {
              id: profile.id,
              name: profile.name,
              revision: revision.revision,
              digest: revision.contentDigest,
            }
          }),
      )
    },
    async accept(
      id: string,
      request: {
        requestId: string
        basisId: string
        candidateTreeOid: string
        obligationIds: string[]
        result: 'passed' | 'failed'
        comment: string
      },
      actorUserId: string,
    ) {
      const basis = (await commands.basis(id, request.basisId)).basis
      const current = await latestVerification(id)
      const target = await currentEvidenceTarget(id)
      if (
        !current ||
        current.basisDigest !== basis.digest ||
        current.candidate.treeOid !== request.candidateTreeOid ||
        target.candidateTreeOid !== request.candidateTreeOid ||
        staleGraphReads(await commands.document(id), basis.readSet).length > 0
      )
        throw new Error('graph-acceptance-candidate-mismatch')
      if (
        !request.obligationIds.length ||
        request.obligationIds.some(
          (id) =>
            !basis.obligationIds.includes(id) ||
            !basis.document.obligations.some(
              (obligation) => obligation.id === id && obligation.verification.kind === 'manual',
            ),
        )
      )
        throw new Error('graph-acceptance-obligation-invalid')
      const record = await commands.beginRecord(
        id,
        `acceptance:${request.requestId}`,
        'acceptance',
        { ...request, actorUserId },
      )
      if (record.status === 'completed') return JSON.parse(record.payloadJson) as unknown
      const artifact = await artifacts.put([
        {
          path: 'acceptance.json',
          content: canonicalJson({ ...request, actorUserId, recordedAt: record.createdAt }),
        },
      ])
      const evidence = GraphEvidenceBindingSchema.parse({
        id: `acceptance:${request.requestId}`,
        kind: 'acceptance',
        basisDigest: basis.digest,
        obligationIds: request.obligationIds,
        readSet: basis.readSet,
        candidateTreeOid: request.candidateTreeOid,
        commitSha: null,
        profileRef: null,
        environmentDigest: null,
        executionRef: null,
        artifactRef: artifact.artifactRef,
        artifactDigest: artifact.digest,
        ci: null,
        result: request.result,
        summary: request.comment,
        limitations: ['仅记录指定候选和范围的人工作出的验收判断。'],
        recordedAt: record.createdAt,
      })
      await store.insertLink({
        designId: id,
        id: evidence.id,
        kind: 'evidence',
        payloadJson: canonicalJson(evidence),
        createdAt: record.createdAt,
      })
      await commands.finishRecord(record, 'completed', evidence)
      input.changed?.(basis.document.caseId)
      return evidence
    },
    async requestVerification(id: string, requestId: string) {
      const document = await commands.document(id)
      const payload = await artifacts.put([
        { path: 'request.json', content: canonicalJson({ requestId, designId: id }) },
      ])
      return await input.cases.requestWork({
        caseId: document.caseId,
        requestId,
        kind: 'verification',
        payloadRef: payload,
        withdrawReview: false,
      })
    },
    async exportBasis(id: string, basisId: string): Promise<GraphImplementationBasis['files']> {
      return (await commands.basis(id, basisId)).basis.files
    },
  }
  return graph
}
export type GraphDevelopment = ReturnType<typeof composeGraphDevelopment>
