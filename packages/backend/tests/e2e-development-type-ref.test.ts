// Guard: e2e specs name the built-in development employee type through
// e2e/development-type-ref.ts, never as a hand-copied `development@N`.
//
// WHY THIS EXISTS
// ---------------
// The built-in package is republished whenever its descriptor changes, and its
// revision moves with it. A spec that still names the old revision stops testing
// anything: every request answers 404 `employee-type-not-found`. It happened
// twice — `development%406` after the bump to 7 (see
// e2e/rfc310-zero-config-onboarding.spec.ts), and `development@10` after RFC-371
// published 11, which kept e2e-full-nightly and e2e-webkit-nightly red from
// 2026-10-12 (e2e/rfc319-de-and-resource-lifecycle.spec.ts DE-02 / DE-10).
//
// Deliberate legacy fixtures stay possible: seeding an old revision as data
// (`typeRef: { typeId: 'development', revision: 4 }`) or watching for requests to
// it is not a reference to the current type and is not matched here.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import { DEVELOPMENT_TYPE_PATH, DEVELOPMENT_TYPE_REF } from '../../../e2e/development-type-ref'

const E2E_DIR = resolve(import.meta.dir, '..', '..', '..', 'e2e')

function e2eSources(): { name: string; code: string }[] {
  return readdirSync(E2E_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, code: withoutComments(readFileSync(join(E2E_DIR, name), 'utf8')) }))
}

/** Comments may quote the old mistake; only code counts. */
function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * A string that starts with a pinned development revision, or a constant holding
 * the bare type id — the parts a reference gets hand-built from (`TYPE_ID` +
 * `TYPE_REVISION = 10` was the 2026-10-12 shape).
 */
function hardCodedRevisions(code: string): string[] {
  return [
    ...code.matchAll(/['"`]development(?:@|%40)\d+/g),
    ...code.matchAll(/\bconst\s+[A-Z_][A-Z0-9_]*\s*=\s*['"`]development['"`]/g),
  ].map((match) => match[0])
}

describe('e2e specs follow the current built-in development type', () => {
  test('the shared reference is the one the production descriptor publishes', () => {
    const { typeRef } = JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
      typeRef: { typeId: string; revision: number }
    }
    expect(DEVELOPMENT_TYPE_REF).toBe(`${typeRef.typeId}@${typeRef.revision}`)
    expect(DEVELOPMENT_TYPE_PATH).toBe(`${typeRef.typeId}%40${typeRef.revision}`)
  })

  test('no e2e source pins a development revision', () => {
    const sources = e2eSources()
    expect(sources.length).toBeGreaterThan(20)
    const offenders = sources.flatMap(({ name, code }) =>
      hardCodedRevisions(code).map((hit) => `${name}: ${hit}`),
    )
    expect(
      offenders,
      'import DEVELOPMENT_TYPE_REF / DEVELOPMENT_TYPE_PATH from e2e/development-type-ref.ts',
    ).toEqual([])
  })

  test('the scan recognises every pinned spelling it forbids, and nothing else', () => {
    expect(
      hardCodedRevisions(
        [
          "const TYPE_REF = 'development@10'",
          'const path = `development%4011/work-items`',
          "const TYPE_ID = 'development'",
          'const TYPE_REVISION = 10',
          "page.on('request', (r) => r.url().includes('/digital-employee-types/development@4'))",
          "const legacy = { typeId: 'development', revision: 4 }",
          '// const TYPE_REF = "development@9"',
        ]
          .map(withoutComments)
          .join('\n'),
      ),
    ).toEqual(["'development@10", '`development%4011', "const TYPE_ID = 'development'"])
  })
})
