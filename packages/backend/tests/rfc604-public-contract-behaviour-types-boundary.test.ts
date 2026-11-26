// RFC-604 — public 合同里的行为类型：日志器与回调的检测规则（RFC-294 S9 余项）。
//
// 为什么存在：S9 的类型污染检测器把两类行为类型一律记为债——合同带着平台日志器（检测器禁止 `@/platform/*` 的任何类型），以及函数类型。
// 前者是纯行为接口、每个模块本来都依赖它；方法参数里带类型的回调本来就是方法签名的一部分。两条规则把它们认作合同的正当形态；输入对象里函数
// 类型的成员按 RFC-569 的做法改写为方法签名。锁三件事：
// ① 规则一：只放行 `@/platform/logging/logger` 的 `Logger`（具名、命名空间、`import()` 三种写法）；同文件的其他导出与其他平台类型照旧记债。
// ② 规则二：方法 / 可选参数 / 调用签名 / 函数声明参数里的回调不记债，回调自己的参数与返回类型照旧检查；属性、返回值、联合成员里的函数类型照旧记债。
// ③ 改写：七个输入成员在源码里是方法签名，不再是函数类型的属性。
//
// 覆盖范围（C12）：① ② 在合成语料上跑检测器本身；③ 读四个端口文件；真实语料的逐条相等由 `rfc294-architecture-preflight` 执行。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { publicSurfaceViolations, sourceUnits } from './architecture/rfc294Gates'

const MODULES = join(import.meta.dir, '..', 'src', 'modules')

const violationsOf = (files: Record<string, string>) =>
  publicSurfaceViolations(sourceUnits(files)).map((line) => line.replace(/^modules\//, ''))

describe('RFC-604 —— public 合同里的行为类型', () => {
  test('规则一：只放行平台日志器这一个接口', () => {
    expect(
      violationsOf({
        'packages/backend/src/modules/alpha/public/types.ts': [
          "import type { Logger } from '@/platform/logging/logger'",
          "import type * as Logging from '@/platform/logging/logger'",
          'export interface AlphaPort {',
          '  run(input: { readonly log: Logger }): void',
          '  child(log: Logging.Logger): void',
          "  lazy(log: import('@/platform/logging/logger').Logger): void",
          '}',
        ].join('\n'),
      }),
    ).toEqual([])
    expect(
      violationsOf({
        'packages/backend/src/modules/alpha/public/types.ts': [
          "import type { LogLevel } from '@/platform/logging/logger'",
          "import type * as Logging from '@/platform/logging/logger'",
          "import type { PersistenceTx } from '@/platform/persistence/persistenceDb'",
          'export interface AlphaPort {',
          '  level(value: LogLevel): void',
          '  levels(value: Logging.LogLevel): void',
          '  write(tx: PersistenceTx): void',
          '}',
        ].join('\n'),
      }),
    ).toEqual([
      'alpha/public/types.ts#AlphaPort: forbidden type import @/platform/logging/logger#LogLevel',
      'alpha/public/types.ts#AlphaPort: forbidden type import @/platform/persistence/persistenceDb#PersistenceTx',
    ])
  })

  test('规则二：方法参数里的回调算闭合，其他位置的函数类型照旧记债', () => {
    expect(
      violationsOf({
        'packages/backend/src/modules/beta/public/types.ts': [
          'export interface Scope { readonly id: string }',
          'export interface BetaPort {',
          '  withScope<R>(operation: (scope: Scope) => Promise<R>): Promise<R>',
          '  discard(onProgress?: (partialFailures: number) => void): void',
          '  nested(input: { check(): Promise<void>; each(visit: (id: string) => void): void }): void',
          '}',
          'export interface BetaVisitor {',
          '  (visit: (node: string) => boolean): void',
          '}',
          'export function choose(pick: (value: string) => boolean): string {',
          "  return pick('a') ? 'a' : 'b'",
          '}',
        ].join('\n'),
      }),
    ).toEqual([])
    expect(
      violationsOf({
        'packages/backend/src/modules/beta/public/types.ts': [
          'export interface BetaInput { readonly onEvent: (event: string) => void }',
          'export interface BetaFactory { make(): () => void }',
          'export interface BetaNotifier { notify(callback: ((value: string) => void) | undefined): void }',
          'export interface BetaWalker { each(visit: (value: unknown) => void): void }',
        ].join('\n'),
      }),
    ).toEqual([
      'beta/public/types.ts#BetaFactory: unsafe/open type FunctionType',
      'beta/public/types.ts#BetaInput: unsafe/open type FunctionType',
      'beta/public/types.ts#BetaNotifier: unsafe/open type FunctionType',
      'beta/public/types.ts#BetaWalker: unsafe/open type UnknownKeyword',
    ])
  })

  test('改写：输入对象里的回调成员是方法签名', () => {
    const members = (path: string, names: readonly string[]) => {
      const text = readFileSync(join(MODULES, path), 'utf8')
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
      const found: string[] = []
      const visit = (node: ts.Node): void => {
        if (
          (ts.isMethodSignature(node) || ts.isPropertySignature(node)) &&
          names.includes(node.name.getText(source))
        )
          found.push(
            `${node.name.getText(source)}: ${
              ts.isMethodSignature(node)
                ? 'method'
                : node.type !== undefined && ts.isFunctionTypeNode(node.type)
                  ? 'function-typed property'
                  : 'property'
            }`,
          )
        ts.forEachChild(node, visit)
      }
      visit(source)
      return found.sort()
    }
    expect(
      members('runtime-management/application/ports/agentLiveCapture.ts', [
        'getRootSessionId',
        'onInsert',
      ]),
    ).toEqual(['getRootSessionId: method', 'onInsert: method'])
    expect(
      members('source-control/application/ports/repositoryPreparationEffects.ts', [
        'assertCurrent',
        'checkpoint',
      ]),
    ).toEqual(['assertCurrent: method', 'assertCurrent: method', 'checkpoint: method'])
    expect(
      members('source-control/application/ports/scratchWorkspaceEffects.ts', ['assertCurrent']),
    ).toEqual(['assertCurrent: method', 'assertCurrent: method'])
    expect(members('source-control/application/ports/isolationWorkspace.ts', ['runAgent'])).toEqual(
      ['runAgent: method'],
    )
  })
})
