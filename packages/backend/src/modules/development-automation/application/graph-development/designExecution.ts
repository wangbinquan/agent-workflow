// RFC-507 (RFC-294 S10 step 14): the graph design execution port, moved verbatim out of the
// module's graph development assembly. The execution consumption, the employee workspace and the
// delivery bridge are built after this port, so the assembly passes forwarding functions that read
// them at call time, as its closures did before.
import { z } from 'zod'
import type { GraphSource, RepositoryContentBaseline } from '@agent-workflow/shared'
import { graphDigest } from '../../domain/graph-development/model'
import type { GraphDesignArtifacts } from '../ports/graphDesignArtifacts'
import type { GraphDesignExecutionPort } from '../ports/graphDesignExecution'
import type { GraphExecutionFacts } from '../ports/graphHostFacts'
import { GraphEmployeeContextSchema } from './employeeCodec'
import { GRAPH_CONTEXT_TYPE } from './employeeType'

export interface GraphDesignExecutionDependencies {
  readonly executions: GraphExecutionFacts
  readonly readCase: (caseId: string) => Promise<{ projectionJson: string }>
  readonly artifacts: GraphDesignArtifacts
  /** The execution consumption's authoritative human sources. */
  readonly humanSources: (
    caseId: string,
    sources: readonly GraphSource[],
  ) => Promise<readonly GraphSource[]>
  /** The execution consumption's review receipt. */
  readonly reviewReceipt: GraphDesignExecutionPort['reviewReceipt']
  /** The employee workspace's baseline resolution (structurally its result). */
  readonly resolveBaseline: (
    repositoryId: string,
    targetBranch: string | null,
  ) => Promise<{
    readonly baseline: { readonly contentBaseline?: RepositoryContentBaseline | null }
  }>
  /** The delivery bridge's continuation workspace (structurally its baseline). */
  readonly continuationWorkspace: (
    designId: string,
  ) => Promise<{ readonly baseline: RepositoryContentBaseline } | null>
}

export function createGraphDesignExecution(
  deps: GraphDesignExecutionDependencies,
): GraphDesignExecutionPort {
  return {
    async committedArtifacts(request) {
      const task = await deps.executions.read(request)
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
    humanSources: (request) => deps.humanSources(request.caseId, request.sources),
    reviewReceipt: (request) => deps.reviewReceipt(request),
    async assertMaterialsReadable({ basis, artifact }) {
      const files = await deps.artifacts.files(artifact)
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
        .parse(JSON.parse((await deps.readCase(request.caseId)).projectionJson))
      const context = projection.contexts.find((context) => context.typeId === GRAPH_CONTEXT_TYPE)
      const target = context
        ? GraphEmployeeContextSchema.parse(JSON.parse(context.stateJson)).request.targetBranch
        : null
      return (await deps.resolveBaseline(request.repositoryId, target)).baseline.contentBaseline!
    },
    async resolveImplementationBaseline({ designId }) {
      return (await deps.continuationWorkspace(designId))?.baseline ?? null
    },
  }
}
