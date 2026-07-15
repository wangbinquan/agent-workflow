// RFC-190: shared types for GET /api/overview — the homepage capability
// portal's aggregate-counts endpoint.
//
// Backend computes, frontend renders. per-key null semantics mirror the
// coarse permission gates of the corresponding LIST routes (backend
// server.ts gate block): a key whose list route sits behind a `<res>:read`
// gate is null when the actor lacks that permission (counts must not leak
// existence); workgroups / scheduled-tasks list routes have no coarse gate
// (row-level filtering only), so those keys are always numbers. `tasks` is
// null only when the actor holds neither tasks:read:all nor tasks:read:own.
// Every number is "rows this actor would see on the list page" — the
// backend oracle test locks that equality per actor.

import { z } from 'zod'

export const OverviewResourcesSchema = z.object({
  agents: z.number().int().nonnegative().nullable(),
  skills: z.number().int().nonnegative().nullable(),
  mcps: z.number().int().nonnegative().nullable(),
  plugins: z.number().int().nonnegative().nullable(),
  workflows: z.number().int().nonnegative().nullable(),
  workgroups: z.number().int().nonnegative(),
  repos: z.number().int().nonnegative().nullable(),
  scheduled: z.number().int().nonnegative(),
  memories: z.number().int().nonnegative().nullable(),
})
export type OverviewResources = z.infer<typeof OverviewResourcesSchema>

export const OverviewTasksSchema = z.object({
  running: z.number().int().nonnegative(),
  awaiting: z.number().int().nonnegative(),
  done7d: z.number().int().nonnegative(),
  failed7d: z.number().int().nonnegative(),
})
export type OverviewTasks = z.infer<typeof OverviewTasksSchema>

export const OverviewResponseSchema = z.object({
  resources: OverviewResourcesSchema,
  tasks: OverviewTasksSchema.nullable(),
  generatedAt: z.string(),
})
export type OverviewResponse = z.infer<typeof OverviewResponseSchema>
