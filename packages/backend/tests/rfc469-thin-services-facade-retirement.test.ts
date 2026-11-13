// RFC-469 — 退役三个薄转出：taskAuthorization、sessionEventSink、taskExecutionCallClosure（RFC-294 W9-D 第十六步）。
//
// 锁四件事：
// ① 三个 `services/` 文件不在；src / 用例 / 脚本零 import 它们（TypeScript `preProcessFile` 取文件的全部模块引用：空 `import {}`、
//    副作用 import、转出、类型、动态 import 与 require 都认，相对路径按所在文件解析；带负对照）。census 的 `importEdges` 按绑定逐条
//    出边，`import {} from` 零条边——生产里正好有过这种写法（`services/task.ts` 的空导入），所以这里不用它。
// ② 会话 sink 的类型由 runtime-management `public/participants` 转出（含补上的 `SessionCaptureTerminalState`）：`services/` 的两个消费方
//    取那里；memory 的两个 infrastructure 文件取 memory 自己的蒸馏端口（它已经从 runtime-management 取这些类型，再转出），不新增
//    off-DAG offered 文件对。
// ③ 生产不可达的旧 SQLite 任务授权（原先只经那行空导入可达）迁入 `tests/helpers/`。
// ④ `freezeTaskExecutionCallClosure` 并入它唯一的调用方 `services/task.ts`，函数体就是原来那一行；`services/task.ts` 不再有空导入。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RETIRED = [
  'services/taskAuthorization',
  'services/sessionEventSink',
  'services/execution/taskExecutionCallClosure',
]
const RM_PARTICIPANTS = '@/modules/runtime-management/public/participants'
const SERVICE_SINK_CONSUMERS = [
  'services/runtime/opencode/sessionCapture.ts',
  // RFC-491: the native system-agent run moved into task-execution.
  'modules/task-execution/infrastructure/local/nativeSystemAgentRun.ts',
]
const MEMORY_SINK_CONSUMERS = [
  'modules/memory/infrastructure/memoryDistillSessionEventSink.ts',
  'modules/memory/infrastructure/memoryDistillWorkStore.ts',
]
const MEMORY_PORT = 'modules/memory/application/ports/distillWorkStore.ts'
const LEGACY_AUTHORIZATION =
  'modules/task-execution/infrastructure/legacySqliteTaskAuthorization.ts'
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Resolve an import specifier to a `src/`-relative path stem (alias and relative forms), or null. */
function targetOf(from: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2)
  if (!specifier.startsWith('.')) return null
  const rel = slash(relative(SRC, resolve(from, '..', specifier)))
  return rel.startsWith('..') ? null : rel.replace(/\.[cm]?tsx?$/, '')
}

/** Every module specifier a file references: static (incl. empty `import {}`), side-effect, re-export, type, dynamic, require. */
const specifiersIn = (text: string) =>
  ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName)

const importsOf = (files: readonly string[]) =>
  files.flatMap((path) =>
    specifiersIn(readFileSync(path, 'utf8'))
      .filter((specifier) => RETIRED.includes(targetOf(path, specifier) ?? ''))
      .map((specifier) => `${slash(relative(REPO_ROOT, path))} -> ${specifier}`),
  )

const specifiersOf = (path: string) => specifiersIn(read(path))

describe('RFC-469 —— 三个薄转出不在、零引用', () => {
  test('三个文件不在', () => {
    for (const path of RETIRED)
      expect([path, existsSync(join(SRC, `${path}.ts`))]).toEqual([path, false])
  })

  test('src、用例与脚本零 import 它们', () => {
    expect(importsOf(walk(SRC))).toEqual([])
    expect(importsOf(walk(TESTS))).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')))).toEqual([])
  }, 60_000)

  test('负对照：判据认得出别名、相对路径、空 import {} 与动态 import，不误伤同前缀与注释', () => {
    const probe = join(SRC, 'services', 'probe.ts')
    expect(targetOf(probe, './taskAuthorization')).toBe('services/taskAuthorization')
    expect(targetOf(probe, './execution/taskExecutionCallClosure')).toBe(
      'services/execution/taskExecutionCallClosure',
    )
    expect(targetOf(probe, '@/services/sessionEventSink')).toBe('services/sessionEventSink')
    expect(
      RETIRED.includes(
        targetOf(probe, '../modules/task-execution/application/taskExecutionCallClosure') ?? '',
      ),
    ).toBe(false)
    expect(
      specifiersIn(
        "import {} from '@/services/taskAuthorization'\n" +
          "const sink = await import('./sessionEventSink')\n" +
          "// import '@/services/execution/taskExecutionCallClosure'\n",
      ).sort(),
    ).toEqual(['./sessionEventSink', '@/services/taskAuthorization'])
  })
})

describe('RFC-469 —— 会话 sink 类型经 runtime-management public', () => {
  test('public/participants 转出三个会话 sink 类型', () => {
    const participants = read('modules/runtime-management/public/participants.ts')
    expect(participants).toMatch(
      /export type \{\s*SessionCaptureIncompleteReason,\s*SessionCaptureTerminalState,\s*SystemAgentEventSinkV1,\s*\} from '\.\.\/application\/ports\/agentSessionEvents'/,
    )
  })

  test('services/ 的两个消费方取 runtime-management public/participants', () => {
    for (const path of SERVICE_SINK_CONSUMERS)
      expect([path, specifiersOf(path).includes(RM_PARTICIPANTS)]).toEqual([path, true])
  })

  test('memory 的两个 infrastructure 文件取 memory 自己的端口，端口从 runtime-management 转出三个类型', () => {
    for (const path of MEMORY_SINK_CONSUMERS) {
      const specifiers = specifiersOf(path)
      expect([path, specifiers.includes('../application/ports/distillWorkStore')]).toEqual([
        path,
        true,
      ])
      expect([path, specifiers.filter((s) => s.includes('runtime-management'))]).toEqual([path, []])
    }
    expect(read(MEMORY_PORT)).toMatch(
      /export type \{\s*SessionCaptureIncompleteReason,\s*SessionCaptureTerminalState,\s*SystemAgentEventSinkV1,\s*\} from '@\/modules\/runtime-management\/public\/participants'/,
    )
  })
})

describe('RFC-469 —— 生产不可达的旧 SQLite 任务授权迁入用例树', () => {
  test('不在 src，在 tests/helpers', () => {
    expect(existsSync(join(SRC, LEGACY_AUTHORIZATION))).toBe(false)
    expect(existsSync(join(TESTS, 'helpers', 'legacySqliteTaskAuthorization.ts'))).toBe(true)
  })
})

describe('RFC-469 —— 一行函数并回唯一调用方', () => {
  // RFC-478: the only caller (the workflow sync preview) left services/task.ts for task-execution application, and the
  // one-line freeze went with it.
  test('同步预览查询自己定义 freezeTaskExecutionCallClosure，函数体就是原来那一行', () => {
    const task = read('modules/task-execution/application/workflowSyncPreviewQuery.ts')
    expect(task).toContain('async function freezeTaskExecutionCallClosure(')
    expect(task).toContain(
      '  return await resourceAuthority.resources.freezeCallClosure(resourceAuthority, root)\n',
    )
    expect(task).toContain(
      'return await freezeTaskExecutionCallClosure({ id: workflowId, definition }, deps.launchResources)',
    )
    expect(task).not.toMatch(/import \{\s*\} from/)
  })
})
