// RFC-309 — the wire shape of a capability template.
//
// ONE template, not two layers. RFC-304 split this into a department
// "framework" (scripts + hooks) and a group "binding" (agents + prompts +
// params), and the split was a permission model wearing the clothes of a data
// model. The user's ruling: "不需要区分组织模版和小组模版了，就是一套模版，
// 大家可以复制修改就行了".
//
// ## What the merge keeps, and what it deliberately does not
//
// The PERMISSION boundary survives intact, because the reason for it is real:
// scripts and hooks run as the daemon with its whole credential surface. If
// "can edit a template" meant "can edit its scripts", template write access
// would BE daemon execution access — and it would become reachable by an API
// token for the first time, since the old framework write points were
// system-domain. So the gate moved from the object to the FIELD:
//
//   name / agentBySlot / promptBySlot / params  → capability-templates:update
//   scripts / hooks                             → + scripts:author
//
// A write that touches `scripts` or `hooks` without `scripts:author` is
// REJECTED WHOLE, not silently stripped of those fields. Quietly dropping a
// hook somebody wrote is how a team comes to believe their gate is running when
// it never was — and they would only find out from the absence of failures.
//
// What the merge does give up is stated in the RFC's capability-impact list:
// one framework shared by many bindings is gone, so a department fixing a
// script no longer changes every group's behaviour automatically. That relation
// becomes the T64 UPSTREAM link instead — visible, three-way, and applied when
// the group chooses.

import { z } from 'zod'
import { CapabilityParamTableSchema } from '../capabilityParams'

/** A script the framework runs at one of the monitor's four core steps. */
export const CapabilityScriptSchema = z
  .object({
    language: z.enum(['bash', 'python', 'node']),
    script: z.string(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict()

export const CapabilityScriptsSchema = z
  .object({
    entry: CapabilityScriptSchema.optional(),
    collect: CapabilityScriptSchema.optional(),
    classify: CapabilityScriptSchema.optional(),
    arbitrate: CapabilityScriptSchema.optional(),
    select: CapabilityScriptSchema.optional(),
  })
  .strict()

export const CapabilityHookSchema = z
  .object({
    stage: z.string().min(1),
    phase: z.enum(['pre', 'post']),
    language: z.enum(['bash', 'python', 'node']),
    script: z.string(),
    /** A non-blocking hook's failure is recorded, not fatal (design §4.3 F8). */
    blocking: z.boolean().default(true),
    stageContractVer: z.number().int().positive().optional(),
  })
  .strict()

/**
 * A template write.
 *
 * `.strict()` stays load-bearing: an unknown key is a rejection with a message
 * rather than a silent drop. What changed is that `scripts`/`hooks` are now
 * part of THIS schema — the field-level permission check
 * (`assertTemplateFieldsAllowed`) is what keeps them behind `scripts:author`,
 * not their absence from a second schema.
 */
export const CapabilityTemplateWriteSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    capability: z.string().min(1).max(64),
    /** Department-grade fields. Writing either requires `scripts:author`. */
    scripts: CapabilityScriptsSchema.default({}),
    hooks: z.array(CapabilityHookSchema).max(64).default([]),
    /** Declared parameters this template accepts; see `capabilityParams`. */
    paramSchema: CapabilityParamTableSchema.default([]),
    paramDefaults: z.record(z.string(), z.unknown()).default({}),
    /** Which agent fills each `agentSlot` of the stage contract. */
    agentBySlot: z.record(z.string(), z.string()).default({}),
    promptBySlot: z.record(z.string(), z.string()).default({}),
    /** Values chosen for the declared params. */
    params: z.record(z.string(), z.unknown()).default({}),
    stageContractVer: z.number().int().positive().default(1),
    visibility: z.enum(['private', 'public']).optional(),
  })
  .strict()
export type CapabilityTemplateWrite = z.infer<typeof CapabilityTemplateWriteSchema>

/**
 * The fields that require `scripts:author` on top of ordinary write access.
 *
 * Named as data rather than written into an `if`, so the route, the service and
 * the test all agree on the same list — and so adding a third dangerous field
 * later is one edit rather than three that can drift.
 */
export const TEMPLATE_PRIVILEGED_FIELDS = ['scripts', 'hooks'] as const
export type TemplatePrivilegedField = (typeof TEMPLATE_PRIVILEGED_FIELDS)[number]

export const CapabilityTemplateCopySchema = z
  .object({ name: z.string().min(1).max(200).optional() })
  .strict()

/** What a template looks like on the wire. */
export interface CapabilityTemplateWire {
  id: string
  name: string
  description: string | null
  capability: string
  /**
   * Absent — not empty — when the reader lacks `scripts:author`.
   *
   * Undefined rather than `{}` on purpose: an empty object is a claim that the
   * template has no scripts, which is false and would make a reader conclude
   * the template is broken. Absence says "you are not being shown this".
   */
  scripts?: z.infer<typeof CapabilityScriptsSchema>
  hooks?: Array<z.infer<typeof CapabilityHookSchema>>
  /** True when script bodies were withheld from this reader. */
  scriptsRedacted: boolean
  paramSchema: z.infer<typeof CapabilityParamTableSchema>
  paramDefaults: Record<string, unknown>
  /** Which agent fills each `agentSlot` of the stage contract. */
  agentBySlot: Record<string, string>
  promptBySlot: Record<string, string>
  params: Record<string, unknown>
  stageContractVer: number
  ownerUserId: string | null
  visibility: 'private' | 'public'
  builtin: boolean
  /**
   * Part of the export fence, alongside `updatedAt`.
   *
   * Both are required: exporting with an empty fence is not "no protection", it
   * is a 422 — and the page must DISABLE export rather than send a blank one,
   * because a caller who thinks they have what-you-see-is-what-you-get
   * protection and silently has none is worse off than one who gets an error.
   */
  aclRevision: number
  /**
   * RFC-304 T64 — where this was copied from, if anywhere.
   *
   * Load-bearing after RFC-309 in a way it was not before: copying IS how a
   * team gets a template now, so this is the only record of "these two came
   * from the same place" once the shared framework row is gone.
   */
  upstream: {
    upstreamId: string
    upstreamVersion: number
    baseDigest: string
  } | null
  createdAt: number
  updatedAt: number
}
