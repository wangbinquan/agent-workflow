// RFC-099 — resource-level ownership ACL schemas.
//
// Six resource types (agent / skill / mcp / plugin / workflow / workgroup)
// carry a single
// owner + a per-user grant list + a 'public' switch. Granted users can view
// and use; owner and `resource-acl:bypass` holders can modify / delete /
// transfer / manage grants. Non-granted actors without bypass must not observe the resource at all
// (lists filter, detail 404s).
//
// TaskActorRole is the task-relationship role snapshot recorded on review
// comments / review decisions / clarify submissions (D7/D17): member identity
// wins over global bypass authority — legacy 'admin'/'manager' labels are only
// recorded when a non-member permission holder steps in. These snapshots are UI/audit-only and must never
// reach agent prompts.

import { z } from 'zod'
import { UserPublicSchema } from './user'

export const ACL_RESOURCE_TYPES = [
  'agent',
  'skill',
  'mcp',
  'plugin',
  'workflow',
  'workgroup', // RFC-164 — sixth resource type
  // RFC-304 T13/T57 → RFC-309 — ONE capability template type. RFC-304 kept two
  // because the department layer carried scripts that run as the daemon and the
  // group layer deliberately could not, so granting one had to not grant the
  // other. That property now lives one level down, as a field-level
  // `scripts:author` check inside a single row, which is what lets this be one
  // ACL type without handing template owners the daemon.
  'capability_template',
] as const

/**
 * The resource types a CONFIG PACKAGE can carry.
 *
 * A subset of `AclResourceType`, and a separate constant on purpose. The two
 * sets were identical until RFC-304 added the capability template layers, which
 * have row-level ACLs but no bundle ops — T17a is the task that would add them,
 * and it is not done. Keying the bundle machinery off `AclResourceType` made
 * "has an ACL" and "can be packaged" the same claim; the first type where they
 * differ would otherwise have silently acquired a half-built export path that
 * type-checks and produces nothing.
 */
export const BUNDLE_RESOURCE_TYPES = [
  'agent',
  'skill',
  'mcp',
  'plugin',
  'workflow',
  'workgroup',
  // RFC-304 T17a → RFC-309 — one packaged template type. Importing one is host
  // code execution on the destination instance when its payload holds script
  // bodies, so the import path applies the same field-level `scripts:author`
  // check the HTTP route does — a package is only another way to write the same
  // row, and must not be a way around the rule.
  'capability_template',
] as const
export type BundleResourceType = (typeof BUNDLE_RESOURCE_TYPES)[number]
// `ResourcePackageType` in `./resourcePackage` is this same set, derived from
// this constant — the wire name for it. Two names, one list.

/**
 * The resource types an INTENT session can create.
 *
 * Same reasoning as `BUNDLE_RESOURCE_TYPES`, and the same six: an intent
 * conversation produces work resources, not the platform's own capability
 * templates. `intent_provenance.resource_type` is stored against this set.
 */
/**
 * Narrow an ACL type to a package-carryable one, or null.
 *
 * The one conversion point between the two sets. It returns null rather than
 * throwing so each caller phrases the refusal in its own terms — a CLI flag, an
 * HTTP body and an export root all need different wording for the same fact:
 * config packages do not carry capability templates yet (RFC-304 T17a).
 */
export function asBundleResourceType(value: AclResourceType): BundleResourceType | null {
  return (BUNDLE_RESOURCE_TYPES as readonly string[]).includes(value)
    ? (value as BundleResourceType)
    : null
}

export const INTENT_RESOURCE_TYPES = [
  'agent',
  'skill',
  'mcp',
  'plugin',
  'workflow',
  'workgroup',
] as const
export type IntentResourceType = (typeof INTENT_RESOURCE_TYPES)[number]

/**
 * Narrow an ACL type to one an Intent session can create, or null.
 *
 * This USED to alias `asBundleResourceType`, back when the two sets were the
 * same six — with a note saying it would become a real function the day they
 * diverged. RFC-304 T17a is that day: config packages now carry the capability
 * template layers and Intent sessions still cannot create them. Having named
 * the two questions separately is what made this a one-line change rather than
 * a hunt through every "bundle" call that meant "intent".
 */
export function asIntentResourceType(value: AclResourceType): IntentResourceType | null {
  return (INTENT_RESOURCE_TYPES as readonly string[]).includes(value)
    ? (value as IntentResourceType)
    : null
}

export const AclResourceTypeSchema = z.enum(ACL_RESOURCE_TYPES)
export type AclResourceType = z.infer<typeof AclResourceTypeSchema>

