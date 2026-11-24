// RFC-553 — knowledge-evolution 不再取 task-execution 的内部（RFC-294 S9 第九步）。
//
// 锁四件事：
// ① knowledge-evolution 的生产文件取 task-execution 只经它的 `public/*`（不碰 domain / inbound 等内部层；带负对照）。
// ② 融合编排从 task-execution 的 `public/types` 取启动人类型；融合路由的依赖里有 consumer 自有端口 `directTaskInitiator`，两处启动人都经它取，
//    路由文件不再出现投影函数。
// ③ bootstrap 用 task-execution composition 交出的投影函数绑定这个端口；task-execution 的 `public/types` 与 composition 各交出类型与投影。
// ④ 绑定的投影把 session 映成 manual、PAT / daemon 映成 api（与 task-execution 根启动用的是同一个函数）。
//
// 覆盖范围（C12）：① 覆盖 knowledge-evolution 的全部生产源码；② ③ 只读点名的文件；④ 是行为断言。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { directTaskInitiatorFromActorSource } from '@/modules/task-execution/composition'

const SRC = resolve(import.meta.dir, '..', 'src')
const KE = join(SRC, 'modules', 'knowledge-evolution')
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

const specifiersIn = (text: string) =>
  ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName)

/** Imports of task-execution that do not go through its exact public entries. */
const internalTaskExecutionImports = (text: string) =>
  specifiersIn(text).filter(
    (specifier) =>
      specifier.startsWith('@/modules/task-execution/') &&
      !/^@\/modules\/task-execution\/public\/(commands|queries|participants|events|types)$/.test(
        specifier,
      ),
  )

describe('RFC-553 —— knowledge-evolution 取 task-execution 只经 public', () => {
  test('knowledge-evolution 的生产文件没有 task-execution 内部 import', () => {
    const files = walk(KE)
    expect(files.length).toBeGreaterThanOrEqual(20)
    const offenders = files.flatMap((path) =>
      internalTaskExecutionImports(readFileSync(path, 'utf8')).map(
        (specifier) => `${slash(relative(SRC, path))} -> ${specifier}`,
      ),
    )
    expect(offenders).toEqual([])
  })

  test('负对照：domain、inbound 与 composition 的 import 都会被认出，public 入口不算', () => {
    expect(
      internalTaskExecutionImports(
        "import type { DirectTaskInitiator } from '@/modules/task-execution/domain/taskLaunchOrigin'\n" +
          "import { directTaskInitiatorFromActorSource } from '@/modules/task-execution/inbound/directTaskInitiator'\n" +
          "import { x } from '@/modules/task-execution/composition'\n" +
          "import type { DirectTaskInitiator as I } from '@/modules/task-execution/public/types'\n",
      ),
    ).toEqual([
      '@/modules/task-execution/domain/taskLaunchOrigin',
      '@/modules/task-execution/inbound/directTaskInitiator',
      '@/modules/task-execution/composition',
    ])
  })
})

describe('RFC-553 —— 启动人经 public 类型与路由自有端口', () => {
  test('融合编排从 public/types 取 DirectTaskInitiator', () => {
    expect(
      specifiersIn(read('modules/knowledge-evolution/application/fusionOrchestration.ts')),
    ).toContain('@/modules/task-execution/public/types')
  })

  test('融合路由的依赖有 directTaskInitiator，两处启动人都经它取，路由不再出现投影函数', () => {
    const routes = read('modules/knowledge-evolution/inbound/fusionRoutes.ts')
    expect(routes).toContain('readonly directTaskInitiator: (actor: Actor) => DirectTaskInitiator')
    expect(routes.split('deps.directTaskInitiator(actor)').length - 1).toBe(2)
    expect(routes).not.toContain('directTaskInitiatorFromActorSource')
  })

  test('bootstrap 用 task-execution composition 交出的投影绑定这个端口', () => {
    const composition = read('bootstrap/daemonHttpComposition.ts')
    expect(composition).toContain(
      'directTaskInitiator: (actor: Actor) => directTaskInitiatorFromActorSource(actor.source)',
    )
    const source = ts.createSourceFile(
      'daemonHttpComposition.ts',
      composition,
      ts.ScriptTarget.Latest,
      true,
    )
    const from = source.statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        return []
      const bindings = statement.importClause?.namedBindings
      return bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some(
          (element) => element.name.text === 'directTaskInitiatorFromActorSource',
        )
        ? [statement.moduleSpecifier.text]
        : []
    })
    expect(from).toEqual(['@/modules/task-execution/composition'])
    expect(read('modules/task-execution/public/types.ts')).toContain(
      "export type { DirectTaskInitiator } from '../domain/taskLaunchOrigin'",
    )
  })
})

describe('RFC-553 —— 绑定的投影（行为）', () => {
  test('session → manual，PAT / daemon → api', () => {
    expect(directTaskInitiatorFromActorSource('session')).toBe('manual')
    expect(directTaskInitiatorFromActorSource('pat')).toBe('api')
    expect(directTaskInitiatorFromActorSource('daemon')).toBe('api')
  })
})
