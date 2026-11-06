// RFC-085 T2 — lazy "expand one method" over real tree-sitter parses. Locks:
// same-class (this.foo) + constructor (new Bar) + cross-file field-typed receiver
// (svc.charge where `OrderService svc`) all RESOLVE to the right method, in source
// order; a dynamic-language instance call with no static type → UNRESOLVED.

import { describe, expect, test } from 'bun:test'
import {
  expandMethod,
  type ExpandCtx,
} from '../src/modules/workspace-insight/engine/callGraph/expandMethod'
import {
  buildClassIndex,
  scanClassDecls,
} from '../src/modules/source-control/infrastructure/local/classDeclarationIndex'
import { resolveLang } from '../src/modules/workspace-insight/domain/lang/languages'

function ctxOf(files: Record<string, string>): ExpandCtx {
  const index = buildClassIndex(
    Object.entries(files).map(([file, src]) => ({ file, names: scanClassDecls(file, src) })),
  )
  return {
    readFile: async (p) => files[p] ?? null,
    classIndex: index,
    grammarFor: resolveLang,
  }
}

describe('expandMethod', () => {
  test('Java: same-class + constructor + field-typed receiver resolve, in source order', async () => {
    const files = {
      'A.java':
        'class A {\n' +
        '  private OrderService svc;\n' +
        '  void run() {\n' +
        '    this.helper();\n' +
        '    new Logger();\n' +
        '    svc.charge();\n' +
        '  }\n' +
        '  void helper() {}\n' +
        '}\n',
      'OrderService.java': 'class OrderService {\n  void charge() {}\n}\n',
      'Logger.java': 'class Logger {\n  Logger() {}\n}\n',
    }
    const out = await expandMethod('A.java#A.run', ctxOf(files))
    expect(out.map((t) => `${t.order}:${t.label}:${t.resolution}`)).toEqual([
      '0:helper():resolved',
      '1:new Logger():resolved',
      '2:charge():resolved',
    ])
    expect(out.find((t) => t.label === 'charge()')?.ref).toBe(
      'OrderService.java#OrderService.charge',
    )
    expect(out.find((t) => t.label === 'charge()')?.ownerClass).toBe(
      'OrderService.java::OrderService',
    )
    expect(out.find((t) => t.label === 'new Logger()')?.kind).toBe('constructor')
  })

  test('Java: receiver of unknown type → unresolved (no fabrication)', async () => {
    const files = {
      'A.java': 'class A {\n  void run() {\n    mystery.doThing();\n  }\n}\n',
    }
    const out = await expandMethod('A.java#A.run', ctxOf(files))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ label: 'mystery.doThing()', resolution: 'unresolved' })
    expect(out[0]?.ref).toBeUndefined()
  })

  test('Python: instance call has no static type → unresolved; self call resolves', async () => {
    const files = {
      'a.py':
        'class A:\n' +
        '    def run(self):\n' +
        '        self.helper()\n' +
        '        svc.charge()\n' +
        '    def helper(self):\n' +
        '        pass\n',
    }
    const out = await expandMethod('a.py#A.run', ctxOf(files))
    const byName = Object.fromEntries(out.map((t) => [t.label, t.resolution]))
    expect(byName['helper()']).toBe('resolved') // self.helper → A.helper
    expect(byName['svc.charge()']).toBe('unresolved') // dynamic, no type
  })

  test('non-method ref / unparseable file → empty (no crash)', async () => {
    const out = await expandMethod('missing.java#X.y', ctxOf({}))
    expect(out).toEqual([])
  })
})
