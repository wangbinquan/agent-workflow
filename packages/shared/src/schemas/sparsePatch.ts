import { z } from 'zod'

type WithoutDefault<T extends z.ZodType> =
  T extends z.ZodDefault<infer Inner extends z.ZodType> ? Inner : T

/** Keep omitted PATCH fields absent: Zod 4 otherwise applies defaults inside optional(). */
export function sparsePatch<
  Shape extends Record<string, z.ZodType>,
  Config extends z.core.$ZodObjectConfig,
>(schema: z.ZodObject<Shape, Config>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      key,
      field instanceof z.ZodDefault ? field.unwrap() : field,
    ]),
  ) as { [K in keyof Shape]: WithoutDefault<Shape[K]> }
  return schema.extend(shape).partial()
}
