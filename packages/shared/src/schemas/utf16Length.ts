import { z } from 'zod'

type LengthCheck =
  | ReturnType<typeof z.minLength>
  | ReturnType<typeof z.maxLength>
  | ReturnType<typeof z.length>

/**
 * Zod 4.6 counts string lengths in code points; existing wire limits use JS
 * UTF-16 units. Keep native check metadata for JSON Schema and error mapping,
 * replacing only the length calculation on these locally created checks.
 */
function countUtf16<T extends LengthCheck>(check: T): T {
  const def = check._zod.def
  check._zod.check = (payload) => {
    const input = payload.value
    const length = input.length
    const bound =
      def.check === 'min_length'
        ? def.minimum
        : def.check === 'max_length'
          ? def.maximum
          : def.length
    if (
      def.check === 'min_length'
        ? length >= bound
        : def.check === 'max_length'
          ? length <= bound
          : length === bound
    )
      return
    payload.issues.push({
      origin: 'string',
      ...(length > bound
        ? { code: 'too_big', maximum: bound }
        : { code: 'too_small', minimum: bound }),
      inclusive: true,
      ...(def.check === 'length_equals' ? { exact: true } : {}),
      input,
      inst: check,
      continue: !def.abort,
    })
  }
  return check
}

export function utf16MinLength(...args: Parameters<typeof z.minLength>): z.core.$ZodCheck<string> {
  return countUtf16(z.minLength(...args))
}

export function utf16MaxLength(...args: Parameters<typeof z.maxLength>): z.core.$ZodCheck<string> {
  return countUtf16(z.maxLength(...args))
}

export function utf16Length(...args: Parameters<typeof z.length>): z.core.$ZodCheck<string> {
  return countUtf16(z.length(...args))
}
