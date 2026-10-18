// RFC-377 locks the git leaf boundary, facade identity and retirement of cycle debt.
// Literal counterexamples keep the import scanner and depcheck rejection observable.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { evaluateCruises, isBlocking, KNOWN_VIOLATIONS } from '../../../scripts/depcheck'
import * as facade from '@/services/gitSubmodule'
import * as git from '@/util/git'
import { importEdges, sourceUnit } from './architecture/census'

function forbiddenEdges(text: string): string[] {
  return importEdges(sourceUnit('packages/backend/src/util/git.ts', text))
    .map((edge) => edge.specifier)
    .filter((specifier) => {
      const firstParty =
        specifier.startsWith('@/') ||
        specifier.startsWith('@agent-workflow/') ||
        specifier.startsWith('.')
      return (
        firstParty &&
        specifier !== '@agent-workflow/shared' &&
        !specifier.startsWith('@/util/') &&
        !specifier.startsWith('./')
      )
    })
}

describe('RFC-377 util/git leaf', () => {
  test('git primitives have no imports or re-exports from upper layers', () => {
    const text = readFileSync(resolve(import.meta.dir, '../src/util/git.ts'), 'utf8')
    expect(forbiddenEdges(text)).toEqual([])
  })

  test('rejects dynamic value imports', () => {
    expect(forbiddenEdges("await import('@/services/gitSubmodule')")).toEqual([
      '@/services/gitSubmodule',
    ])
  })

  test('rejects static type imports', () => {
    expect(
      forbiddenEdges("import type { Source } from '@/modules/source-control/public/types'"),
    ).toEqual(['@/modules/source-control/public/types'])
  })

  test('rejects typeof import types', () => {
    expect(forbiddenEdges("type Cache = typeof import('@/services/gitRepoCache')")).toEqual([
      '@/services/gitRepoCache',
    ])
  })

  test('rejects re-exports and relative upper-layer imports', () => {
    expect(
      forbiddenEdges("export { workspace } from '@/platform/workspace/local/isolation'"),
    ).toEqual(['@/platform/workspace/local/isolation'])
    expect(forbiddenEdges("import { caps } from '../services/gitVersion'")).toEqual([
      '../services/gitVersion',
    ])
  })

  test('accepts shared, sibling utilities and external primitives', () => {
    expect(
      forbiddenEdges(`
        import { redactGitUrl } from '@agent-workflow/shared'
        import { sha1Hex } from '@/util/hash'
        export { run } from './process'
        import type { Logger } from './log'
        import { existsSync } from 'node:fs'
      `),
    ).toEqual([])
  })

  test('production facade exports are the same primitive objects', () => {
    expect(facade.detectSubmodules).toBe(git.detectSubmodules)
    expect(facade.resolveSubmodulePool).toBe(git.resolveSubmodulePool)
    expect(facade.subSlug).toBe(git.subSlug)
    expect(facade.submoduleGitDir).toBe(git.submoduleGitDir)
    expect(facade.syncSubmodules).toBe(git.syncSubmodules)
  })

  test('KNOWN_VIOLATIONS carries no cycle or util-to-upper entries', () => {
    expect(
      KNOWN_VIOLATIONS.filter(
        (entry) => entry.rule === 'no-circular' || entry.rule === 'no-util-to-upper',
      ),
    ).toEqual([])
  })

  test('a fabricated future cycle is unknown and blocks depcheck', () => {
    const cycle = {
      rule: { name: 'no-circular', severity: 'error' },
      from: 'packages/backend/src/util/futureGit.ts',
      to: 'packages/backend/src/services/futureGit.ts',
    }
    const verdict = evaluateCruises(
      [{ modules: [], summary: { violations: [cycle] } }],
      KNOWN_VIOLATIONS,
    )
    expect(verdict.unknown).toEqual([cycle])
    expect(verdict.accepted).toEqual([])
    expect(isBlocking({ ...verdict, stale: [] })).toBe(true)
  })
})
