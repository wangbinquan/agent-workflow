import { RFC349_SOURCE_TABLES } from './contractTypes'

export function assertExactSchemaRoster(
  actualInput: readonly string[],
  expectedInput: readonly string[] = RFC349_SOURCE_TABLES,
): void {
  const actual = [...actualInput].sort()
  const expected = [...expectedInput].sort()
  const duplicate = actual.find((name, index) => name === actual[index - 1])
  if (duplicate !== undefined) {
    throw new Error(`RFC-349 schema roster has duplicate table ${duplicate}`)
  }
  if (JSON.stringify(actual) === JSON.stringify(expected)) return
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = expected.filter((name) => !actualSet.has(name))
  const extra = actual.filter((name) => !expectedSet.has(name))
  throw new Error(
    `RFC-349 schema roster drift (missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'})`,
  )
}
