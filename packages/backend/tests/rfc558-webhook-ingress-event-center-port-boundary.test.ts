// RFC-558 — integration 的 webhook 入站只认自己声明的事件中心窄端口（RFC-294 S9 第十三步）。
//
// 锁三件事：
// ① integration 的生产文件取 event-center 的非 public 文件，只剩指定 adapter（`application/adapters/event-center-adapter.ts`）
//    按类型取 `composition/required-ports`（判据带负对照）。
// ② 窄端口 `WebhookIngressEventCenter` 只取 event-center 的 exact public；webhook 入站的装配用它。
// ③ 编译期断言：event-center 装配出的事件中心模块可以赋给这个端口（bootstrap 交的就是它）。
//
// 覆盖范围（C12）：① 覆盖 integration 的全部源码；② 只读点名的文件；③ 由 `tsc` 检查。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type { EventCenterModule } from '../src/modules/event-center/composition'
import type { WebhookIngressEventCenter } from '../src/modules/integration/application/ports/webhookIngressEventCenter'

const SRC = resolve(import.meta.dir, '..', 'src')
const MODULES = join(SRC, 'modules')
const INTEGRATION = join(MODULES, 'integration')
const read = (path: string) => readFileSync(join(MODULES, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Imports and re-exports reaching a non-public event-center file, as `<rest> (<type|value>)`. */
function eventCenterInternalImports(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  for (const statement of source.statements) {
    const isImport = ts.isImportDeclaration(statement)
    if (!isImport && !ts.isExportDeclaration(statement)) continue
    const specifier = statement.moduleSpecifier
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue
    const target = specifier.text.startsWith('@/')
      ? join(SRC, specifier.text.slice(2))
      : specifier.text.startsWith('.')
        ? resolve(dirname(path), specifier.text)
        : null
    if (target === null) continue
    const rest = /^event-center\/(.+)$/.exec(slash(relative(MODULES, target)))?.[1]
    if (rest === undefined || /^public\/[a-z]+$/.test(rest)) continue
    const clause = isImport ? statement.importClause : undefined
    const typeOnly = isImport
      ? clause?.isTypeOnly === true ||
        (clause?.name === undefined &&
          clause?.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly))
      : statement.isTypeOnly
    out.push(`${rest} (${typeOnly ? 'type' : 'value'})`)
  }
  return out
}

// Compile-time: the Event Center module bootstrap hands over satisfies the narrow port.
const assignable = (module: EventCenterModule): WebhookIngressEventCenter => module

describe('RFC-558 —— integration 只经指定 adapter 取 event-center 的非 public 文件', () => {
  test('integration 全部源码里只剩 event-center adapter 按类型取 required-ports', () => {
    const files = walk(INTEGRATION)
    expect(files.length).toBeGreaterThanOrEqual(120)
    const found = [
      ...new Set(
        files.flatMap((path) =>
          eventCenterInternalImports(path, readFileSync(path, 'utf8')).map(
            (edge) => `${slash(relative(INTEGRATION, path))} -> ${edge}`,
          ),
        ),
      ),
    ].sort()
    expect(found).toEqual([
      'application/adapters/event-center-adapter.ts -> composition/required-ports (type)',
    ])
  }, 60_000)

  test('负对照：composition、application 与值导入都会被认出，public 不算', () => {
    const at = join(INTEGRATION, 'composition', 'probe.ts')
    expect(
      eventCenterInternalImports(
        at,
        "import type { EventCenterModule } from '@/modules/event-center/composition'\n" +
          "import { createEventCenterService } from '../../event-center/application/eventCenterService'\n" +
          "import type { A } from '@/modules/event-center/public/participants'\n" +
          "import type { B } from '@/modules/source-control/composition'\n",
      ),
    ).toEqual(['composition (type)', 'application/eventCenterService (value)'])
  })
})

describe('RFC-558 —— 窄端口与入站装配', () => {
  test('端口只取 event-center 的 exact public；webhook 入站的装配用它', () => {
    const port = read('integration/application/ports/webhookIngressEventCenter.ts')
    expect(port).toContain("from '@/modules/event-center/public/participants'")
    expect(port).toContain("from '@/modules/event-center/public/types'")
    expect(
      eventCenterInternalImports(
        join(INTEGRATION, 'application/ports/webhookIngressEventCenter.ts'),
        port,
      ),
    ).toEqual([])
    const ingress = read('integration/composition/webhookIngress.ts')
    expect(ingress).not.toContain('EventCenterModule')
    expect(
      ingress.match(/^ {2}readonly digitalEmployeeEventCenter\?: WebhookIngressEventCenter$/gm),
    ).toHaveLength(2)
  })

  test('事件中心模块满足窄端口（编译期由 tsc 检查，这里留一个运行期锚点）', () => {
    expect(typeof assignable).toBe('function')
  })
})
