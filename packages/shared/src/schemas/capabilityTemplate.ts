// RFC-304 §2.5 / T57 — the wire shapes of the two capability template layers.
//
// The split is a permission model wearing the clothes of a data model:
//
//   framework (department) — scripts + hooks. These run as the daemon, with its
//                            whole credential surface, so writing one requires
//                            `scripts:author` ON TOP of resource write access.
//   binding   (group)      — which agent fills which AI slot, prompts, params.
//                            No scripts, no hooks. That absence is what lets a
//                            group lead own their binding without being handed
//                            the daemon.
//
// The binding schema is `.strict()` and has no script or hook field, so a write
// carrying one is REJECTED rather than stripped. Silently dropping a hook
// somebody wrote is how a team comes to believe their gate is running when it
// never was — and they would only find out from the absence of failures.

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

export const CapabilityFrameworkWriteSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    capability: z.string().min(1).max(64),
    scripts: CapabilityScriptsSchema.default({}),
    hooks: z.array(CapabilityHookSchema).max(64).default([]),
    /** Declared parameters a binding may override; see `capabilityParams`. */
    paramSchema: CapabilityParamTableSchema.default([]),
    paramDefaults: z.record(z.string(), z.unknown()).default({}),
    stageContractVer: z.number().int().positive().default(1),
    visibility: z.enum(['private', 'public']).optional(),
  })
  .strict()
export type CapabilityFrameworkWrite = z.infer<typeof CapabilityFrameworkWriteSchema>

/**
 * A binding write.
 *
 * `.strict()` is load-bearing here rather than stylistic: it is what turns a
 * payload carrying `scripts` or `hooks` into a rejection with a message, which
 * is the whole point of the two-layer split. `rejectFrameworkOnlyFields` runs
 * first so the message names the layer rather than saying "unrecognized key".
 */
export const CapabilityBindingWriteSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    frameworkId: z.string().min(1),
    /** Which agent fills each `agentSlot` of the stage contract. */
    agentBySlot: z.record(z.string(), z.string()).default({}),
    promptBySlot: z.record(z.string(), z.string()).default({}),
    /** Overrides for the framework's defaults, validated against its schema. */
    params: z.record(z.string(), z.unknown()).default({}),
    visibility: z.enum(['private', 'public']).optional(),
  })
  .strict()
export type CapabilityBindingWrite = z.infer<typeof CapabilityBindingWriteSchema>

export const CapabilityTemplateCopySchema = z
  .object({ name: z.string().min(1).max(200).optional() })
  .strict()

/** What a framework looks like on the wire. */
export interface CapabilityFrameworkWire {
  id: string
  name: string
  description: string | null
  capability: string
  /**
   * Absent — not empty — when the reader lacks `scripts:author`.
   *
   * Undefined rather than `{}` on purpose: an empty object is a claim that the
   * framework has no scripts, which is false and would make a reader conclude
   * the template is broken. Absence says "you are not being shown this".
   */
  scripts?: z.infer<typeof CapabilityScriptsSchema>
  hooks?: Array<z.infer<typeof CapabilityHookSchema>>
  /** True when script bodies were withheld from this reader. */
  scriptsRedacted: boolean
  paramSchema: z.infer<typeof CapabilityParamTableSchema>
  paramDefaults: Record<string, unknown>
  stageContractVer: number
  ownerUserId: string | null
  visibility: 'private' | 'public'
  builtin: boolean
  createdAt: number
  updatedAt: number
}

export interface CapabilityBindingWire {
  id: string
  name: string
  description: string | null
  frameworkId: string
  agentBySlot: Record<string, string>
  promptBySlot: Record<string, string>
  params: Record<string, unknown>
  ownerUserId: string | null
  visibility: 'private' | 'public'
  builtin: boolean
  createdAt: number
  updatedAt: number
}
