// RFC-456 — `services/` 单一 owner 的零散实现归位（RFC-294 W9-D 第三步）。
//
// 锁四件事：
// ① 14 个文件已迁出 `services/`，新位置都在；`src/` 与用例零 import 旧路径（census AST，别名与相对路径都认，带负对照）。
// ② 装配根不直取任何模块的 `infrastructure/`：task-execution 的三个进程级钩子经它的 `composition.ts` 给装配根，且就是
//    `infrastructure` 那一份；`platform` 的三个新文件不取 `modules/`。
// ③ 插件代际 GC 的兼容包装并入 resource-catalog composition 后，包装函数没有第二份定义，`runPluginGenerationGc` 的默认宽限、
//    `now` 转发与回执映射不变。
// ④ 守护进程代际：进程内稳定，显式代际优先，空串与缺省回落到本进程这一代。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import * as teComposition from '@/modules/task-execution/composition'
import * as childBudget from '@/modules/task-execution/infrastructure/childBudget'
import * as executionWatch from '@/modules/task-execution/infrastructure/executionWatch'
import * as rcGcComposition from '@/modules/resource-catalog/composition/pluginGenerationGc'
import * as filePluginGenerationGc from '@/modules/resource-catalog/infrastructure/local/filePluginGenerationGc'
import type {
  PluginGenerationGcCommand,
  PluginGenerationGcInput,
} from '@/modules/resource-catalog/public/commands'
import { DAEMON_GENERATION, resolveDaemonGeneration } from '@/platform/execution/daemonGeneration'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const TE = 'modules/task-execution/'
const RC = 'modules/resource-catalog/'

const MOVED: Readonly<Record<string, string>> = {
  'services/sessionModeFallback': TE + 'domain/sessionModeFallback',
  'services/humanGateContinuationEffects': TE + 'application/drive/humanGateContinuationEffects',
  'services/execution/runtimeConfigFreeze': TE + 'composition/runtimeConfigFreeze',
  'services/execution/childBudget': TE + 'infrastructure/childBudget',
  'services/execution/executionWatch': TE + 'infrastructure/executionWatch',
  'services/daemonGeneration': 'platform/execution/daemonGeneration',
  'services/scriptAuthorGate': RC + 'domain/scriptAuthorGate',
  'services/codeHostAuthorGate': RC + 'domain/codeHostAuthorGate',
  'services/resourceCopyName': RC + 'domain/resourceCopyName',
  'services/scheduledTaskRefs': RC + 'domain/scheduledTaskRefs',
  'services/pluginGenerationGc': RC + 'composition/pluginGenerationGc',
  'services/humanGateDecisionE2eBarrier':
    'modules/collaboration/infrastructure/humanGateDecisionE2eBarrier',
  'services/controlListener': 'platform/execution/local/controlListener',
  'services/managedPeriodicJob': 'platform/background/managedPeriodicJob',
}
const OLD = Object.keys(MOVED)

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** 说明符解析到 `src/` 下的路径（不带扩展名）；包名等非本地说明符返回 null。 */
function targetOf(from: string, specifier: string): string | null {
  let target: string
  if (specifier.startsWith('@/')) target = specifier.slice(2)
  else if (specifier.startsWith('.')) {
    target = relative(SRC, resolve(from, '..', specifier))
      .split('\\')
      .join('/')
  } else return null
  return target.replace(/\.[cm]?tsx?$/, '')
}

/** `file -> target` for every import / re-export whose target satisfies `matches`. */
function importsMatching(files: readonly string[], matches: (target: string) => boolean): string[] {
  return files.flatMap((path) => {
    const rel = relative(REPO_ROOT, path).split('\\').join('/')
    const unit = sourceUnit(rel, readFileSync(path, 'utf8'))
    return [...new Set(importEdges(unit).map((edge) => targetOf(path, edge.specifier)))]
      .filter((target): target is string => target !== null && matches(target))
      .map((target) => `${relative(SRC, path).split('\\').join('/')} -> ${target}`)
  })
}

const isOld = (target: string) => OLD.includes(target)
const isModuleInfrastructure = (target: string) =>
  /^modules\/[^/]+\/infrastructure(?:\/|$)/.test(target)
const srcFile = (rel: string) => join(SRC, rel)

