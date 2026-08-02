// RFC-247 impl-gate — the field contract behind `resource_write`.
//
// `resource_write`'s own description tells callers to run `describe_resource`
// for "a kind's field schema". Before this, that call returned method/path/
// permission metadata and nothing else — so a model following the instruction
// arrived somewhere that could not answer the question, and its only remaining
// move was to guess a body and read the 422.
//
// The schemas here are the SAME zod objects the routes validate with, converted
// on demand. Nothing is transcribed: add a field to `CreateAgentSchema` and it
// appears here, which is the whole reason a generated contract beats a written
// one (the RFC's AC-22 argument, applied to bodies instead of endpoints).
//
// ## Why `update` sometimes differs sharply from `create`
//
// Several kinds fence their writes on a revision read back from a prior GET
// (`expectedUpdatedAt`, `expectedVersion`, `expectedToken`). Those fields live
// in the REQUEST schemas, not the content schemas, so the request variants are
// what get exposed — otherwise the generated contract would omit exactly the
// fields whose absence makes every update fail.

import type { ZodTypeAny } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import {
  CombinedSaveSkillSchema,
  CreateAgentSchema,
  CreateManagedSkillSchema,
  CreateMcpSchema,
  CreatePluginSchema,
  CreateScheduledTaskSchema,
  CreateWorkflowSchema,
  CreateWorkgroupSchema,
  MemoryCreateRequestSchema,
  MemoryPatchRequestSchema,
  UpdateAgentRequestSchema,
  UpdateMcpRequestSchema,
  UpdatePluginRequestSchema,
  UpdateScheduledTaskSchema,
  UpdateWorkflowSchema,
  UpdateWorkgroupSchema,
  type MatrixResource,
} from '@agent-workflow/shared'

interface KindSchemas {
  readonly create?: ZodTypeAny
  readonly update?: ZodTypeAny
}

/**
 * Deliberately partial: a kind with no entry reports no schema rather than a
 * wrong one. `repos` is the case today — it has no single-resource create
 * (imports are a batch) and no update at all, so inventing a shape here would
 * document an operation that does not exist.
 */
const KIND_SCHEMAS: Partial<Record<MatrixResource, KindSchemas>> = {
  agents: { create: CreateAgentSchema, update: UpdateAgentRequestSchema },
  skills: { create: CreateManagedSkillSchema, update: CombinedSaveSkillSchema },
  mcps: { create: CreateMcpSchema, update: UpdateMcpRequestSchema },
  plugins: { create: CreatePluginSchema, update: UpdatePluginRequestSchema },
  workflows: { create: CreateWorkflowSchema, update: UpdateWorkflowSchema },
  workgroups: { create: CreateWorkgroupSchema, update: UpdateWorkgroupSchema },
  'scheduled-tasks': { create: CreateScheduledTaskSchema, update: UpdateScheduledTaskSchema },
  memory: { create: MemoryCreateRequestSchema, update: MemoryPatchRequestSchema },
}

export interface ResourceBodySchemas {
  readonly create?: unknown
  readonly update?: unknown
}

/**
 * JSON Schema for a kind's create/update bodies, or an empty object when the
 * kind has none to report.
 *
 * `$refStrategy: 'none'` inlines everything. A model reading this has no way to
 * resolve a `$ref` against a document it was handed as a tool result, so a
 * ref-laden schema would be technically complete and practically unusable.
 */
export function bodySchemasFor(kind: MatrixResource): ResourceBodySchemas {
  const entry = KIND_SCHEMAS[kind]
  if (entry === undefined) return {}
  const out: { create?: unknown; update?: unknown } = {}
  if (entry.create !== undefined) {
    out.create = zodToJsonSchema(entry.create, { $refStrategy: 'none' })
  }
  if (entry.update !== undefined) {
    out.update = zodToJsonSchema(entry.update, { $refStrategy: 'none' })
  }
  return out
}

/** Which kinds report a body schema — exported so a test can lock the coverage. */
export const KINDS_WITH_BODY_SCHEMAS: ReadonlyArray<MatrixResource> = Object.keys(
  KIND_SCHEMAS,
) as MatrixResource[]
