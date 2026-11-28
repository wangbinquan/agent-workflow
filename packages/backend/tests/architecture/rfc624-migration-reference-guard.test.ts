// RFC-624 & RFC-629: thirty independent migration rules, one live five-root working-tree corpus.
// Discovery remains here so the existing T13/T14 guards can trace its floor.
import { beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import {
  MIGRATION_REFERENCE_RULES,
  RFC575_UTIL_REMAINDER as UTIL_REMAINDER,
  RFC590_RULE,
  RFC619_RULE,
  RFC622_RULE,
  type MigrationReferenceRule,
} from '../helpers/rfc624MigrationReferenceRules'
import {
  resolveMigrationSpecifiers,
  resolveMigrationSpecifierSites,
  type MigrationSpecifierSite,
} from '../helpers/rfc624MigrationSpecifiers'

const REPO = resolve(import.meta.dir, '../../../..')
const SRC = join(REPO, 'packages/backend/src')
const slash = (path: string) => path.split('\\').join('/')

// Five roots covering backend src/tests/scripts plus repo-root scripts/ and tests/
// (including tests/perf/run.ts). Reads the working tree, including untracked files.
function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
    const path = join(dir, name)
    return statSync(path).isDirectory()
      ? walk(path)
      : /\.(?:[cm]?tsx?|mjs)$/.test(name)
        ? [path]
        : []
  })
}

interface ReferenceFile {
  readonly file: string
  readonly sites: readonly MigrationSpecifierSite[]
}

export function matchMigrationRule(
  rule: MigrationReferenceRule,
  file: string,
  sites: readonly MigrationSpecifierSite[],
): string[] {
  const old = new Set<string>(rule.oldPaths)
  const prefixes = rule.oldPrefixes ?? []
  const forbiddenNamed = rule.forbiddenNamedImports ?? []
  const hits: string[] = []
  for (const site of sites) {
    if (old.has(site.target) || prefixes.some((prefix) => site.target.startsWith(prefix))) {
      hits.push(`${file} -> ${site.target}`)
    }
    for (const entry of forbiddenNamed) {
      if (site.target !== entry.target) continue
      for (const name of site.namedImports) {
        if (entry.names.includes(name)) {
          hits.push(`${file} -> ${site.target}#${name}`)
        }
      }
    }
  }
  return hits
}

function readMigrationCorpus(repo: string): readonly ReferenceFile[] {
  const backend = join(repo, 'packages/backend')
  const src = join(backend, 'src')
  const files = [
    ...walk(src),
    ...walk(join(backend, 'tests')),
    ...walk(join(backend, 'scripts')),
    ...walk(join(repo, 'scripts')),
    ...walk(join(repo, 'tests')),
  ]
  expect(files.length).toBeGreaterThanOrEqual(6000)
  return files.map((path) => ({
    file: slash(relative(repo, path)),
    sites: resolveMigrationSpecifierSites(src, path, readFileSync(path, 'utf8')),
  }))
}

describe('RFC-624 migrated-path references', () => {
  let corpus: readonly ReferenceFile[] = []
  beforeAll(() => {
    corpus = readMigrationCorpus(REPO)
  }, 240_000)

  for (const rule of MIGRATION_REFERENCE_RULES) {
    test(`${rule.id}: ${rule.title}`, () => {
      expect(corpus.flatMap(({ file, sites }) => matchMigrationRule(rule, file, sites))).toEqual([])
    }, 240_000)
  }
})

