// RFC-167 — dynamic workflow space (动态 Workflow 空间) schemas: a SEVENTH ACL
// resource. A space pins a POOL of agents; launching a task against it runs a
// built-in orchestrator agent that reads the pool's capability cards (RFC-166)
// + a goal, emits a workflow DAG, a human confirms/rejects it, then the
// framework executes the confirmed DAG through the ordinary runScope engine.
//
// Resource-level shapes only (this file). The generation envelope + conversion
// (`DwGeneratedWorkflow` → `WorkflowDefinition`) live in `../dynamicWorkflow.ts`;
// task-runtime shapes (dwspace_config phases) land with the engine PRs. See
// design/RFC-167-dynamic-workflow-space/design.md.
//
// Save-lenient / launch-strict (RFC-164 决策 #21 风味): an empty pool SAVES
// fine (quick create = name + description only); the non-empty + all-resolvable
// pool requirement is enforced at LAUNCH time, not save time.

import { z } from 'zod'
import { AgentNameSchema } from './agent'
import { ResourceVisibilitySchema } from './resourceAcl'

/** Permitted characters in a space name (URL-safe; matches `/api/dynamic-workflow-spaces/:name`).
 *  Aliased to the workgroup/workflow rule so the three can never drift. */
export const DYNAMIC_WORKFLOW_SPACE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export const DynamicWorkflowSpaceNameSchema = z
  .string()
  .min(1, 'name is required')
  .max(128, 'name too long')
  .regex(
    DYNAMIC_WORKFLOW_SPACE_NAME_RE,
    'name must start with [a-z0-9] and contain only [a-z0-9_-]',
  )

/**
 * The orchestratable agent pool: agent NAMES (soft references, same as a
 * workflow node's agentName). Save-time validates only NEWLY-added references
 * (`services/resourceRefs.ts`); launch-time requires the pool to be non-empty
 * and every entry to resolve to an existing + enabled agent. Duplicates are
 * NOT rejected here — "each agent usable multiple times" is a core design point
 * (a pool of one agent can still fan out into many workflow nodes); the pool is
 * a SET of candidates, so a duplicate name is merely redundant, and the CRUD
 * layer de-dupes on write for a clean stored value.
 */
export const AgentPoolSchema = z.array(AgentNameSchema).max(128)
export type AgentPool = z.infer<typeof AgentPoolSchema>

/** Full dynamic workflow space resource (response shape). */
export const DynamicWorkflowSpaceSchema = z.object({
  id: z.string(),
  name: DynamicWorkflowSpaceNameSchema,
  description: z.string(),
  agentPool: AgentPoolSchema,
  /** RFC-099 ACL — owner (users.id or '__system__'); null until first owner write. */
  ownerUserId: z.string().nullable().optional(),
  /** RFC-099 ACL — 'public' = every user; 'private' = owner + grants. Absent ⇒ 'public'. */
  visibility: ResourceVisibilitySchema.optional(),
  schemaVersion: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type DynamicWorkflowSpace = z.infer<typeof DynamicWorkflowSpaceSchema>

/** POST /api/dynamic-workflow-spaces body. Quick create = name + description;
 *  agentPool optional (server fills []), edited later on the detail page. */
export const CreateDynamicWorkflowSpaceSchema = z.object({
  name: DynamicWorkflowSpaceNameSchema,
  description: z.string().default(''),
  agentPool: AgentPoolSchema.default([]),
})
export type CreateDynamicWorkflowSpace = z.infer<typeof CreateDynamicWorkflowSpaceSchema>

/** PUT /api/dynamic-workflow-spaces/:name body — full document replace (pool is
 *  full-replace). Name changes happen via a dedicated /rename, like agents. */
export const UpdateDynamicWorkflowSpaceSchema = z
  .object({
    description: z.string().optional(),
    agentPool: AgentPoolSchema.optional(),
  })
  .strict()
export type UpdateDynamicWorkflowSpace = z.infer<typeof UpdateDynamicWorkflowSpaceSchema>

/** POST /api/dynamic-workflow-spaces/:name/rename body. */
export const RenameDynamicWorkflowSpaceSchema = z.object({
  newName: DynamicWorkflowSpaceNameSchema,
})
export type RenameDynamicWorkflowSpace = z.infer<typeof RenameDynamicWorkflowSpaceSchema>
