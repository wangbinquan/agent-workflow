// Workflow schemas. Mirrors design/design.md §5.
//
// M1 (P-1-11): permissive shape — minimum needed for CRUD round-trip.
// Strict topology / port-connection validation lands in P-2-01.

import { z } from 'zod'

export const WORKFLOW_SCHEMA_VERSION = 1

// --- enums shared across multiple shapes ---

export const NODE_KIND = [
  'agent-single',
  'agent-multi',
  'input',
  'output',
  'wrapper-git',
  'wrapper-loop',
] as const
export const NodeKindSchema = z.enum(NODE_KIND)
export type NodeKind = z.infer<typeof NodeKindSchema>

export const WORKFLOW_INPUT_KIND = ['text', 'files', 'enum', 'git'] as const
export const WorkflowInputKindSchema = z.enum(WORKFLOW_INPUT_KIND)

// --- pieces of a workflow definition (kept permissive in M1) ---

export const XYSchema = z.object({ x: z.number(), y: z.number() })

/**
 * Node base. Each `kind` carries its own additional fields per design.md §5.
 * M1 keeps it permissive via `passthrough()`; the strict discriminated union
 * is built out in P-2-01 alongside the workflow validator.
 */
export const WorkflowNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: NodeKindSchema,
    position: XYSchema.optional(),
  })
  .passthrough()
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>

export const PortRefSchema = z.object({
  nodeId: z.string().min(1),
  portName: z.string().min(1),
})

export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: PortRefSchema,
  target: PortRefSchema,
})
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>

/** Launcher form field declaration. Per-kind fields are loose in M1. */
export const WorkflowInputSchema = z
  .object({
    kind: WorkflowInputKindSchema,
    key: z.string().min(1),
    label: z.string().min(1),
    required: z.boolean().optional(),
    description: z.string().optional(),
  })
  .passthrough()
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>

export const WorkflowOutputBindingSchema = z.object({
  name: z.string().min(1),
  bind: PortRefSchema,
})
export type WorkflowOutputBinding = z.infer<typeof WorkflowOutputBindingSchema>

// --- the definition object stored as JSON in workflows.definition ---

export const WorkflowDefinitionSchema = z.object({
  $schema_version: z.literal(WORKFLOW_SCHEMA_VERSION),
  inputs: z.array(WorkflowInputSchema).default([]),
  nodes: z.array(WorkflowNodeSchema).default([]),
  edges: z.array(WorkflowEdgeSchema).default([]),
  outputs: z.array(WorkflowOutputBindingSchema).optional(),
})
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>

// --- top-level resource (response shape) ---

export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  definition: WorkflowDefinitionSchema,
  version: z.number().int(),
  schemaVersion: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Workflow = z.infer<typeof WorkflowSchema>

// --- request payloads ---

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().default(''),
  definition: WorkflowDefinitionSchema,
})
export type CreateWorkflow = z.infer<typeof CreateWorkflowSchema>

export const UpdateWorkflowSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    description: z.string().optional(),
    definition: WorkflowDefinitionSchema.optional(),
  })
  .strict()
export type UpdateWorkflow = z.infer<typeof UpdateWorkflowSchema>

// --- /validate response (P-2-01 will fill in real checks) ---

export const WorkflowValidationIssueSchema = z.object({
  /** Stable kebab-case identifier; one per static-check rule. */
  code: z.string(),
  message: z.string(),
  /** Optional pointer into the definition (e.g. node id, edge id). */
  pointer: z.string().optional(),
  /**
   * Severity. Absence is treated as 'error' for backwards compatibility — only
   * issues that explicitly set 'warning' are non-blocking. `result.ok` is true
   * iff no issue carries 'error' severity.
   */
  severity: z.enum(['error', 'warning']).optional(),
})
export type WorkflowValidationIssue = z.infer<typeof WorkflowValidationIssueSchema>

export const WorkflowValidationResultSchema = z.object({
  ok: z.boolean(),
  issues: z.array(WorkflowValidationIssueSchema),
})
export type WorkflowValidationResult = z.infer<typeof WorkflowValidationResultSchema>
