// Pure quick-create helper for the /workflows list-page dialog. Mirrors
// lib/workgroup-form's buildQuickCreatePayload: the dialog collects name +
// description only, the definition starts EMPTY, and every detail edit
// happens afterwards in the /workflows/$id editor (auto-save). Lives outside
// the React tree so the validation matrix is unit-testable without rendering.

import type { CreateWorkflow, WorkflowDefinition } from '@agent-workflow/shared'
import {
  CreateWorkflowSchema,
  WORKFLOW_SCHEMA_VERSION,
  isValidResourceDisplayName,
  normalizeResourceDisplayName,
} from '@agent-workflow/shared'

/** Definition a quick-created workflow starts with. New production writes
 * always use the canonical latest workflow schema. */
export const EMPTY_WORKFLOW_DEFINITION: WorkflowDefinition = {
  $schema_version: WORKFLOW_SCHEMA_VERSION,
  inputs: [],
  nodes: [],
  edges: [],
}

export interface QuickCreateWorkflowInput {
  name: string
  description: string
}

/**
 * 2026-07-10 naming unification: workflow names follow the SAME rules as
 * workgroup names (one shared regex, aliased). RFC-264 widened that rule to
 * human-readable names and put a normalizer in front of it, so the verdict is
 * taken on the FOLDED value — otherwise a trailing space the server silently
 * trims would show as an inline error the user cannot see.
 *
 * Error values are raw i18n keys ('workflows.errors.*') — widgets translate at
 * render time, same contract as the workgroup builder.
 */
export function workflowNameError(name: string): string | null {
  const normalized = normalizeResourceDisplayName(name)
  if (normalized.length === 0) return 'workflows.errors.nameRequired'
  if (!isValidResourceDisplayName(normalized)) return 'workflows.errors.nameInvalid'
  return null
}

/** Editor rename gate — an UNCHANGED name is always savable, even a stored
 *  legacy free-form one (grandfather; the backend PUT mirrors this rule and
 *  validates only changed names). */
export function workflowRenameError(next: string, savedName: string): string | null {
  if (next === savedName) return null
  return workflowNameError(next)
}

export type BuiltQuickCreateWorkflow =
  | { ok: true; payload: CreateWorkflow }
  | { ok: false; errors: Record<string, string> }

export function buildQuickCreateWorkflowPayload(
  input: QuickCreateWorkflowInput,
): BuiltQuickCreateWorkflow {
  const nameError = workflowNameError(input.name)
  if (nameError !== null) return { ok: false, errors: { name: nameError } }
  // Wire-shape net: the same schema the server parses (defaults fill in).
  const parsed = CreateWorkflowSchema.safeParse({
    name: input.name,
    description: input.description,
    definition: EMPTY_WORKFLOW_DEFINITION,
  })
  if (!parsed.success) return { ok: false, errors: {} }
  return { ok: true, payload: parsed.data }
}
