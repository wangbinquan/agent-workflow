import {
  GraphEvidenceBindingSchema,
  GraphPresentationSchema,
  GraphProposalSchema,
  GraphTraceLinkSchema,
  type GraphPresentation,
} from '@agent-workflow/shared'
import { z } from 'zod'
import { NotFoundError } from '@/util/errors'
import { graphDigest, graphModelMembers } from '../../domain/graph-development/model'
import { renderGraphModel } from '../../domain/graph-development/renderViews'
import { graphViewCapability } from '../../domain/graph-development/viewCapabilities'
import {
  projectGraphEvidence,
  graphObligationCoverage,
  type GraphEvidenceTarget,
} from '../../domain/graph-development/evidence'
import type { GraphDesignCommands } from './designCommands'
import type { GraphDesignDependencies } from './designCommands'
import type { GraphArtifactReference } from '../ports/graphDesignArtifacts'

export function createGraphDesignQueries(
  deps: GraphDesignDependencies & { readonly commands: GraphDesignCommands },
) {
  return {
    identity: deps.store.find,
    async evidenceArtifacts(id: string, evidenceId: string) {
      const link = (await deps.store.links(id)).find(
        (link) => link.kind === 'evidence' && link.id === evidenceId,
      )
      if (!link) throw new NotFoundError('graph-evidence-not-found', '证据不存在')
      const evidence = GraphEvidenceBindingSchema.parse(JSON.parse(link.payloadJson))
      if (!evidence.artifactRef || !evidence.artifactDigest)
        throw new NotFoundError('graph-evidence-content-missing', '证据材料暂不可读')
      return {
        evidence,
        files: await deps.artifacts.files({
          artifactRef: evidence.artifactRef,
          digest: evidence.artifactDigest,
        }),
      }
    },
    async byCase(caseId: string) {
      return await deps.store.findByCase(caseId)
    },
    async workspace(id: string, revision?: number) {
      const document = await deps.commands.document(id, revision)
      const identity = (await deps.store.find(id))!
      const [records, bases, links, host, revisions] = await Promise.all([
        deps.store.records(id),
        deps.store.bases(id),
        deps.store.links(id),
        deps.cases.inspect(document.caseId),
        deps.store.revisions(id),
      ])
      return {
        document,
        currentRevision: identity.revision,
        presentationRevision: identity.presentationRevision,
        presentation: z
          .record(GraphPresentationSchema)
          .parse(JSON.parse(identity.presentationJson)),
        host,
        revisions: revisions.map((row) => ({
          revision: row.revision,
          createdAt: row.createdAt,
          artifact: { artifactRef: row.artifactRef, digest: row.digest },
        })),
        proposals: records
          .filter((row) => row.kind === 'proposal')
          .map((row) => ({
            id: row.id.slice('proposal:'.length),
            status: row.status,
            createdAt: row.createdAt,
          })),
        requests: records
          .filter((row) =>
            [
              'action',
              'import',
              'review',
              'implementation',
              'clarification',
              'verification',
              'acceptance',
            ].includes(row.kind),
          )
          .map((row) => ({
            id: row.id,
            kind: row.kind,
            status: row.status,
            payload: JSON.parse(row.payloadJson) as unknown,
            updatedAt: row.updatedAt,
          })),
        bases: bases.map((row) => ({ id: row.id, createdAt: row.createdAt })),
        executionLinks: links
          .filter((row) => row.kind === 'execution')
          .map((row) => JSON.parse(row.payloadJson) as unknown),
      }
    },
    async proposal(id: string, proposalId: string) {
      const record = await deps.store.record(id, `proposal:${proposalId}`)
      if (!record) throw new NotFoundError('graph-proposal-not-found', '提案不存在')
      const content = await deps.artifacts.read(
        JSON.parse(record.payloadJson) as GraphArtifactReference,
        'proposal.json',
      )
      if (!content) throw new NotFoundError('graph-proposal-content-missing', '提案材料暂不可读')
      return { ...GraphProposalSchema.parse(JSON.parse(content)), status: record.status }
    },
    async view(
      id: string,
      viewId: string,
      input: { revision?: number; offset?: number; limit?: number } = {},
    ) {
      const document = await deps.commands.document(id, input.revision)
      const view = document.views.find((value) => value.id === viewId)
      if (!view) throw new NotFoundError('graph-view-not-found', '视图不存在')
      const capability = graphViewCapability(view.capabilityRef.id, view.capabilityRef.version)
      const models = document.models.filter((model) => view.modelIds.includes(model.id))
      const members = new Set([
        ...view.elementIds,
        ...view.relationIds,
        ...models.flatMap(graphModelMembers),
      ])
      const relations = document.relations.filter((relation) => members.has(relation.id))
      for (const relation of relations) {
        members.add(relation.from)
        members.add(relation.to)
      }
      const elements = document.elements.filter((element) => members.has(element.id))
      const offset = Math.max(0, Math.floor(input.offset ?? 0)),
        limit = Math.max(1, Math.min(250, Math.floor(input.limit ?? 100)))
      return {
        designId: id,
        revision: document.revision,
        view,
        available: capability !== undefined,
        renderings:
          capability && elements.length <= 250
            ? models.map((model) => ({ modelId: model.id, ...renderGraphModel(document, model) }))
            : [],
        elements: elements.slice(offset, offset + limit),
        relations,
        scope: {
          digest: graphDigest({ view, models, elements, relations }),
          total: elements.length,
          offset,
          limit,
          truncated: offset > 0 || offset + limit < elements.length,
        },
      }
    },
    async evidence(id: string, target: Omit<GraphEvidenceTarget, 'document'>) {
      const document = await deps.commands.document(id)
      const links = await deps.store.links(id)
      const evidence = await Promise.all(
        links
          .filter((link) => link.kind === 'evidence')
          .map(async (link) => {
            const value = GraphEvidenceBindingSchema.parse(JSON.parse(link.payloadJson))
            const projected = projectGraphEvidence(value, { ...target, document })
            if (value.artifactRef && value.artifactDigest) {
              try {
                await deps.artifacts.files({
                  artifactRef: value.artifactRef,
                  digest: value.artifactDigest,
                })
              } catch {
                return {
                  ...projected,
                  freshness:
                    projected.freshness === 'stale' ? ('stale' as const) : ('unknown' as const),
                  reasons: [...projected.reasons, 'evidence-artifact-unreadable'],
                }
              }
            }
            return projected
          }),
      )
      const traces = links
        .filter((link) => link.kind === 'trace')
        .map((link) => GraphTraceLinkSchema.parse(JSON.parse(link.payloadJson)))
      return { evidence, traces, obligations: graphObligationCoverage(document, evidence) }
    },
    async savePresentation(
      id: string,
      input: { expectedRevision: number; views: Record<string, GraphPresentation> },
    ) {
      const views = z.record(GraphPresentationSchema).parse(input.views)
      const current = await deps.commands.document(id)
      for (const [key, value] of Object.entries(views))
        if (key !== value.viewId || !current.views.some((view) => view.id === key))
          throw new NotFoundError('graph-view-not-found', key)
      await deps.store.presentation({
        id,
        expectedRevision: input.expectedRevision,
        json: JSON.stringify(views),
        now: (deps.now ?? Date.now)(),
      })
      deps.changed?.(current.caseId)
    },
  }
}

export type GraphDesignQueries = ReturnType<typeof createGraphDesignQueries>
