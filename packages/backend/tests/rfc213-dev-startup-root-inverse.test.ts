// The dev fixes must not invalidate older whole-root checks or hide concurrent
// edits. Keep those original digests and compare only the approved startup delta.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { inverseRfc213DevStartupRoot } from './helpers/rfc213DevStartupRootInverse'

const path = 'packages/backend/src/cli/start.ts'
const current = readFileSync(new URL('../src/cli/start.ts', import.meta.url), 'utf8')
const parse = (text: string, name = path) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
const restore = (text: string) => inverseRfc213DevStartupRoot(parse(text)).text

test('the approved dev startup delta restores the original self-check and preparation boundaries', () => {
  const original = restore(current)
  expect(Buffer.byteLength(current) - Buffer.byteLength(original)).toBe(340)
  expect(original).toContain("import { getRuntimeDriver } from '@/services/runtime'\n")
  expect(original).toContain(
    "    const { assertRuntimeDeclarations } = await import('@/services/runtime/selfCheck')\n" +
      "    const { getRuntimeDriver, RUNTIME_KINDS } = await import('@/services/runtime')\n" +
      '    const { notModeled } = assertRuntimeDeclarations(RUNTIME_KINDS.map(getRuntimeDriver))',
  )
  expect(original).not.toContain('developmentIntegrity')
  expect(original).not.toContain('agent-workflow-http:')
  expect(original).toContain('  const server = Bun.serve({\n    port: input.bindPort,\n')
  expect(restore(original)).toBe(original)
  expect(inverseRfc213DevStartupRoot(parse(current, path.replaceAll('/', '\\'))).text).toBe(
    original,
  )
})

test('unknown source bytes and changed self-check behavior remain visible to the original oracles', () => {
  const original = restore(current)
  const suffix = '\n// unrelated 中文 😀 root output stays visible\n'
  expect(restore(current + suffix)).toBe(original + suffix)
  const replace = (text: string) =>
    text.replace("log.info('db ready'", "log.info('changed database admission'")
  expect(replace(current)).not.toBe(current)
  expect(restore(replace(current))).toBe(replace(original))
  const changedCheck = current.replace(
    'assertRuntimeDeclarations(RUNTIME_KINDS.map(getRuntimeDriver))',
    'assertRuntimeDeclarations([])',
  )
  expect(() => restore(changedCheck)).toThrow('dev startup root inverse unreviewed')
})

test('partial or mutated preparation revisions cannot be silently normalized', () => {
  for (const fragment of [
    '  developmentIntegrity?: { validatedDatabase?: string }\n',
    '    id: `agent-workflow-http:${input.bindHost}:${input.bindPort}`,\n',
    '          developmentIntegrity: opts.developmentIntegrity,\n',
    "import { assertRuntimeDeclarations } from '@/services/runtime/selfCheck'\n",
  ]) {
    expect(current.split(fragment)).toHaveLength(2)
    expect(() => restore(current.replace(fragment, ''))).toThrow(
      'dev startup root inverse unreviewed',
    )
    expect(() => restore(current.replace(fragment, fragment + fragment))).toThrow(
      'dev startup root inverse unreviewed',
    )
  }
})

test('other roots are left untouched even when they contain matching fragments', () => {
  for (const name of [
    'anotherRoot.ts',
    'packages/backend/src/cli/postgresqlDaemonApplication.ts',
  ]) {
    const source = parse(current, name)
    expect(inverseRfc213DevStartupRoot(source)).toBe(source)
  }
})
