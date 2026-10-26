import type {
  SourceRow,
  TargetRow,
  TargetValue,
} from '@/platform/persistence/migration/conversion/types'

export function text(row: SourceRow, column: string): string {
  const value = row.values[column]
  if (typeof value !== 'string') throw new Error(`v2-task-source-text:${row.table}.${column}`)
  return value
}

export function nullableText(row: SourceRow, column: string): string | null {
  const value = row.values[column]
  return value == null ||
    (typeof value !== 'string' && row.codecTakeovers?.some((failure) => failure.column === column))
    ? null
    : text(row, column)
}

export function number(row: SourceRow, column: string): number {
  const value = row.values[column]
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error(`v2-task-source-number:${row.table}.${column}`)
  return value
}

export function pick(row: SourceRow, columns: readonly string[]): TargetRow {
  return Object.fromEntries(columns.map((column) => [column, row.values[column] as TargetValue]))
}

export function jsonObject(value: string | null): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = value === null ? null : JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null
  } catch {
    return null
  }
}
