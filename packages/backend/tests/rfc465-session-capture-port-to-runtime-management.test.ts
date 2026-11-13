// RFC-465 — 会话捕获的持久化端口与请求合同归 runtime-management（RFC-294 W9-D 第十二步）。
//
// 锁四件事：
// ① 持久化端口（`RuntimeSessionCapturePersistence` / `RuntimeSessionCaptureEvent`）只在 runtime-management 定义一次，task-execution
//    下的旧文件不在、src / 用例 / 脚本零引用旧路径；runtime-management `public/participants` 导出的就是它。
// ② runtime-management 的 application / domain / engine / public 零取 `@/services/` 与 task-execution（census AST，带负对照）。
// ③ `services/runtime/types` 不再取 task-execution，三个驱动侧形状由 runtime-management 的合同给出（源码锚点）。
// ④ 编译期：事件 kind 与 task-execution 落库的 kind 双向相等；`SessionCaptureContext` 去掉四个本机位置字段后与捕获请求双向相等；
//    清扫上下文就是 runtime-management 的清扫请求，sink 是 `SystemAgentEventSinkV1`。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
// RFC-492: the capture request, the sweep request / outcome and the capture event are no longer offered by
// runtime-management's public (only the driver family read them); read their declaration sites.
import type {
  AgentSessionCaptureRequest,
  SystemAgentSessionSweepOutcome as RuntimeManagementSweepOutcome,
  SystemAgentSessionSweepRequest,
} from '@/modules/runtime-management/application/ports/agentMaterialEvidence'
import type { RuntimeSessionCaptureEvent } from '@/modules/runtime-management/application/ports/runtimeSessionCapturePersistence'
import type { SystemAgentEventSinkV1 } from '@/modules/runtime-management/public/participants'
import type { NodeExecutionEventSnapshot } from '@/modules/task-execution/application/ports/nodeExecutionPersistence'
import type {
  SessionCaptureContext,
  SystemAgentSessionSweepContext,
  SystemAgentSessionSweepOutcome,
} from '@/modules/runtime-management/infrastructure/drivers/types'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const RM = 'modules/runtime-management/'
const OLD_PORT = 'modules/task-execution/application/ports/runtimeSessionCapturePersistence'
const NEW_PORT = RM + 'application/ports/runtimeSessionCapturePersistence.ts'
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

const specifiersOf = (path: string) => {
  const unit = sourceUnit(slash(relative(REPO_ROOT, path)), readFileSync(path, 'utf8'))
  return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
}

describe('RFC-465 —— 持久化端口只在 runtime-management', () => {
  test('task-execution 下的旧文件不在，src / 用例 / 脚本零引用旧路径', () => {
    expect(existsSync(join(SRC, OLD_PORT + '.ts'))).toBe(false)
    const self = slash(import.meta.path)
    const offenders = [SRC, import.meta.dir, resolve(REPO_ROOT, 'scripts')]
      .flatMap(walk)
      .filter((path) => slash(path) !== self)
      .filter((path) => readFileSync(path, 'utf8').includes(OLD_PORT))
      .map((path) => slash(relative(REPO_ROOT, path)))
    expect(offenders).toEqual([])
  }, 30_000)

  test('两个端口类型只在 runtime-management 定义一次', () => {
    const corpus = walk(SRC).map((path) => ({
      path: slash(relative(SRC, path)),
      text: readFileSync(path, 'utf8'),
    }))
    for (const name of ['RuntimeSessionCapturePersistence', 'RuntimeSessionCaptureEvent']) {
      const definers = corpus
        .filter((file) => new RegExp(`export\\s+(interface|type)\\s+${name}\\b`).test(file.text))
        .map((file) => file.path)
      expect([name, definers]).toEqual([name, [NEW_PORT]])
    }
  }, 30_000)

  test('runtime-management public/participants 导出的就是它', () => {
    const text = readFileSync(join(SRC, RM, 'public/participants.ts'), 'utf8')
    const block =
      /export type \{([^}]*)\} from '\.\.\/application\/ports\/runtimeSessionCapturePersistence'/.exec(
        text,
      )
    expect(block).not.toBeNull()
    expect(
      block![1]!
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .sort(),
      // RFC-492: the capture event's only reader outside the module was the driver family, which now lives in
      // runtime-management's infrastructure and reads the port file directly; the event is no longer offered here.
    ).toEqual(['RuntimeSessionCapturePersistence'])
  })
})

describe('RFC-465 —— runtime-management 的业务层不再取 services/ 与 task-execution', () => {
  test('application / domain / engine / public 零取 @/services/ 与 task-execution', () => {
    const offenders = ['application', 'domain', 'engine', 'public']
      .flatMap((layer) => walk(join(SRC, RM, layer)))
      .flatMap((path) =>
        specifiersOf(path)
          .filter(
            (specifier) =>
              specifier.startsWith('@/services/') ||
              specifier.startsWith('@/modules/task-execution/'),
          )
          .map((specifier) => `${slash(relative(SRC, path))} -> ${specifier}`),
      )
    expect(offenders).toEqual([])
  })

  test('负对照：判据认得出取 task-execution 端口的写法', () => {
    const probe = sourceUnit(
      'packages/backend/src/modules/runtime-management/application/ports/probe.ts',
      `import type { RuntimeSessionCapturePersistence } from '@/${OLD_PORT}'\n`,
    )
    expect(importEdges(probe).map((edge) => edge.specifier)).toEqual([`@/${OLD_PORT}`])
  })
})

describe('RFC-465 —— 驱动侧形状由 runtime-management 合同给出', () => {
  // RFC-492: the driver family moved into runtime-management's infrastructure.
  const path = join(SRC, 'modules/runtime-management/infrastructure/drivers/types.ts')
  const text = readFileSync(path, 'utf8')

  test('驱动的 types 不取 task-execution，不再自定义捕获请求字段与清扫 sink', () => {
    expect(specifiersOf(path).filter((s) => s.startsWith('@/modules/task-execution/'))).toEqual([])
    expect(text).toContain(
      'export interface SessionCaptureContext extends AgentSessionCaptureRequest {',
    )
    expect(text).toContain(
      'export type SystemAgentSessionSweepContext = SystemAgentSessionSweepRequest\n',
    )
    expect(text).toContain('export type { SystemAgentSessionSweepOutcome }\n')
    expect(text).not.toContain('RuntimeSessionCapturePersistence')
    expect(text).not.toContain('export interface SystemAgentSessionSweepOutcome')
  })

  test('编译期：kind 与落库一致，驱动上下文 = 捕获请求 + 四个位置字段，清扫合同是同一份', () => {
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    type Location = 'worktreePath' | 'configDirEnv' | 'configDirName' | 'opencodeDbPath'
    const kind: Same<RuntimeSessionCaptureEvent['kind'], NodeExecutionEventSnapshot['kind']> = true
    const request: Same<Omit<SessionCaptureContext, Location>, AgentSessionCaptureRequest> = true
    const sweep: Same<SystemAgentSessionSweepContext, SystemAgentSessionSweepRequest> = true
    const sink: Same<SystemAgentSessionSweepRequest['sink'], SystemAgentEventSinkV1> = true
    const outcome: Same<SystemAgentSessionSweepOutcome, RuntimeManagementSweepOutcome> = true
    expect([kind, request, sweep, sink, outcome]).toEqual([true, true, true, true, true])
  })
})
