// RFC-211 — guided onboarding sandbox wire contracts.
//
// A "run" is one user walking one tutorial track. Everything created inside a
// run is an `example` artifact: owned by that user, private, named with the
// run's shared lowercase suffix, and swept by the one-click cleanup.
//
// The suffix is not cosmetic. agents/skills/workgroups have a GLOBALLY unique
// name and their name-collision 409 echoes the requested name back with no ACL
// filter, so a fixed guide name would (a) wedge the second concurrent learner
// and (b) let anyone probe whether another user's private resource exists,
// which RFC-099 D1 forbids.

import { z } from 'zod'

/** The four tutorial tracks. Each covers a slice of the six core actions. */
export const ONBOARDING_TRACKS = ['agent', 'skill', 'workflow', 'workgroup'] as const
export const OnboardingTrackSchema = z.enum(ONBOARDING_TRACKS)
export type OnboardingTrack = z.infer<typeof OnboardingTrackSchema>

/**
 * Step keys, namespaced by track. Kept as one flat enum (not per-track unions)
 * so `completedSteps` stays a plain string array on the wire and the frontend
 * can key i18n off a single map.
 */
export const ONBOARDING_STEPS = [
  // track: agent — build something that can actually do work
  'agent.create',
  'agent.ports',
  'agent.run',
  // track: skill — teach an agent a reusable procedure
  'skill.create',
  'skill.attach',
  // track: workflow — chain agents into a pipeline
  'workflow.create',
  'workflow.edit',
  'workflow.run',
  // track: workgroup — let a team of agents collaborate
  'workgroup.create',
  'workgroup.members',
  'workgroup.run',
] as const
export const OnboardingStepSchema = z.enum(ONBOARDING_STEPS)
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>

/** Which steps belong to which track, in presentation order. */
export const ONBOARDING_TRACK_STEPS: Readonly<Record<OnboardingTrack, readonly OnboardingStep[]>> =
  {
    agent: ['agent.create', 'agent.ports', 'agent.run'],
    skill: ['skill.create', 'skill.attach'],
    workflow: ['workflow.create', 'workflow.edit', 'workflow.run'],
    workgroup: ['workgroup.create', 'workgroup.members', 'workgroup.run'],
  }

export const ONBOARDING_RUN_STATUSES = ['active', 'completed', 'abandoned'] as const
export const OnboardingRunStatusSchema = z.enum(ONBOARDING_RUN_STATUSES)
export type OnboardingRunStatus = z.infer<typeof OnboardingRunStatusSchema>

/** The five resource kinds a run can produce. */
export const ONBOARDING_ARTIFACT_TYPES = [
  'agent',
  'skill',
  'workflow',
  'workgroup',
  'task',
] as const
export const OnboardingArtifactTypeSchema = z.enum(ONBOARDING_ARTIFACT_TYPES)
export type OnboardingArtifactType = z.infer<typeof OnboardingArtifactTypeSchema>

export const OnboardingArtifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  resourceType: OnboardingArtifactTypeSchema,
  /** Resource PRIMARY KEY — never the name (renames keep the id). */
  resourceId: z.string(),
  /** Live name, re-read at response time; falls back to the creation snapshot. */
  resourceName: z.string(),
  /** False once the user deleted the resource behind the guide's back. */
  alive: z.boolean(),
  createdAt: z.number().int(),
})
export type OnboardingArtifact = z.infer<typeof OnboardingArtifactSchema>

