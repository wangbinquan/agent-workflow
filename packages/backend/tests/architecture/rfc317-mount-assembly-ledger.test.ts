// RFC-317 T54 · findings TP-04 —— `mountApiRoutes` 既是路由表又是装配器。
//
// 它在挂任何路由之前先 compose 出十几个模块实例。RFC-344 已删除 MCP 私有 Hono，
// 所以它现在每进程只运行一次；本账本继续推动剩余装配上移到 bootstrap。
//
// 已修的那一半（本批同批）：中间那句 `deps.digitalEmployeeWorkStart.bind(...)` 绑的是
// **进程级** deferred participant——webhook dispatcher 拿的就是它。第二次绑会静默覆盖
// 第一次，于是一旦有人发过一次 MCP 请求，此后所有 webhook / 事件驱动的工作启动都改道到
// MCP 那套私有 runtime 上，无日志无报错。处置：`bind` 改「已绑定即抛」，dispatcher 传
// `digitalEmployeeWorkStart: undefined`。
//
// 未修的那一半（本文件记账）：**装配本身仍在路由函数里**。彻底的做法是把 compose 提到
// `createApp` / `cli/start.ts`，把已建好的合同对象传给 `mountApiRoutes`——
// `mountTaskCatalogRoutes` / `mountEventCenterRoutes` / `mountDigitalEmployeeRoutes`
// 已经是这个形状。那是一次独立的重构（要动十几个模块的装配顺序与依赖方向），
// 不该塞进本批。这里先把「路由函数里还有多少次装配」钉成只减不增的数字。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const SERVER_TS = resolve(import.meta.dir, '..', '..', 'src', 'server.ts')

/**
 * RFC-344 identity operation cutover 后 `mountApiRoutes` 体内的装配调用：12 次。
 *
 * **只减不增**：多一次 ⇒ 红（新模块的装配请落在 bootstrap，别再往路由函数里塞）；
 * 少一次却不销账 ⇒ 也红。
 */
const ASSEMBLY_CALLS_IN_MOUNT: readonly string[] = []

function hasMountApiRoutesFunction(source: string): boolean {
  const sf = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
  return sf.statements.some(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'mountApiRoutes' &&
      statement.body !== undefined,
  )
}

/** `mountApiRoutes` 体内所有 `compose*(` / `create*Store(` 形态的调用名。 */
export function assemblyCallsInMountApiRoutes(source: string): string[] {
  const sf = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'mountApiRoutes' && node.body) {
      const walk = (inner: ts.Node): void => {
        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
          const name = inner.expression.text
          if (name.startsWith('compose') || /^create.*Store$/.test(name)) found.push(name)
        }
        ts.forEachChild(inner, walk)
      }
      walk(node.body)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found.sort()
}

describe('RFC-317 T54 —— 路由函数里的装配调用只减不增', () => {
  test('逐条相等（新增一次装配 ⇒ 红）', () => {
    expect(
      assemblyCallsInMountApiRoutes(readFileSync(SERVER_TS, 'utf8')),
      '又往 mountApiRoutes 里塞了一次装配——新模块的装配请落在 bootstrap，把建好的合同对象传进来',
    ).toEqual([...ASSEMBLY_CALLS_IN_MOUNT].sort())
  })

  test('目标函数仍存在；零装配调用是目标态，不是假绿', () => {
    expect(hasMountApiRoutesFunction(readFileSync(SERVER_TS, 'utf8'))).toBe(true)
  })
})

describe('RFC-317 T54 负向 fixture —— 判据只看那个函数体', () => {
  test('函数体内的 compose 被计入', () => {
    expect(
      assemblyCallsInMountApiRoutes(
        `export function mountApiRoutes(app: any, deps: any) { const x = composeThing(deps) }`,
      ),
    ).toEqual(['composeThing'])
  })

  test('**别的函数**里的 compose 不计入（判据不是全文件计数）', () => {
    expect(
      assemblyCallsInMountApiRoutes(
        `function other() { const x = composeThing({}) }\n` +
          `export function mountApiRoutes(app: any, deps: any) { app.get('/x', () => {}) }`,
      ),
    ).toEqual([])
  })

  test('`create*Store` 也算装配（它同样是每次挂载都新建一份）', () => {
    expect(
      assemblyCallsInMountApiRoutes(
        `export function mountApiRoutes() { const s = createThingStore('/tmp') }`,
      ),
    ).toEqual(['createThingStore'])
  })
})
