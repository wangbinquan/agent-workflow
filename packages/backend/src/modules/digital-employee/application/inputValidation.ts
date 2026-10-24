import type { z } from 'zod'

import { ValidationError } from '@/util/errors'

/** 请求输入校验失败保持 typed 422；存储内容的解析不走这里。 */
export function parseEmployeeInput<T>(
  schema: { safeParse: (value: unknown) => z.ZodSafeParseResult<T> },
  value: unknown,
): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError(
      'validation-failed',
      parsed.error.issues[0]?.message ?? 'invalid input',
      {
        issues: parsed.error.issues.slice(0, 10),
      },
    )
  }
  return parsed.data
}
