// RFC-616 §6.3 — what an employee type declares for process metrics.
//
// A type package may say which of its work items are rework, and its context codec may point out the feedback
// people wrote in a context. Both members are optional and both answers cross the type boundary as JSON
// documents; this file owns their shapes. The common module never reads a type's own content, so an answer it
// cannot validate — or a type that throws while producing one — counts as "not provided", never as an empty one:
// an empty answer would be reported as a measured zero.

import { z } from 'zod'

const processMetricsDeclarationSchema = z
  .object({
    /** Work items whose job is repairing something that came back. Bounded like a manifest's work items. */
    reworkWorkItemRefs: z.array(z.string().min(1)).max(200),
  })
  .strict()

const humanFeedbackItemSchema = z
  .object({
    text: z.string().min(1),
    /** Epoch milliseconds; 0 when the type has no time for the item. */
    at: z.number().int().nonnegative(),
    /** The work item that handles this feedback, when the type knows it. */
    workItemRef: z.string().min(1).optional(),
  })
  .strict()

const humanFeedbackProjectionSchema = z.object({ items: z.array(humanFeedbackItemSchema) }).strict()

export type EmployeeProcessMetricsDeclaration = z.infer<typeof processMetricsDeclarationSchema>
export type EmployeeHumanFeedbackItem = z.infer<typeof humanFeedbackItemSchema>

function provided<T>(schema: z.ZodType<T>, produce: () => string): T | null {
  try {
    return schema.parse(JSON.parse(produce()) as unknown)
  } catch {
    return null
  }
}

/** Runs a type package's `describeProcessMetricsJson` and decodes its answer. */
export function readProcessMetricsDeclaration(
  describe: () => string,
): EmployeeProcessMetricsDeclaration | null {
  return provided(processMetricsDeclarationSchema, describe)
}

/** Runs a context codec's `projectHumanFeedbackJson` for one context and decodes its answer. */
export function readHumanFeedbackProjection(
  project: () => string,
): readonly EmployeeHumanFeedbackItem[] | null {
  return provided(humanFeedbackProjectionSchema, project)?.items ?? null
}