export const OnboardingRunSchema = z.object({
  id: z.string(),
  track: OnboardingTrackSchema,
  status: OnboardingRunStatusSchema,
  currentStep: OnboardingStepSchema.nullable(),
  completedSteps: z.array(OnboardingStepSchema),
  suffix: z.string(),
  artifacts: z.array(OnboardingArtifactSchema),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type OnboardingRun = z.infer<typeof OnboardingRunSchema>

export const StartOnboardingRunSchema = z.object({ track: OnboardingTrackSchema }).strict()
export type StartOnboardingRun = z.infer<typeof StartOnboardingRunSchema>

export const PatchOnboardingRunSchema = z
  .object({
    currentStep: OnboardingStepSchema.nullable().optional(),
    completedSteps: z.array(OnboardingStepSchema).optional(),
    status: OnboardingRunStatusSchema.optional(),
  })
  .strict()
export type PatchOnboardingRun = z.infer<typeof PatchOnboardingRunSchema>

export const ProvisionOnboardingStepSchema = z.object({ step: OnboardingStepSchema }).strict()
export type ProvisionOnboardingStep = z.infer<typeof ProvisionOnboardingStepSchema>

/**
 * "我自己来": the user built the resource through the normal form; the guide
 * asks the server to adopt it into the run. Adoption is what flips the row to
 * private + example, so it happens server-side — the guide never has to poll
 * a list and guess whether the user finished.
 */
export const AdoptOnboardingResourceSchema = z
  .object({
    step: OnboardingStepSchema,
    resourceType: OnboardingArtifactTypeSchema,
    /**
     * Name for agent/skill/workgroup; id for workflows (names are not unique)
     * and for tasks. Tasks are adopted rather than provisioned: the guide
     * launches them through the normal launch endpoints so they go through the
     * real permission and space-resolution path, and `tasks.example` is derived
     * from the source resource at INSERT time.
     */
    resourceKey: z.string().min(1),
  })
  .strict()
export type AdoptOnboardingResource = z.infer<typeof AdoptOnboardingResourceSchema>

export const ProvisionOnboardingResultSchema = z.object({
  step: OnboardingStepSchema,
  /** Where the guide should send the user to look at (and edit) what it built. */
  resourceType: OnboardingArtifactTypeSchema,
  resourceId: z.string(),
  resourceName: z.string(),
  /** True when the step was already provisioned and this call was a no-op. */
  reused: z.boolean(),
  run: OnboardingRunSchema,
})
export type ProvisionOnboardingResult = z.infer<typeof ProvisionOnboardingResultSchema>

/** One row of the cleanup preview / result. */
export const ExampleInventoryEntrySchema = z.object({
  resourceType: OnboardingArtifactTypeSchema,
  resourceId: z.string(),
  resourceName: z.string(),
  ownerUserId: z.string().nullable(),
})
export type ExampleInventoryEntry = z.infer<typeof ExampleInventoryEntrySchema>

export const ExampleInventorySchema = z.object({
  scope: z.enum(['mine', 'all']),
  entries: z.array(ExampleInventoryEntrySchema),
})
export type ExampleInventory = z.infer<typeof ExampleInventorySchema>

export const EXAMPLE_CLEANUP_OUTCOMES = ['deleted', 'skipped', 'failed'] as const
export const ExampleCleanupOutcomeSchema = z.enum(EXAMPLE_CLEANUP_OUTCOMES)
export type ExampleCleanupOutcome = z.infer<typeof ExampleCleanupOutcomeSchema>

export const ExampleCleanupItemSchema = z.object({
  resourceType: OnboardingArtifactTypeSchema,
  resourceId: z.string(),
  resourceName: z.string(),
  outcome: ExampleCleanupOutcomeSchema,
  /** Backend DomainError code when the item was skipped or failed. */
  code: z.string().optional(),
  message: z.string().optional(),
})
export type ExampleCleanupItem = z.infer<typeof ExampleCleanupItemSchema>

/**
 * Cleanup spans DB rows AND the filesystem, and dbTxSync bodies must be
 * synchronous — so one big transaction is impossible by construction. The
 * contract is therefore per-item and idempotent-on-retry: pressing the button
 * again simply re-runs against whatever is still flagged `example`.
 */
export const ExampleCleanupResultSchema = z.object({
  complete: z.boolean(),
  items: z.array(ExampleCleanupItemSchema),
})
export type ExampleCleanupResult = z.infer<typeof ExampleCleanupResultSchema>
