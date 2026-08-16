// RFC-304 T47 — the parameter table a framework declares, and its ONE validator.
//
// A framework's scripts need configuration: which label starts a requirement,
// which branch to target, how many attempts before handing off. The department
// author declares those as a table; the platform renders a form from it and
// validates what comes back.
//
// This lives in `shared` because "the interface and the API share one
// validation" is the requirement, not an implementation preference. Two
// validators drift: the form accepts a value the API then rejects, and the
// person is told their input is invalid by a screen that just accepted it.
//
// ## Why a closed field kind, not JSON Schema
//
// The schema column is documented as JSON Schema, and there is no JSON Schema
// validator in this repository (see `stageContract.ts` on the same point). More
// importantly, a form cannot be rendered from arbitrary JSON Schema without
// interpreting a specification designed for validation rather than for display
// — `oneOf`, `$ref`, `patternProperties`. So the platform accepts a SMALL closed
// set of field kinds it can render honestly, and rejects a declaration it
// cannot: an unrenderable field would otherwise become an invisible one, and an
// invisible required field is a form nobody can submit.

import { z } from 'zod'

/** The field kinds the platform can render and validate. */
export const CAPABILITY_PARAM_KINDS = [
  'string',
  'number',
  'boolean',
  'enum',
  'string-list',
] as const
export type CapabilityParamKind = (typeof CAPABILITY_PARAM_KINDS)[number]

export const CapabilityParamFieldSchema = z
  .object({
    /** Key in the params object; the script reads it by this name. */
    name: z
      .string()
      .min(1)
      .max(64)
      // Kept to identifier characters because scripts read these as env keys
      // and object properties. A name with a space or a dot works in one and
      // not the other, which the author discovers at run time.
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a plain identifier'),
    kind: z.enum(CAPABILITY_PARAM_KINDS),
    /** Shown as the field's label. Defaults to `name` when absent. */
    label: z.string().max(120).optional(),
    /** Shown under the field. This is where an author explains the units. */
    hint: z.string().max(500).optional(),
    required: z.boolean().default(false),
    /** `enum` only. Rendered as a segmented control or select. */
    options: z.array(z.string().min(1)).max(50).optional(),
    /** `number` only. Inclusive. */
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.kind === 'enum' && (field.options === undefined || field.options.length === 0)) {
      // An enum with no options renders as a control with nothing in it — the
      // author sees an empty dropdown and no explanation.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'an enum field must list its options',
      })
    }
    if (field.kind !== 'enum' && field.options !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: `options only apply to an enum field, not to '${field.kind}'`,
      })
    }
    if (field.kind !== 'number' && (field.min !== undefined || field.max !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min'],
        message: `min/max only apply to a number field, not to '${field.kind}'`,
      })
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['max'], message: 'max is below min' })
    }
  })

export type CapabilityParamField = z.infer<typeof CapabilityParamFieldSchema>

export const CapabilityParamTableSchema = z.array(CapabilityParamFieldSchema).max(50)
export type CapabilityParamTable = z.infer<typeof CapabilityParamTableSchema>

export interface CapabilityParamIssue {
  /** The field's `name`, or `''` for a whole-table problem. */
  field: string
  message: string
}

/**
 * Read a framework's declared table out of its stored JSON.
 *
 * A malformed table is reported rather than treated as empty: an empty table
 * renders as a form with no fields, and the author concludes the platform
 * ignored their declaration rather than that it could not read it.
 */
export function parseCapabilityParamTable(
  raw: string,
): { ok: true; table: CapabilityParamTable } | { ok: false; issues: CapabilityParamIssue[] } {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw === '' ? '[]' : raw)
  } catch {
    return { ok: false, issues: [{ field: '', message: 'the parameter table is not valid JSON' }] }
  }

  // `{}` is what the column defaults to; an empty object means "no parameters"
  // and is not an error.
  if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
    return Object.keys(decoded).length === 0
      ? { ok: true, table: [] }
      : {
          ok: false,
          issues: [{ field: '', message: 'the parameter table must be a list of fields' }],
        }
  }

  const parsed = CapabilityParamTableSchema.safeParse(decoded)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        field: typeof issue.path[1] === 'string' ? issue.path[1] : String(issue.path[0] ?? ''),
        message: issue.message,
      })),
    }
  }

  const seen = new Set<string>()
  for (const field of parsed.data) {
    if (seen.has(field.name)) {
      // Two fields with one name: the second silently wins in the params
      // object, and the author's form shows two controls editing one value.
      return {
        ok: false,
        issues: [{ field: field.name, message: 'two fields share this name' }],
      }
    }
    seen.add(field.name)
  }

  return { ok: true, table: parsed.data }
}

export type CapabilityParamValue = string | number | boolean | string[]

/**
 * Validate submitted values against the declared table.
 *
 * Returns EVERY issue rather than the first: a form that reports one error at a
 * time makes filling in five fields five round-trips.
 *
 * Unknown keys are an issue too. The alternative — dropping them — means an
 * author who renamed a parameter keeps seeing the old value in the database and
 * the new one unset, with the script reading neither.
 */
