import { z } from 'zod'

export const HostExecutionGroupSchema = z.enum([
  'task',
  'intent',
  'purpose',
  'diagnostics',
  'verification',
  'memory',
  'development',
  'digital-employee',
  'event-dispatch',
  'knowledge',
  'maintenance',
])
export type HostExecutionGroup = z.infer<typeof HostExecutionGroupSchema>

export const HostExecutionSnapshotSchema = z
  .object({
    phase: z.enum(['standby', 'preparing', 'active', 'draining', 'closed']),
    generation: z.string().min(1),
    readyGroups: z.array(HostExecutionGroupSchema),
    reason: z.string().nullable(),
  })
  .strict()

/** Native installations retain their existing owner-specific diagnostics.
 * A selected installation reports the same actual root authority snapshot. */
export const HostExecutionStatusSchema = z.union([
  z.object({ mode: z.literal('native'), status: z.null() }).strict(),
  z
    .object({
      mode: z.enum(['execution', 'resource-only']),
      status: HostExecutionSnapshotSchema,
    })
    .strict(),
])
export type HostExecutionStatus = z.infer<typeof HostExecutionStatusSchema>

export function isHostExecutionGroupReady(
  view: HostExecutionStatus,
  group: HostExecutionGroup,
): boolean {
  return (
    view.mode === 'native' ||
    (view.mode === 'execution' &&
      view.status.phase === 'active' &&
      view.status.readyGroups.includes(group))
  )
}
