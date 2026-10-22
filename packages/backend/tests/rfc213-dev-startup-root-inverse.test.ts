// RFC-213 / RFC-391 / RFC-394: inverse only the approved dev delta in its actual owning files.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { inverseRfc213DevStartupRoot } from './helpers/rfc213DevStartupRootInverse'

for (const path of [
  'bootstrap/daemonStart.ts',
  'bootstrap/daemonApplication.ts',
  'bootstrap/developmentReload.ts',
]) {
  const name = `packages/backend/src/${path}`
  const current = readFileSync(resolve(import.meta.dir, '../src', path), 'utf8')
  const parse = (text: string, file = name) =>
    ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const restore = (text: string) => inverseRfc213DevStartupRoot(parse(text)).text
  test(`${path}: the approved delta restores only preparation or the one declaration check`, () => {
    const original = restore(current)
    // The development field now belongs to DevelopmentOverlay; keep the exact
    // inverse delta for each owner and preserve all unrelated bytes.
    expect(Buffer.byteLength(current) - Buffer.byteLength(original)).toBe(
      path === 'bootstrap/daemonStart.ts'
        ? 294
        : path === 'bootstrap/developmentReload.ts'
          ? 64
          : -86,
    )
    expect(restore(original)).toBe(original)
    expect(inverseRfc213DevStartupRoot(parse(current, name.replaceAll('/', '\\'))).text).toBe(
      original,
    )
    if (path === 'bootstrap/daemonStart.ts') {
      expect(original).not.toContain('developmentIntegrity')
      expect(original).not.toContain('agent-workflow-http:')
      expect(original).toContain('  const server = Bun.serve({\n    port: input.bindPort,\n')
    } else if (path === 'bootstrap/developmentReload.ts') {
      expect(original).not.toContain('readonly developmentIntegrity:')
      expect(original).toContain('readonly daemonHost: DaemonHostLifecyclePort')
    } else {
      expect(original).toContain("import { getRuntimeDriver } from '@/services/runtime'\n")
      expect(
        original.split(
          "const { assertRuntimeDeclarations } = await import('@/services/runtime/selfCheck')",
        ),
      ).toHaveLength(2)
      expect(() =>
        restore(
          current.replace(
            'assertRuntimeDeclarations(RUNTIME_KINDS.map(getRuntimeDriver))',
            'assertRuntimeDeclarations([])',
          ),
        ),
      ).toThrow('dev startup root inverse unreviewed')
    }
    const marker =
      path === 'bootstrap/daemonStart.ts'
        ? 'readyBrowserUrl'
        : path === 'bootstrap/developmentReload.ts'
          ? 'source-reload'
          : 'boot snapshot reverify'
    const mutate = (text: string) => text.replace(marker, 'unrelated-source-edit')
    expect(mutate(current)).not.toBe(current)
    expect(restore(mutate(current))).toBe(mutate(original))
    const suffix = '\n// unrelated 中文 😀 output remains visible\n'
    expect(restore(current + suffix)).toBe(original + suffix)
  })
  test(`${path}: partial and duplicated approved fragments remain visible`, () => {
    const fragments =
      path === 'bootstrap/daemonStart.ts'
        ? [
            '    id: `agent-workflow-http:${input.bindHost}:${input.bindPort}`,\n',
            '          developmentIntegrity: development?.developmentIntegrity,\n',
          ]
        : path === 'bootstrap/developmentReload.ts'
          ? ['readonly developmentIntegrity']
          : ["import { assertRuntimeDeclarations } from '@/services/runtime/selfCheck'\n"]
    for (const fragment of fragments) {
      expect(current.split(fragment)).toHaveLength(2)
      expect(() => restore(current.replace(fragment, ''))).toThrow(
        'dev startup root inverse unreviewed',
      )
      expect(() => restore(current.replace(fragment, fragment + fragment))).toThrow(
        'dev startup root inverse unreviewed',
      )
    }
    const other = parse(current, 'anotherRoot.ts')
    expect(inverseRfc213DevStartupRoot(other)).toBe(other)
  })
}