describe('RFC-456 —— 14 个单一 owner 文件迁出 services/', () => {
  test('旧文件都不在了，新位置都在', () => {
    for (const [from, to] of Object.entries(MOVED)) {
      expect([from, existsSync(join(SRC, `${from}.ts`))]).toEqual([from, false])
      expect([to, existsSync(join(SRC, `${to}.ts`))]).toEqual([to, true])
    }
  })

  test('src/ 与用例里零 import 旧路径', () => {
    expect(importsMatching(walk(SRC), isOld)).toEqual([])
    expect(importsMatching(walk(TESTS), isOld)).toEqual([])
  }, 60_000)

  test('负对照：判据认得出别名与相对路径，也不误伤同前缀的文件', () => {
    const probe = join(SRC, 'services', 'probe.ts')
    expect(isOld(targetOf(probe, '@/services/controlListener') ?? '')).toBe(true)
    expect(isOld(targetOf(probe, './execution/childBudget.ts') ?? '')).toBe(true)
    expect(isOld(targetOf(probe, './execution/childBudgetExtra') ?? '')).toBe(false)
    expect(importsMatching([srcFile('cli/stop.ts')], (t) => t.startsWith('platform/'))).toEqual([
      'cli/stop.ts -> platform/execution/local/controlListener',
    ])
  })
})

describe('RFC-456 —— 装配根与平台的边界', () => {
  const roots = [...walk(join(SRC, 'bootstrap')), srcFile('main.ts'), srcFile('server.ts')]

  test('装配根零 import 任何模块的 infrastructure/', () => {
    expect(importsMatching(roots, isModuleInfrastructure)).toEqual([])
  })

  test('负对照：判据认得出装配根直取模块内部', () => {
    const probe = srcFile('bootstrap/probe.ts')
    expect(
      isModuleInfrastructure(
        targetOf(probe, '@/modules/task-execution/infrastructure/childBudget') ?? '',
      ),
    ).toBe(true)
    expect(
      isModuleInfrastructure(targetOf(probe, '@/modules/task-execution/composition') ?? ''),
    ).toBe(false)
  })

  test('task-execution composition 给装配根的三个钩子就是 infrastructure 那一份', () => {
    expect(teComposition.setChildTaskBudgetCapacity).toBe(childBudget.setChildTaskBudgetCapacity)
    expect(teComposition.notifyChildBudgetTaskStatus).toBe(childBudget.notifyChildBudgetTaskStatus)
    expect(teComposition.notifyTaskTerminal).toBe(executionWatch.notifyTaskTerminal)
  })

  test('platform 的三个新文件不取 modules/', () => {
    const files = [
      'platform/execution/daemonGeneration.ts',
      'platform/execution/local/controlListener.ts',
      'platform/background/managedPeriodicJob.ts',
    ].map(srcFile)
    expect(importsMatching(files, (t) => t.startsWith('modules/'))).toEqual([])
  })
})

describe('RFC-456 —— 插件代际 GC 包装并入 resource-catalog composition', () => {
  test('包装函数没有第二份定义；composition 导出的就是 infrastructure 那一份', () => {
    const defining = walk(SRC).filter((path) =>
      /export function createPluginGenerationFilesystemGcPort\b/.test(readFileSync(path, 'utf8')),
    )
    expect(defining.map((path) => relative(SRC, path).split('\\').join('/'))).toEqual([
      RC + 'infrastructure/local/filePluginGenerationGc.ts',
    ])
    expect(rcGcComposition.createPluginGenerationFilesystemGcPort).toBe(
      filePluginGenerationGc.createPluginGenerationFilesystemGcPort,
    )
  })

  test('runPluginGenerationGc：默认宽限 24 小时、显式 now 才转发、回执路径原样返回', async () => {
    const inputs: PluginGenerationGcInput[] = []
    const removed = ['/plugins/a/gen-1', '/plugins/b/gen-2']
    const command: PluginGenerationGcCommand = {
      async run(input) {
        inputs.push(input)
        return { removedGenerationPaths: removed }
      },
    }
    const first = await rcGcComposition.runPluginGenerationGc({ command, executionFence: 'clear' })
    expect(first).toEqual(removed)
    expect(first).not.toBe(removed)
    await rcGcComposition.runPluginGenerationGc({
      command,
      executionFence: 'busy',
      graceMs: 5,
      now: 42,
    })
    expect(inputs).toEqual([
      { executionFence: 'clear', graceMs: 24 * 60 * 60_000 },
      { executionFence: 'busy', graceMs: 5, now: 42 },
    ])
    expect('now' in inputs[0]!).toBe(false)
  })
})

describe('RFC-456 —— 守护进程代际', () => {
  test('进程内稳定，显式代际优先，空串与缺省回落到本进程这一代', async () => {
    expect(DAEMON_GENERATION).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const again = await import('@/platform/execution/daemonGeneration')
    expect(again.DAEMON_GENERATION).toBe(DAEMON_GENERATION)
    expect(resolveDaemonGeneration('parent-generation')).toBe('parent-generation')
    expect(resolveDaemonGeneration('')).toBe(DAEMON_GENERATION)
    expect(resolveDaemonGeneration(undefined)).toBe(DAEMON_GENERATION)
  })
})
