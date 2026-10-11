// The shared CLI roots retain Task assembly and four cache hooks without relaxing old whole-file oracles.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import taskOriginals from './fixtures/rfc370-task-provider-host-assembly-original-sources.json'
import { inverseTaskProviderHostAssembly } from './helpers/taskProviderHostAssemblyStatementInverse'
import { inverseRfc371NativeFactRootHooks } from './helpers/rfc371NativeFactRootInverse'

const root = resolve(import.meta.dir, '../../..')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

test.each([
  'packages/backend/src/cli/start.ts',
  'packages/backend/src/cli/postgresqlDaemonApplication.ts',
])(
  'the exact %s cache inverse composes with the original Task inverse and preserves unknown bytes',
  (path) => {
    const current = readFileSync(resolve(root, path), 'utf8')
    const previous = taskOriginals.sources.find((row) => row.path === path)
    if (!previous) throw new Error('Complete original Task root identity missing')
    const withoutCache = inverseRfc371NativeFactRootHooks(parse(path, current))
    expect(withoutCache.text).not.toBe(current)
    expect(inverseRfc371NativeFactRootHooks(withoutCache).text).toBe(withoutCache.text)
    const original = inverseTaskProviderHostAssembly(withoutCache).text
    expect(Buffer.byteLength(original)).toBe(previous.previousBytes)
    expect(digest(original)).toBe(previous.previousSha256)
    const otherOrder = inverseRfc371NativeFactRootHooks(
      inverseTaskProviderHostAssembly(parse(path, current)),
    ).text
    expect(otherOrder).toBe(original)
    const suffix = '\n// unrelated 中文 😀 root output stays visible\n'
    const changed = inverseTaskProviderHostAssembly(
      inverseRfc371NativeFactRootHooks(parse(path, current + suffix)),
    ).text
    expect(changed).toBe(original + suffix)
    expect(digest(changed)).not.toBe(previous.previousSha256)
    for (const replacement of ['', '    closeBuild: () => anotherBuild.close(),\n']) {
      const incomplete = current.replace(
        '    closeBuild: () => observationBuild.close(),\n',
        replacement,
      )
      expect(() => inverseRfc371NativeFactRootHooks(parse(path, incomplete))).toThrow(
        'native-fact root inverse unreviewed or incomplete hooks',
      )
    }
    const duplicated = current + '    closeBuild: () => observationBuild.close(),\n'
    // An unknown appended hook remains visible rather than being silently removed.
    expect(inverseRfc371NativeFactRootHooks(parse(path, duplicated)).text).toBe(
      withoutCache.text + '    closeBuild: () => observationBuild.close(),\n',
    )
  },
)

test('files outside the two declared CLI roots are returned without any normalization', () => {
  const source = parse('anotherRoot.ts', '    closeBuild: () => observationBuild.close(),\n')
  expect(inverseRfc371NativeFactRootHooks(source)).toBe(source)
})
