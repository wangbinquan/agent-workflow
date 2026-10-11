// RFC-370 P12: keep all original native source and reject changed introduced fragments.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import reviewed from './fixtures/rfc370-task-provider-host-assembly-original-sources.json'
import { inverseTaskProviderHostAssembly } from './helpers/taskProviderHostAssemblyStatementInverse'

const root = resolve(import.meta.dir, '../../..')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

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
    const mutation = current.slice(0, change.start) + '?' + current.slice(change.start + 1)
    expect(() =>
      inverseTaskProviderHostAssembly(
        ts.createSourceFile(row.path, mutation, ts.ScriptTarget.Latest, true),
      ),
    ).toThrow('task-provider-host inverse unreviewed fragment')
  }
})