export interface ValidateParamsOptions {
  /**
   * Enforce `required`. Default true — that is what a FORM needs.
   *
   * False when checking a partial set, which is what a binding's overrides
   * are: a binding that overrides nothing is legitimate, because the
   * framework's defaults may supply everything required. Required-checking a
   * partial set makes it impossible for a default to satisfy a required field,
   * and the resolver then reports every unconfigured cell as broken.
   */
  requireAll?: boolean
}

export function validateCapabilityParams(
  table: CapabilityParamTable,
  values: Readonly<Record<string, unknown>>,
  options: ValidateParamsOptions = {},
): CapabilityParamIssue[] {
  const issues: CapabilityParamIssue[] = []
  const declared = new Set(table.map((field) => field.name))

  for (const key of Object.keys(values)) {
    if (!declared.has(key)) {
      issues.push({ field: key, message: 'this framework declares no such parameter' })
    }
  }

  for (const field of table) {
    const value = values[field.name]
    const absent = value === undefined || value === null || value === ''

    if (absent) {
      if (field.required && options.requireAll !== false) {
        issues.push({ field: field.name, message: 'required' })
      }
      continue
    }

    switch (field.kind) {
      case 'string':
        if (typeof value !== 'string') issues.push({ field: field.name, message: 'must be text' })
        break
      case 'number': {
        // Accepts a numeric string: an HTML number input submits one, and
        // rejecting it would make the platform's own form fail its own check.
        const numeric = typeof value === 'number' ? value : Number(value)
        if (typeof value === 'boolean' || !Number.isFinite(numeric)) {
          issues.push({ field: field.name, message: 'must be a number' })
          break
        }
        if (field.min !== undefined && numeric < field.min) {
          issues.push({ field: field.name, message: `must be at least ${String(field.min)}` })
        }
        if (field.max !== undefined && numeric > field.max) {
          issues.push({ field: field.name, message: `must be at most ${String(field.max)}` })
        }
        break
      }
      case 'boolean':
        if (typeof value !== 'boolean') {
          issues.push({ field: field.name, message: 'must be true or false' })
        }
        break
      case 'enum':
        if (typeof value !== 'string' || !(field.options ?? []).includes(value)) {
          issues.push({
            field: field.name,
            message: `must be one of: ${(field.options ?? []).join(', ')}`,
          })
        }
        break
      case 'string-list':
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
          issues.push({ field: field.name, message: 'must be a list of text values' })
        }
        break
    }
  }

  return issues
}

/** Where a resolved parameter's winning value came from. */
export type CapabilityParamSource = 'framework-default' | 'binding-override'

export interface CapabilityParamTraceEntry {
  name: string
  value: CapabilityParamValue
  /** The answer to "why is it this?" for a cell that is behaving oddly. */
  source: CapabilityParamSource
}

export interface CapabilityParamResolution {
  params: Record<string, CapabilityParamValue>
  /** Per-key provenance, in table order. */
  trace: CapabilityParamTraceEntry[]
  /**
   * Override keys the framework never declared.
   *
   * Reported rather than applied. A typo that silently does nothing is worse
   * than a rejection: the cell looks configured and behaves as if it is not,
   * and "why is my threshold ignored?" has no answer anywhere in the system.
   */
  unknownKeys: string[]
}

/**
 * The effective parameters: the framework's defaults with the binding on top.
 *
 * Per KEY rather than per object. A binding that overrides one parameter must
 * not blank the other four, which is what a whole-object replacement does — and
 * it does it silently, because the script simply reads undefined.
 */
export function resolveCapabilityParams(
  table: CapabilityParamTable,
  defaults: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>>,
): Record<string, CapabilityParamValue> {
  return traceCapabilityParams(table, defaults, overrides).params
}

/**
 * The same resolution, plus WHERE each value came from.
 *
 * Separate from `resolveCapabilityParams` only so the common caller — a script
 * that just wants the values — is not made to destructure. There is one
 * implementation, because there used to be two: this one, and an unused
 * `resolveParams` in the backend's domain layer that computed the same thing
 * from a bare key list. Two resolvers eventually disagree, and the one that
 * disagrees silently is whichever a given call site happened to import.
 */
export function traceCapabilityParams(
  table: CapabilityParamTable,
  defaults: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>>,
): CapabilityParamResolution {
  const params: Record<string, CapabilityParamValue> = {}
  const trace: CapabilityParamTraceEntry[] = []

  for (const field of table) {
    const overridden = field.name in overrides
    const value = overridden ? overrides[field.name] : defaults[field.name]
    if (value === undefined || value === null) continue
    params[field.name] = value as CapabilityParamValue
    trace.push({
      name: field.name,
      value: value as CapabilityParamValue,
      source: overridden ? 'binding-override' : 'framework-default',
    })
  }

  const declared = new Set(table.map((f) => f.name))
  const unknownKeys = Object.keys(overrides)
    .filter((key) => !declared.has(key))
    .sort()

  return { params, trace, unknownKeys }
}