export const ResourceVisibilitySchema = z.enum(['private', 'public'])
export type ResourceVisibility = z.infer<typeof ResourceVisibilitySchema>

// RFC-222/RFC-305 — an ACL-bypass actor acting on a task from outside its
// membership is attributed truthfully, not folded into 'admin'.
export const TaskActorRoleSchema = z.enum(['owner', 'user', 'admin', 'manager'])
export type TaskActorRole = z.infer<typeof TaskActorRoleSchema>

/** GET /api/{res}/:id/acl response. */
export const ResourceAclSchema = z.object({
  resourceType: AclResourceTypeSchema,
  resourceId: z.string().min(1),
  ownerUserId: z.string().min(1).nullable(),
  /** Public projection of the owner row; null when owner is '__system__' or the user row vanished. */
  owner: UserPublicSchema.nullable(),
  visibility: ResourceVisibilitySchema,
  users: z.array(UserPublicSchema),
  /** True when the current actor may PUT this ACL (owner or `resource-acl:bypass`). */
  canManage: z.boolean(),
  /**
   * RFC-170 §8 — monotonic ACL revision. The client holds this from GET and
   * echoes it as `expectedAclRevision` on PUT; the server CAS-rejects (409) a
   * write whose expected revision no longer matches, so a stale request (e.g.
   * paused mid-edit while an admin transferred the owner) cannot silently
   * reinstate a revoked grant or re-take ownership.
   */
  aclRevision: z.number().int().nonnegative(),
})
export type ResourceAcl = z.infer<typeof ResourceAclSchema>

/**
 * PUT /api/{res}/:id/acl body. `userIds` is full-replace semantics. At least
 * one field must be present. Owner transfer keeps the previous owner in the
 * grant list (server-side) so they don't lock themselves out.
 */
export const UpdateResourceAclBodySchema = z
  .object({
    ownerUserId: z.string().min(1).optional(),
    visibility: ResourceVisibilitySchema.optional(),
    userIds: z.array(z.string().min(1)).max(256).optional(),
    /**
     * RFC-223 — mandatory OCC fence. Every mutation must bind the immutable
     * resource id and the exact ACL revision observed by the client. Optional
     * legacy last-write-wins would let a paused former owner mutate ACL state
     * after a concurrent transfer.
     */
    expectedResourceId: z.string().min(1),
    expectedAclRevision: z.number().int().nonnegative(),
  })
  .refine(
    (b) => b.ownerUserId !== undefined || b.visibility !== undefined || b.userIds !== undefined,
    { message: 'at least one of ownerUserId / visibility / userIds is required' },
  )
export type UpdateResourceAclBody = z.infer<typeof UpdateResourceAclBodySchema>

/** Per-question attribution entry (clarify collaborative drafts, D8/D14). */
export const ClarifyAnswerAttributionSchema = z.object({
  userId: z.string().min(1),
  role: TaskActorRoleSchema,
  updatedAt: z.number().int().nonnegative(),
})
export type ClarifyAnswerAttribution = z.infer<typeof ClarifyAnswerAttributionSchema>

/** Record<questionId, attribution> — the shape stored in clarify_rounds.answer_attributions_json. */
export const ClarifyAnswerAttributionsSchema = z.record(z.string(), ClarifyAnswerAttributionSchema)
export type ClarifyAnswerAttributions = z.infer<typeof ClarifyAnswerAttributionsSchema>

/**
 * PUT /api/clarify/:nodeRunId/draft body — one question per call
 * (per-question last-write-wins, D14). The value mirrors the ClarifyAnswer
 * user-state shape (option indices + custom text); labels are refilled
 * server-side at submit like the answers path.
 */
export const ClarifyDraftSaveBodySchema = z.object({
  roundId: z.string().min(1),
  questionId: z.string().min(1),
  selectedOptionIndices: z.array(z.number().int().nonnegative()).max(64).default([]),
  customText: z.string().max(65536).default(''),
})
export type ClarifyDraftSaveBody = z.infer<typeof ClarifyDraftSaveBodySchema>

/** Per-question draft value stored in clarify_rounds.draft_answers_json. */
export const ClarifyDraftValueSchema = z.object({
  selectedOptionIndices: z.array(z.number().int().nonnegative()).default([]),
  customText: z.string().default(''),
})
export type ClarifyDraftValue = z.infer<typeof ClarifyDraftValueSchema>

/** 422 payload listing references the editor may not use (D15 save-time check). */
export const AclMissingRefSchema = z.object({
  type: AclResourceTypeSchema,
  name: z.string().min(1),
})
export type AclMissingRef = z.infer<typeof AclMissingRefSchema>
