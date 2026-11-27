// RFC-624: fifteen independent migration rules, one live working-tree corpus.
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
} from '../helpers/rfc624MigrationReferenceRules'
import { resolveMigrationSpecifiers } from '../helpers/rfc624MigrationSpecifiers'

const REPO = resolve(import.meta.dir, '../../../..')
const SRC = join(REPO, 'packages/backend/src')
const slash = (path: string) => path.split('\\').join('/')

// Same roots, extensions and exclusions as the fifteen original scanners.
// Read the working tree, including untracked files, rather than a Git file list.
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
  readonly targets: readonly string[]
}

function readMigrationCorpus(repo: string): readonly ReferenceFile[] {
  const backend = join(repo, 'packages/backend')
  const src = join(backend, 'src')
  const files = [
    ...walk(src),
    ...walk(join(backend, 'tests')),
    ...walk(join(backend, 'scripts')),
    ...walk(join(repo, 'scripts')),
  ]
  expect(files.length).toBeGreaterThanOrEqual(6000)
  return files.map((path) => ({
    file: slash(relative(repo, path)),
    targets: resolveMigrationSpecifiers(src, path, readFileSync(path, 'utf8')),
  }))
}

describe('RFC-624 migrated-path references', () => {
  let corpus: readonly ReferenceFile[] = []
  beforeAll(() => {
    corpus = readMigrationCorpus(REPO)
  }, 240_000)

  for (const rule of MIGRATION_REFERENCE_RULES) {
    test(`${rule.id}: ${rule.title}`, () => {
      const old = new Set<string>(rule.oldPaths)
      expect(
        corpus.flatMap(({ file, targets }) =>
          targets.filter((target) => old.has(target)).map((target) => `${file} -> ${target}`),
        ),
      ).toEqual([])
    }, 240_000)
  }
})

describe('RFC-624 scanner obligations', () => {
  test('all fifteen original rules remain registered independently', () => {
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
      'RFC-587',
      'RFC-589',
    ])
    expect(new Set(MIGRATION_REFERENCE_RULES.map((rule) => rule.sourceFile)).size).toBe(15)
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

// RFC-575: preserve its independent util-directory inventory under the shared corpus floor.
describe('RFC-575 —— util/ 只剩安全相邻的一族', () => {
  test('util/ 的文件清单', () => {
    // RFC-619: util/ itself is gone; an absent directory lists nothing.
    const dir = join(SRC, 'util')
    expect(
      (existsSync(dir) ? readdirSync(dir) : []).filter((name) => name.endsWith('.ts')).sort(),
    ).toEqual(UTIL_REMAINDER)
  })
})
