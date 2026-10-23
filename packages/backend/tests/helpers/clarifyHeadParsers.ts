// RFC-395 II-a A4: byte-copied HEAD 67ab6b9ae parsers pin the legacy projection shapes.
import type { ClarifyAnswer } from '@agent-workflow/shared'

export function parseAnswersArray(json: string | null): ClarifyAnswer[] {
  if (json === null) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as ClarifyAnswer[]) : []
  } catch {
    return []
  }
}

function safeParseArray<T>(json: string | null): T[] | undefined {
  if (json === null) return undefined
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as T[]) : undefined
  } catch {
    return undefined
  }
}

function parseAnswers(json: string | null): ClarifyAnswer[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as ClarifyAnswer[]) : []
  } catch {
    return []
  }
}

function parseArray<T>(value: string | null): T[] | undefined {
  if (value === null) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : undefined
  } catch {
    return undefined
  }
}

function parseJsonRecord<T>(raw: string | null): T | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as T
  } catch {
    return null
  }
}

export { safeParseArray, parseAnswers, parseArray, parseJsonRecord }
