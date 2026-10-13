// RFC-370 P12: keep all original native source and reject changed introduced fragments.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import reviewed from './fixtures/rfc370-task-provider-host-assembly-original-sources.json'
import {
  inverseTaskProviderHostAssembly,
  inversePreparedTaskProviderHostAssembly,
  normalizeTaskProviderHostAssemblyInput,
} from './helpers/taskProviderHostAssemblyStatementInverse'
import priorHooks from './fixtures/rfc370-preexisting-ci-root-hooks.json'
import { inversePreexistingCiRootHooks } from './helpers/preexistingCiRootStatementInverse'
import { inverseRfc372ClarifyRootBinding } from './helpers/rfc372ClarifyRootInverse'
import { inverseRfc213DevStartupRoot } from './helpers/rfc213DevStartupRootInverse'

const root = resolve(import.meta.dir, '../../..')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

test('the original startup and clarify inverses recognize absolute, repository-relative and native-root filenames', () => {
  for (const path of ['cli/start.ts', 'cli/postgresqlDaemonApplication.ts', 'server.ts']) {
    const raw = readFileSync(resolve(root, 'packages/backend/src', path), 'utf8')
    const suffix = '\n// unrelated original root bytes stay visible\n'
    const filenames = [
      path,
      'packages/backend/src/' + path,
      resolve(root, 'packages/backend/src', path),
      'C:\\project\\packages\\backend\\src\\' + path.replaceAll('/', '\\'),
    ]
    const inverse =
      path === 'cli/start.ts' ? inverseRfc213DevStartupRoot : inverseRfc372ClarifyRootBinding
    const outputs = filenames.map(
      (file) => inverse(ts.createSourceFile(file, raw + suffix, ts.ScriptTarget.Latest, true)).text,
    )
    expect(new Set(outputs).size).toBe(1)
    if (path === 'cli/start.ts')
      expect(outputs[0]).toContain(
        "const { assertRuntimeDeclarations } = await import('@/services/runtime/selfCheck')",
      )
    else expect(outputs[0]).not.toContain('followupGenerator: composeClarifyFollowupGenerator')
    expect(outputs[0]?.endsWith(suffix)).toBe(true)
  }
})

test('P12 restores every complete original native caller without masking an unrelated change', () => {
  expect(reviewed.sources).toHaveLength(11)
  expect(new Set(reviewed.sources.map((row) => row.path)).size).toBe(11)
  for (const row of reviewed.sources) {
    const current = readFileSync(resolve(root, row.path), 'utf8')
    const source = ts.createSourceFile(row.path, current, ts.ScriptTarget.Latest, true)
    const previous = inverseTaskProviderHostAssembly(source).text
    expect(Buffer.byteLength(previous)).toBe(row.previousBytes)
    expect(digest(previous)).toBe(row.previousSha256)
    const suffix = '\n// unrelated source suffix stays visible\n'
    const changed = ts.createSourceFile(row.path, current + suffix, ts.ScriptTarget.Latest, true)
    expect(inverseTaskProviderHostAssembly(changed).text).toBe(previous + suffix)
    const change = row.changes.find((edit) => edit.introduced.length > 0)
    if (change === undefined) throw new Error(`introduced fragment missing for ${row.path}`)
    const normalized = normalizeTaskProviderHostAssemblyInput(source)
    let start: number | undefined
    for (const anchor of change.anchors) {
      const matches: number[] = []
      for (
        let pos = normalized.text.indexOf(anchor.needle);
        pos >= 0;
        pos = normalized.text.indexOf(anchor.needle, pos + 1)
      )
        matches.push(pos)
      const candidate = matches[anchor.index]
      if (
        matches.length === anchor.count &&
        candidate !== undefined &&
        normalized.text.slice(
          candidate + anchor.offset,
          candidate + anchor.offset + change.introduced.length,
        ) === change.introduced
      ) {
        start = candidate + anchor.offset
        break
      }
    }
    if (start === undefined) throw new Error(`introduced anchor missing for ${row.path}`)
    const mutation = normalized.text.slice(0, start) + '?' + normalized.text.slice(start + 1)
    expect(() =>
      inversePreparedTaskProviderHostAssembly(
        ts.createSourceFile(row.path, mutation, ts.ScriptTarget.Latest, true),
      ),
    ).toThrow('task-provider-host inverse unreviewed fragment')
  }
})

test('approved pre-existing root hooks reject partial, changed and duplicated hooks', () => {
  for (const row of priorHooks.roots) {
    const raw = readFileSync(resolve(root, row.path), 'utf8')
    const parse = (text: string) =>
      ts.createSourceFile(row.path, text, ts.ScriptTarget.Latest, true)
    const current = normalizeTaskProviderHostAssemblyInput(parse(raw)).text
    const suffix = '\n// unknown root change remains visible 中文 😀\n'
    const normalized = inversePreexistingCiRootHooks(parse(current))
    expect(inversePreexistingCiRootHooks(normalized).text).toBe(normalized.text)
    expect(inversePreexistingCiRootHooks(parse(current + suffix)).text).toBe(
      normalized.text + suffix,
    )
    for (const hook of row.introduced) {
      expect(current.split(hook)).toHaveLength(2)
      for (const changed of [
        current.replace(hook, ''),
        current.replace(hook, hook.replace(/\S/, '?')),
        current + hook,
      ])
        expect(() => inversePreexistingCiRootHooks(parse(changed))).toThrow(
          'pre-existing root hook inverse unreviewed or incomplete',
        )
    }
  }
})
