// RFC-031 — plugin form state + builders shared between /plugins/new and
// /plugins/$id. Mirrors lib/mcp-form.ts shape so the editing experience
// stays consistent across resources.

import type { CreatePlugin, Plugin, UpdatePlugin } from '@agent-workflow/shared'
import { CreatePluginSchema, PLUGIN_NAME_RE } from '@agent-workflow/shared'

export interface PluginFormState {
  name: string
  spec: string
  /** Free-form JSON text shown in the textarea; parsed to object on save. */
  optionsJson: string
  description: string
  enabled: boolean
}

export const EMPTY_PLUGIN_FORM: PluginFormState = {
  name: '',
  spec: '',
  optionsJson: '{}',
  description: '',
  enabled: true,
}

/** Hydrate the form from an existing Plugin row. */
export function pluginToForm(p: Plugin): PluginFormState {
  return {
    name: p.name,
    spec: p.spec,
    optionsJson: JSON.stringify(p.options ?? {}, null, 2),
    description: p.description,
    enabled: p.enabled,
  }
}

export interface BuiltCreate {
  ok: true
  payload: CreatePlugin
}
export interface BuiltErrors {
  ok: false
  errors: Record<string, string>
}

/**
 * Validate the form for the **create** path. Returns the API-ready CreatePlugin
 * payload on success; on failure returns a per-field error map so the page can
 * surface inline messages without round-tripping the server.
 */
export function buildCreatePayload(form: PluginFormState): BuiltCreate | BuiltErrors {
  const errors: Record<string, string> = {}
  if (!PLUGIN_NAME_RE.test(form.name)) {
    errors.name = 'name must match [a-z0-9][a-z0-9_-]* and be 1–64 chars'
  }
  if (form.spec.trim() === '') {
    errors.spec = 'spec is required'
  } else if (form.spec.length > 512) {
    errors.spec = 'spec is too long (max 512 chars)'
  }
  const options = parseOptions(form.optionsJson)
  if (options === null) {
    errors.options = 'options must be a JSON object (e.g. {} or {"key":"value"})'
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  // Final schema validation as a defensive layer — catches edge cases the
  // per-field checks above missed.
  const parsed = CreatePluginSchema.safeParse({
    name: form.name,
    spec: form.spec,
    options,
    description: form.description,
    enabled: form.enabled,
  })
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]
      if (typeof key === 'string' && fieldErrors[key] === undefined) {
        fieldErrors[key] = issue.message
      }
    }
    return { ok: false, errors: fieldErrors }
  }
  return { ok: true, payload: parsed.data }
}

/**
 * Build an UpdatePlugin patch — only includes fields that actually changed
 * compared to the row currently on the server. `name` is never included
 * (rename has its own endpoint).
 */
export function buildUpdatePayload(
  form: PluginFormState,
  existing: Plugin,
): BuiltCreate extends never ? never : { ok: true; payload: UpdatePlugin } | BuiltErrors {
  const errors: Record<string, string> = {}
  if (form.spec.trim() === '') errors.spec = 'spec is required'
  const options = parseOptions(form.optionsJson)
  if (options === null) {
    errors.options = 'options must be a JSON object'
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const patch: UpdatePlugin = {}
  if (form.spec !== existing.spec) patch.spec = form.spec
  if (form.description !== existing.description) patch.description = form.description
  if (form.enabled !== existing.enabled) patch.enabled = form.enabled
  const existingOptionsJson = JSON.stringify(existing.options ?? {})
  if (JSON.stringify(options) !== existingOptionsJson) patch.options = options ?? {}
  return { ok: true, payload: patch }
}

function parseOptions(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}
