// RFC-370 §9.2 V9 — hosted assembly lives only in bootstrap and reaches only
// the PostgreSQL daemon root. A hosted deployment always runs on PostgreSQL, so
// the SQLite root composes the standalone owners directly and refuses any
// hosted-only selection instead of silently threading it through.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOSTED_ONLY_SELECTIONS, standaloneSelectionsOf } from '@/cli/start'

type ComposeInput = Parameters<typeof standaloneSelectionsOf>[0]

test('the SQLite root refuses every hosted-only selection by name', () => {
  const base = { provider: { provider: 'sqlite' } } as unknown as ComposeInput
  expect(standaloneSelectionsOf(base)).toBe(base)
  for (const key of HOSTED_ONLY_SELECTIONS) {
    const withHosted = { ...base, [key]: {} } as ComposeInput
    expect(() => standaloneSelectionsOf(withHosted)).toThrow(
      `hosted-deployment-requires-postgresql: ${key}`,
    )
  }
})

test('the SQLite composer body never reads a hosted-only selection', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')
  const start = source.indexOf('async function composeSqliteProviderSession(')
  expect(start).toBeGreaterThan(0)
  const body = source.slice(start)
  for (const key of HOSTED_ONLY_SELECTIONS) expect(body).not.toContain(`input.${key}`)
})
