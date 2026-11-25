// RFC-377 locks the git leaf boundary, facade identity and retirement of cycle debt.
// Literal counterexamples keep the import scanner and depcheck rejection observable.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { evaluateCruises, isBlocking, KNOWN_VIOLATIONS } from '../../../scripts/depcheck'
import * as facade from '@/modules/source-control/infrastructure/local/gitSubmodule'
import * as git from '@/util/git'
import { importEdges, sourceUnit } from './architecture/census'

/**
 * RFC-572: the two process / exec leaves git has always used moved from `util/` into platform's execution directory.
 * They stay leaves (RFC-572's lock pins their imports: each other, `platform/logging/logger`, node built-ins and `bun:ffi`), so the git
 * primitives may name exactly these two; every other platform file is still an upper layer here.
 */
const PROCESS_LEAVES = new Set([
  '@/platform/execution/local/platformExec',
  '@/platform/execution/local/process',
])
/**
 * RFC-573 moved the directory reclaim (`removeDirectoryWithRetry`) from `util/` into the workspace directory of
 * platform. It imports only the logger, so it is still a leaf below the git primitives; its neighbour `isolation`
 * imports those primitives and stays an upper layer.
 */
const WORKSPACE_LEAVES = new Set(['@/platform/workspace/local/fsReclaim'])
/**
 * RFC-575 moved the three base primitives — the domain error family, the logger and the digest helpers — from
 * `util/` into platform. They import nothing above them (the error family takes only the logger), so the git primitives
 * may name exactly these three.
 */
const BASE_PRIMITIVES = new Set([
  '@/platform/errors/domainErrors',
  '@/platform/logging/logger',
  '@/platform/contracts/hash',
])

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
        !specifier.startsWith('./') &&
        !PROCESS_LEAVES.has(specifier) &&
        !WORKSPACE_LEAVES.has(specifier) &&
        !BASE_PRIMITIVES.has(specifier)
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
    // RFC-572: only the two process / exec leaves are admitted — their neighbours in the same directory are not.
    expect(
      forbiddenEdges(
        "import { spawnManaged } from '@/platform/execution/local/managedProcess'\n" +
          "import { acquireLock } from '@/platform/execution/local/daemonLock'",
      ),
    ).toEqual([
      '@/platform/execution/local/managedProcess',
      '@/platform/execution/local/daemonLock',
    ])
    // RFC-573: of the workspace directory only the reclaim leaf is admitted.
    expect(
      forbiddenEdges(
        "import { removeDirectoryWithRetry } from '@/platform/workspace/local/fsReclaim'\n" +
          "import { gitVersionCaps } from '@/platform/workspace/local/gitVersion'\n" +
          "import { removeDirectoryWithRetry as viaRelative } from '../platform/workspace/local/fsReclaim'",
      ),
    ).toEqual(['@/platform/workspace/local/gitVersion', '../platform/workspace/local/fsReclaim'])
    // RFC-575: of the error directory only the domain error family is admitted, not the public-error contract beside it.
    expect(
      forbiddenEdges(
        "import { ValidationError } from '@/platform/errors/domainErrors'\n" +
          "import { toPublicError } from '@/platform/errors/publicError'",
      ),
    ).toEqual(['@/platform/errors/publicError'])
  })

  test('accepts shared, sibling utilities and external primitives', () => {
    expect(
      forbiddenEdges(`
        import { redactGitUrl } from '@agent-workflow/shared'
        import { sha1Hex } from '@/platform/contracts/hash'
        import { killProcessTree } from '@/platform/execution/local/process'
        import { platformSpawnOptionsForHost } from '@/platform/execution/local/platformExec'
        import { removeDirectoryWithRetry } from '@/platform/workspace/local/fsReclaim'
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
