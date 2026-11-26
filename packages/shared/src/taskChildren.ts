// RFC-602: the child navigation consumer needs identities and live states, not task detail rows.
import { z } from 'zod'
import { TaskStatusSchema } from './schemas/task'

export const TaskChildSummarySchema = z
  .object({ id: z.string().min(1), status: TaskStatusSchema })
  .strict()
export type TaskChildSummary = z.infer<typeof TaskChildSummarySchema>

export const TaskChildrenPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    parentTaskId: z.string().min(1),
    items: z.array(TaskChildSummarySchema).max(200),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict()
export type TaskChildrenPage = z.infer<typeof TaskChildrenPageSchema>
