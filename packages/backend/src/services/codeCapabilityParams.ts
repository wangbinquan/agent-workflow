// RFC-304 T47 — a cell's effective parameters, validated once.
//
// The framework declares the table and the defaults; the binding overrides some
// of them; the scripts read the result. This resolves that chain and validates
// it with the SAME function the form uses (`shared/capabilityParams`), which is
// the whole requirement: two validators drift, and the way that surfaces is a
// form accepting a value the API then rejects.
//
// ## Validated at read time, not only at write time
//
// A binding validated when it was saved can become invalid later without anyone
// touching it: the framework's author adds a required parameter, or renames
// one, and every binding that pointed at it is now wrong. Checking only on save
// means those bindings run with a missing parameter and the script fails
// somewhere deep, on somebody's merge request. Checking here turns it into a
// readiness problem, which the matrix already knows how to show.

import { and, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { capabilityBindings, capabilityFrameworks, repoCapabilityConfig } from '@/db/schema'
import {
  parseCapabilityParamTable,
  resolveCapabilityParams,
  validateCapabilityParams,
  type CapabilityParamIssue,
  type CapabilityParamTable,
  type CapabilityParamValue,
} from '@agent-workflow/shared'

export type ResolvedCapabilityParams =
  | { ok: true; table: CapabilityParamTable; params: Record<string, CapabilityParamValue> }
  /** Each issue names its field, so the matrix can point at the one to fix. */
  | { ok: false; issues: CapabilityParamIssue[] }

function parseObject(raw: string): Record<string, unknown> {
  try {
    const decoded: unknown = JSON.parse(raw === '' ? '{}' : raw)
    return typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * The parameters this repository's capability actually runs with.
 *
 * A cell with no binding is not an error here: it is a configuration state the
 * readiness check already reports, and duplicating that report as a parameter
 * problem would point the operator at the wrong field.
 */
export async function resolveCellParams(
  db: DbClient,
  input: { repoId: string; capability: string },
): Promise<ResolvedCapabilityParams> {
  const [cell] = await db
    .select({ bindingId: repoCapabilityConfig.bindingId })
    .from(repoCapabilityConfig)
    .where(
      // `and(...)`, never `&&`: a JS `&&` between two drizzle conditions
      // evaluates to the second, so the repo filter would vanish and one team's
      // parameters would resolve from another team's cell.
      and(
        eq(repoCapabilityConfig.repoId, input.repoId),
        eq(repoCapabilityConfig.capability, input.capability),
      ),
    )
  if (cell?.bindingId == null) return { ok: true, table: [], params: {} }

  const [binding] = await db
    .select({
      frameworkId: capabilityBindings.frameworkId,
      paramsJson: capabilityBindings.paramsJson,
    })
    .from(capabilityBindings)
    .where(eq(capabilityBindings.id, cell.bindingId))
  if (binding === undefined) return { ok: true, table: [], params: {} }

  const [framework] = await db
    .select({
      paramSchemaJson: capabilityFrameworks.paramSchemaJson,
      paramDefaultsJson: capabilityFrameworks.paramDefaultsJson,
    })
    .from(capabilityFrameworks)
    .where(eq(capabilityFrameworks.id, binding.frameworkId))
  if (framework === undefined) return { ok: true, table: [], params: {} }

  const parsed = parseCapabilityParamTable(framework.paramSchemaJson)
  if (!parsed.ok) return { ok: false, issues: parsed.issues }

  const defaults = parseObject(framework.paramDefaultsJson)
  const overrides = parseObject(binding.paramsJson)

  // The binding's overrides are checked for TYPE, RANGE and unknown keys —
  // things that are this team's doing. `requireAll: false` because a binding
  // that overrides nothing is legitimate: the framework's defaults may supply
  // everything required, and required-checking a partial set would report
  // every unconfigured cell as broken.
  const issues = validateCapabilityParams(parsed.table, overrides, { requireAll: false })
  if (issues.length > 0) return { ok: false, issues }

  const params = resolveCapabilityParams(parsed.table, defaults, overrides)

  // Required-but-unset AFTER defaults are applied. Validating the overrides
  // alone would miss it: a team that overrides nothing has an empty object,
  // which passes, while the framework's required parameter has no default and
  // the script reads undefined.
  const missing = parsed.table
    .filter((field) => field.required && params[field.name] === undefined)
    .map((field) => ({
      field: field.name,
      message: 'required, and neither the framework nor this binding sets it',
    }))
  if (missing.length > 0) return { ok: false, issues: missing }

  return { ok: true, table: parsed.table, params }
}