describe('RFC-624 scanner obligations', () => {
  test('all thirty migration rules remain registered independently', () => {
    expect(MIGRATION_REFERENCE_RULES.map((rule) => rule.id)).toEqual([
      'RFC-571',
      'RFC-572',
      'RFC-573',
      'RFC-574',
      'RFC-575',
      'RFC-576',
      'RFC-577',
      'RFC-578',
      'RFC-579',
      'RFC-580',
      'RFC-581',
      'RFC-582',
      'RFC-583',
      'RFC-584',
      'RFC-585',
      'RFC-586',
      'RFC-587',
      'RFC-588',
      'RFC-589',
      'RFC-590',
      'RFC-591',
      'RFC-592',
      'RFC-593',
      'RFC-594',
      'RFC-617',
      'RFC-618',
      'RFC-619',
      'RFC-620',
      'RFC-621',
      'RFC-622',
    ])
    expect(new Set(MIGRATION_REFERENCE_RULES.map((rule) => rule.sourceFile)).size).toBe(30)
  })

  test('an empty or missing working-tree corpus fails before zero-reference assertions', () => {
    expect(() =>
      readMigrationCorpus(join(tmpdir(), `aw-rfc624-missing-${crypto.randomUUID()}`)),
    ).toThrow()
  })

  test('discovery includes new nested source files and keeps the original extension/exclusion scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc624-walk-'))
    try {
      for (const file of [
        'new/nested.ts',
        'view.tsx',
        'worker.cts',
        'loader.mts',
        'script.mjs',
        'ignored.js',
        'ignored.json',
        'node_modules/ignored.ts',
        'dist/ignored.ts',
      ]) {
        const target = join(root, file)
        mkdirSync(resolve(target, '..'), { recursive: true })
        writeFileSync(target, 'export const fixture = 1')
      }
      expect(
        walk(root)
          .map((file) => slash(relative(root, file)))
          .sort(),
      ).toEqual(['loader.mts', 'new/nested.ts', 'script.mjs', 'view.tsx', 'worker.cts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the actual shared parser recognizes every original executable/type import shape', () => {
    expect(
      resolveMigrationSpecifiers(
        SRC,
        join(SRC, 'probe.ts'),
        [
          "import { value } from '@/util/semver'",
          "export { value } from './util/time.ts'",
          "type Shape = import('@/util/keyedSerialQueue').Shape",
          "const lazy = import('./util/jsonDocument')",
          "const required = require('@/util/zodJsonSchema')",
          "mock.module('@/util/frontmatter', () => ({}))",
          "const located = import.meta.resolve('@/util/zip')",
        ].join('\n'),
      ),
    ).toEqual([
      'util/semver',
      'util/time',
      'util/keyedSerialQueue',
      'util/jsonDocument',
      'util/zodJsonSchema',
      'util/frontmatter',
      'util/zip',
    ])
  })

  test('shared rule matcher enforces oldPrefixes and forbiddenNamedImports while ignoring safe siblings', () => {
    const prefixSites = resolveMigrationSpecifierSites(
      SRC,
      join(SRC, 'probe.ts'),
      [
        "export type Probe = typeof import('@/modules/task-catalog/public/queries')",
        "import { ok } from '@/modules/task-catalog/composition'",
        "import { lease } from '@/util/anyFutureHelper'",
        "import { safe } from '@/utility/helper'",
      ].join('\n'),
    )
    expect(matchMigrationRule(RFC590_RULE, 'probe.ts', prefixSites)).toEqual([
      'probe.ts -> modules/task-catalog/public/queries',
    ])
    expect(matchMigrationRule(RFC619_RULE, 'probe.ts', prefixSites)).toEqual([
      'probe.ts -> util/anyFutureHelper',
    ])

    const namedSites = resolveMigrationSpecifierSites(
      SRC,
      join(SRC, 'probe.ts'),
      [
        "import { bindChangeCandidateParticipant, createLocalRepositoryCandidateEffects } from '@/modules/source-control/composition/repositoryCandidate'",
        "export { bindCandidateDeliveryParticipant as renamed } from './modules/source-control/composition/repositoryCandidate'",
        "import { createLocalRepositoryCandidateEffects as safeLocal } from '@/modules/source-control/composition/repositoryCandidate'",
        "mock.module('@/modules/source-control/composition/repositoryCommit', () => ({}))",
      ].join('\n'),
    )
    expect(matchMigrationRule(RFC622_RULE, 'probe.ts', namedSites)).toEqual([
      'probe.ts -> modules/source-control/composition/repositoryCandidate#bindChangeCandidateParticipant',
      'probe.ts -> modules/source-control/composition/repositoryCandidate#bindCandidateDeliveryParticipant',
      'probe.ts -> modules/source-control/composition/repositoryCommit',
    ])
  })

  test('package names, paths outside src, comments and ordinary strings are not references', () => {
    expect(
      resolveMigrationSpecifiers(
        SRC,
        join(SRC, 'probe.ts'),
        [
          "import { value } from 'some-package'",
          "export { value } from '../tests/fixture'",
          "// import { value } from '@/util/semver'",
          'const description = "import(\'@/util/semver\')"',
        ].join('\n'),
      ),
    ).toEqual([])
  })
})

// RFC-575 & RFC-619: preserve independent util-directory inventory under the shared corpus floor.
describe('RFC-575 & RFC-619 —— util/ 已清空', () => {
  test('util/ 下没有任何源码文件', () => {
    // RFC-619: util/ itself is gone; an absent directory lists nothing (recursively).
    const dir = join(SRC, 'util')
    expect(
      (existsSync(dir) ? readdirSync(dir) : []).filter((name) => name.endsWith('.ts')).sort(),
    ).toEqual(UTIL_REMAINDER)
    expect(walk(dir)).toEqual([])
  })
})
