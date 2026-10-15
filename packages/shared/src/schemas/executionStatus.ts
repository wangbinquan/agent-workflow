import { z } from 'zod'

/**
 * RFC-370 v2 H7 — the kind of execution a route starts. Every grouped request
 * needs the instance's execution authority; resource reads and edits never do.
 */
export const ExecutionGroupSchema = z.enum([
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
export type ExecutionGroup = z.infer<typeof ExecutionGroupSchema>

/**
 * Standalone installations are always `active`. A CrewStation-hosted instance
 * serves resources while `standby`, executes while `active`, and is `frozen`
 * once it has handed execution over (it then exits and restarts as standby).
 */
export const ExecutionStatusSchema = z
  .object({
    mode: z.enum(['standalone', 'crewstation']),
    state: z.enum(['active', 'standby', 'frozen']),
    reason: z.string().nullable(),
    unavailableGroups: z.record(ExecutionGroupSchema, z.string()).optional(),
  })
  .strict()
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>

export function isExecutionAvailable(status: ExecutionStatus, group?: ExecutionGroup): boolean {
  return (
    status.state === 'active' &&
    (group === undefined || status.unavailableGroups?.[group] === undefined)
  )
}
