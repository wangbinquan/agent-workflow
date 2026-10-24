import type { z } from 'zod'

import { ValidationError } from '@/util/errors'

/** 裸 ZodError 到中央 handler 会渲染成 500——统一折成 typed 422（仓内定式）。 */
export function parseOr422<T>(
  schema: { safeParse: (v: unknown) => z.ZodSafeParseResult<T> },
  rawInput: unknown,
): T {
  const parsed = schema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ValidationError(
      'mission-input-invalid',
      parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
        .slice(0, 500),
    )
  }
  return parsed.data
}
