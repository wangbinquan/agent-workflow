import { z } from 'zod'

export type ContainmentJsonPrimitive = null | boolean | number | string
export type ContainmentJsonValue =
  | ContainmentJsonPrimitive
  | ContainmentJsonValue[]
  | { [key: string]: ContainmentJsonValue }
export type ContainmentJsonObject = { [key: string]: ContainmentJsonValue }

const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function isContainmentJsonValue(
  value: unknown,
  seen: Set<object> = new Set(),
): value is ContainmentJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true
  }
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) {
    const valid = value.every((entry) => isContainmentJsonValue(entry, seen))
    seen.delete(value)
    return valid
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    seen.delete(value)
    return false
  }
  for (const [key, entry] of Object.entries(value)) {
    if (POISON_KEYS.has(key) || !isContainmentJsonValue(entry, seen)) {
      seen.delete(value)
      return false
    }
  }
  seen.delete(value)
  return true
}

export const ContainmentJsonValueSchema = z.custom<ContainmentJsonValue>(
  isContainmentJsonValue,
  'expected finite JSON value',
)
export const ContainmentJsonObjectSchema = z.custom<ContainmentJsonObject>(
  (value) =>
    isContainmentJsonValue(value) &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value === 'object',
  'expected plain JSON object',
)

export interface PreparedChildContainmentPlan {
  providerId: string
  config: ContainmentJsonValue
}

export const PreparedChildContainmentPlanSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    config: ContainmentJsonValueSchema,
  })
  .strict()
