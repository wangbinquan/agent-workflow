// Pure quick-create helper for the /workflows list-page dialog. Mirrors
// lib/workgroup-form's buildQuickCreatePayload: the dialog collects name +
// description only, the definition starts EMPTY, and every detail edit
// happens afterwards in the /workflows/$id editor (auto-save). Lives outside
// the React tree so the validation matrix is unit-testable without rendering.

import type { CreateWorkflow, WorkflowDefinition } from '@agent-workflow/shared'
import { CreateWorkflowSchema } from '@agent-workflow/shared'

/** Definition a quick-created workflow starts with. Written as v1-empty on
 *  purpose — the backend GET path transparently upgrades schema versions, so
 *  the editor always loads the canonical latest shape. */
export const EMPTY_WORKFLOW_DEFINITION: WorkflowDefinition = {
  $schema_version: 1,
  inputs: [],
  nodes: [],
  edges: [],
}

export interface QuickCreateWorkflowInput {
  name: string
  description: string
}

/** Unlike workgroup names there are no slug rules here (free-form 1..256
 *  chars), so the not-ok branch carries no per-field error record: the empty
 *  name just keeps the Create button disabled and the input's maxLength stops
 *  overlong names before the schema net could ever reject them. */
export type BuiltQuickCreateWorkflow = { ok: true; payload: CreateWorkflow } | { ok: false }

export function buildQuickCreateWorkflowPayload(
  input: QuickCreateWorkflowInput,
): BuiltQuickCreateWorkflow {
  if (input.name.length === 0) return { ok: false }
  // Wire-shape net: the same schema the server parses (defaults fill in).
  const parsed = CreateWorkflowSchema.safeParse({
    name: input.name,
    description: input.description,
    definition: EMPTY_WORKFLOW_DEFINITION,
  })
  if (!parsed.success) return { ok: false }
  return { ok: true, payload: parsed.data }
}
