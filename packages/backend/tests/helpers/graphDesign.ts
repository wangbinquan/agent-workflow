import type { GraphDesignDocument, GraphViewProposal } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { createGraphDesignStore } from '@/modules/development-automation/infrastructure/graph-development/designStore'
import { createGraphDesignCommands } from '@/modules/development-automation/application/graph-development/designCommands'
import { createGraphDesignQueries } from '@/modules/development-automation/application/graph-development/designQueries'
import { graphDigest } from '@/modules/development-automation/domain/graph-development/model'
import type { GraphDesignArtifacts } from '@/modules/development-automation/application/ports/graphDesignArtifacts'
import type {
  GraphCaseSnapshot,
  GraphDesignCasePort,
  GraphDesignExecutionPort,
  GraphReviewReceipt,
} from '@/modules/development-automation/application/ports/graphDesignExecution'

export function bookingDesign(): GraphDesignDocument {
  return {
    schemaVersion: 1,
    id: 'design-a',
    caseId: 'case-a',
    revision: 1,
    title: '预约',
    goals: ['避免重复预约'],
    repositoryId: 'repo-a',
    repositoryBaseline: { kind: 'commit', commitSha: 'a'.repeat(40), treeOid: 'b'.repeat(40) },
    concerns: [
      {
        id: 'availability',
        revision: 1,
        statement: '避免重复预约',
        purpose: 'implement',
        priority: 'required',
        disposition: 'addressed',
        sourceIds: ['request'],
        resolutionIds: ['booking'],
      },
    ],
    elements: [
      {
        id: 'booking',
        revision: 1,
        kind: 'requirement',
        label: '预约',
        description: '同一时段最多一笔',
        sourceIds: ['request'],
        obligationIds: ['unique'],
      },
    ],
    relations: [],
    models: [
      {
        id: 'flow',
        revision: 1,
        kind: 'flow',
        label: '预约',
        elementIds: ['booking'],
        relationIds: [],
        sourceIds: ['request'],
      },
    ],
    views: [
      {
        id: 'overview',
        revision: 1,
        title: '预约流程',
        purpose: '澄清',
        capabilityRef: { id: 'flow', version: 1 },
        modelIds: ['flow'],
        elementIds: ['booking'],
        relationIds: [],
        sourceIds: ['request'],
        concernIds: ['availability'],
        status: 'current',
        pinned: false,
        explanation: '足以描述当前问题',
        limitations: [],
      },
    ],
    sources: [
      {
        id: 'request',
        kind: 'material',
        artifactRef: 'request-artifact',
        digest: '1'.repeat(64),
        label: '原始需求',
      },
    ],
    obligations: [
      {
        id: 'unique',
        revision: 1,
        statement: '并发只有一笔成功',
        elementIds: ['booking'],
        concernIds: ['availability'],
        verification: {
          kind: 'manual',
          instructions: '发起两笔预约并检查',
          owner: null,
          when: null,
        },
      },
    ],
  }
}
export function bookingView(id = 'overview'): GraphViewProposal {
  return {
    id,
    title: '预约流程',
    purpose: '澄清',
    capabilityRef: { id: 'flow', version: 1 },
    modelIds: ['flow'],
    elementIds: ['booking'],
    relationIds: [],
    sourceIds: ['request'],
    coverage: [{ concernId: 'availability', contribution: 1, explanation: '覆盖预约唯一性' }],
    readingCost: 1,
    generationCost: 1,
    rationale: '一个视图足够',
    limitations: [],
    replaces: [],
  }
}
export function memoryGraphArtifacts(): GraphDesignArtifacts {
  const bundles = new Map<string, readonly { path: string; content: string }[]>()
  return {
    async put(files) {
      const digest = graphDigest(files)
      bundles.set(digest, structuredClone(files))
      return { artifactRef: digest, digest }
    },
    async read(ref, path) {
      return bundles.get(ref.artifactRef)?.find((file) => file.path === path)?.content ?? null
    },
    async files(ref) {
      const files = bundles.get(ref.artifactRef)
      if (!files) throw new Error('missing-test-artifact')
      return files
    },
  }
}
export async function graphFixture(
  db: ProviderNeutralDatabase,
  baseline = bookingDesign().repositoryBaseline,
) {
  const store = createGraphDesignStore(db),
    artifacts = memoryGraphArtifacts()
  const host: GraphCaseSnapshot = {
    caseId: 'case-a',
    employeeId: 'employee-a',
    state: 'waiting',
    workItemRef: null,
    executionRef: null,
    editableClarify: null,
  }
  const requests: Parameters<GraphDesignCasePort['requestWork']>[0][] = []
  const humanSources: GraphDesignDocument['sources'] = []
  let review: GraphReviewReceipt | null = null
  const cases: GraphDesignCasePort = {
    async inspect() {
      return host
    },
    async requestWork(request) {
      if (!requests.some((row) => row.requestId === request.requestId)) requests.push(request)
      return {
        eventId: `event:${request.requestId}`,
        caseId: request.caseId,
        queued: host.executionRef !== null,
      }
    },
    async followOn() {
      return { caseId: 'follow-on' }
    },
  }
  const execution: GraphDesignExecutionPort = {
    async committedArtifacts() {
      return []
    },
    async humanSources() {
      return humanSources
    },
    async reviewReceipt() {
      return review
    },
    async assertMaterialsReadable({ artifact }) {
      await artifacts.files(artifact)
    },
    async resolveRepositoryBaseline() {
      return baseline!
    },
  }
  const deps = { store, artifacts, cases, execution }
  const commands = createGraphDesignCommands(deps),
    queries = createGraphDesignQueries({ ...deps, commands })
  const seed = { ...bookingDesign(), repositoryBaseline: baseline }
  await commands.ensure({
    id: seed.id,
    caseId: seed.caseId,
    repositoryId: seed.repositoryId,
    title: seed.title,
    body: seed.goals[0]!,
    materialSources: seed.sources,
  })
  await commands.change(seed.id, { requestId: 'seed', expectedRevision: 1, document: seed })
  return {
    ...deps,
    commands,
    queries,
    host,
    requests,
    humanSources,
    setReview(value: GraphReviewReceipt) {
      review = value
    },
  }
}
