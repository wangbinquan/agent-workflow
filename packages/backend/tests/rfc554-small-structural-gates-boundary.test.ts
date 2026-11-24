// RFC-554 — 两个小结构门：死的 export-star 门面与 application 里的直接副作用（RFC-294 S9 余项）。
//
// 锁三件事：
// ① runtime-management 的 `application/runtimeRegistry.ts` 没有 `export *` / `export type *`（判据带负对照）。
// ② integration 的仓库端点发现是 infrastructure 的 HTTP 适配器：`infrastructure/codeHost/repositoryEndpointDiscovery.ts` 交出它，application 下
//    没有它，组合根从新位置转出。
// ③ 模块（`src/modules/**`）里没有任何通配转出（`export-star-barrels` 清零后的全模块断言；结构门只计指向 DB 与模块内部的那一类，照旧计数）。
//
// 覆盖范围（C12）：① ② 只读点名的文件；③ 覆盖 `src/modules` 的全部源码。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const SRC = resolve(import.meta.dir, '..', 'src')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Wildcard re-exports: `export * from`, `export type * from`, `export * as ns from`. */
function wildcardExports(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) =>
    ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier !== undefined &&
    (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause))
      ? [statement.getText(source)]
      : [],
  )
}

const exportsName = (path: string, name: string) => {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  return source.statements.some(
    (statement) =>
      (ts.isFunctionDeclaration(statement) && statement.name?.text === name) ||
      (ts.isExportDeclaration(statement) &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some((element) => element.name.text === name)),
  )
}

describe('RFC-554 —— 死的 export-star 门面删除', () => {
  test('runtimeRegistry.ts 没有通配转出', () => {
    const path = 'modules/runtime-management/application/runtimeRegistry.ts'
    expect(wildcardExports(path, read(path))).toEqual([])
  })

  test('模块里没有通配转出', () => {
    const files = walk(join(SRC, 'modules'))
    expect(files.length).toBeGreaterThanOrEqual(1500)
    const offenders = files.flatMap((path) =>
      wildcardExports(path, readFileSync(path, 'utf8')).map(
        (statement) => `${slash(relative(SRC, path))}: ${statement}`,
      ),
    )
    expect(offenders).toEqual([])
  }, 60_000)

  test('负对照：三种通配写法都会被认出，具名转出不算', () => {
    expect(
      wildcardExports(
        'probe.ts',
        "export * from '../domain/runtimeProfile'\n" +
          "export type * from '../public/types'\n" +
          "export * as profile from '../domain/runtimeProfile'\n" +
          "export { a, type B } from './named'\n",
      ),
    ).toEqual([
      "export * from '../domain/runtimeProfile'",
      "export type * from '../public/types'",
      "export * as profile from '../domain/runtimeProfile'",
    ])
  })
})

describe('RFC-554 —— 仓库端点发现是 infrastructure 的 HTTP 适配器', () => {
  test('在 infrastructure/codeHost，application 下没有它，组合根从新位置转出', () => {
    expect(
      existsSync(join(SRC, 'modules/integration/application/repositoryEndpointDiscovery.ts')),
    ).toBe(false)
    expect(
      exportsName(
        'modules/integration/infrastructure/codeHost/repositoryEndpointDiscovery.ts',
        'createRepositoryEndpointDiscovery',
      ),
    ).toBe(true)
    expect(read('modules/integration/composition.ts')).toContain(
      "} from './infrastructure/codeHost/repositoryEndpointDiscovery'",
    )
  })
})
