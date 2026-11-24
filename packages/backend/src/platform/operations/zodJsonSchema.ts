import { z } from 'zod'

/** Input contracts retain the draft-07, inline, strip-object policy of zod-to-json-schema. */
export function toInputJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, {
    target: 'draft-07',
    io: 'input',
    reused: 'inline',
    cycles: 'throw',
    override: ({ zodSchema, jsonSchema }) => {
      // Zod's starts_with format is not a JSON Schema format; the pattern is sufficient.
      if (jsonSchema.format === 'starts_with') delete jsonSchema.format
      const def = zodSchema._zod.def
      if (def.type === 'object' && def.catchall === undefined) {
        jsonSchema.additionalProperties = false
      }
    },
  })
}

/** The SDK's input-mode emitter omits strip-object constraints; retain our published contract. */
export function withInputJsonSchema<T extends z.ZodType>(schema: T): T {
  return schema.meta(toInputJsonSchema(schema))
}
