import { expect, test } from 'bun:test'
import { sourcePathReads } from './sourcePathReads'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('literal source reads preserve lexical bindings and still expose missing source paths', () => {
  expect(
    sourcePathReads(
      '/repo/tests/guard.test.ts',
      `
    const root = resolve(import.meta.dir, '../src')
    const file = resolve(root, 'real.ts')
    test('compiler fixture', () => { const file = resolve(root, '__virtual.ts'); compile(file) })
    readFileSync(file)
    test('unknown parameter', (file) => readFileSync(file))
    test('unknown initializer', () => { const file = choose(); readFileSync(file) })
    test('missing source', () => { const file = resolve(root, 'missing.ts'); readFileSync(file) })
    readFileSync(file)
    expect(() => readFileSync(resolve(root, 'retired.ts'))).toThrow()
  `,
    ),
  ).toEqual(['/repo/src/real.ts', '/repo/src/missing.ts', '/repo/src/real.ts'])
})

test('Q-1 opt-in parity has a concrete rehearsal command and fails when required artifacts are absent', () => {
  const root = resolve(import.meta.dir, '../../../..')
  const source = readFileSync(
    resolve(root, 'packages/backend/tests/rfc395-q1-dto-parity.test.ts'),
    'utf8',
  )
  const readme = readFileSync(
    resolve(root, 'packages/backend/tests/helpers/rfc395Q1Parity/README.md'),
    'utf8',
  )
  expect(readme).toContain('export RFC395_Q1_T18=1')
  expect(source).toContain("test.skipIf(process.env.RFC395_Q1_T18 !== '1')")
  expect(source).toContain('if (!value) throw new Error(`Missing ${key}`)')
  for (const key of ['REPOSITORY', 'OLD_BINARY', 'NEW_BINARY', 'OLD_ARTIFACT'])
    expect(source).toContain(`required('RFC395_Q1_${key}')`)
})
