import { z } from 'zod'
import { DeclaredInjectionManifestSchema } from '@agent-workflow/shared'
import type { NodeExecutionSnapshot } from '../../application/ports/nodeExecutionPersistence'

const NodeContext = z
  .object({
    id: z.string().min(1),
    nodeId: z.string().min(1),
    iteration: z.number().int().nonnegative(),
    retryIndex: z.number().int().nonnegative(),
    containerRunId: z.string().nullable(),
    parentNodeRunId: z.string().nullable(),
    shardKey: z.string().nullable(),
    envelopeNonce: z.string().nullable(),
    preSnapshot: z.string().nullable(),
  })
  .strict()

export function hostedAgentNodeContext(
  node: Pick<
    NodeExecutionSnapshot,
    Exclude<keyof z.infer<typeof NodeContext>, 'preSnapshot'> | 'checkpointInheritance'
  >,
): z.infer<typeof NodeContext> {
  return Object.freeze(
    NodeContext.parse({
      id: node.id,
      nodeId: node.nodeId,
      iteration: node.iteration,
      retryIndex: node.retryIndex,
      containerRunId: node.containerRunId,
      parentNodeRunId: node.parentNodeRunId,
      shardKey: node.shardKey,
      envelopeNonce: node.envelopeNonce,
      preSnapshot:
        node.checkpointInheritance.find((checkpoint) => checkpoint.mountPath === '')?.preSnapshot ??
        null,
    }),
  )
}

/** AW's interpretation of the accepted material, stored with the submission
 * intent. It is not sent to CS and cannot be rebuilt from today's resources. */
export const HostedAgentContext = z
  .object({
    version: z.literal(1),
    protocol: z.enum(['opencode', 'claude-code']),
    declared: DeclaredInjectionManifestSchema,
    startupInventory: z.boolean(),
    node: NodeContext.optional(),
  })
  .strict()
export type HostedAgentContext = z.infer<typeof HostedAgentContext>

export function freezeHostedAgentContext(value: unknown): HostedAgentContext {
  const parsed = HostedAgentContext.parse(value)
  for (const names of Object.values(parsed.declared)) if (Array.isArray(names)) Object.freeze(names)
  Object.freeze(parsed.declared)
  if (parsed.node) Object.freeze(parsed.node)
  return Object.freeze(parsed)
}
