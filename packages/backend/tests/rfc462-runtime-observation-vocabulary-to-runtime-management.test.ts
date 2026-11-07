// RFC-462 — 运行时观测词汇归 runtime-management（RFC-294 W9-D 第九步）。
//
// 锁三件事：
// ① 七个观测词汇（规范化事件一族、系统事件观测、驱动能力声明）在后端源码里只在 runtime-management 的两个端口文件各定义一次，
//    `services/runtime/types.ts` 不再声明、只经 runtime-management `public/participants` 再导出。
// ② task-execution 的 `ports/agentExecution` 与 `taskAgentRun`、runtime-management 的 `agentProtocol` 不再为它们取 `services/`；
//    `agentMaterialEvidence` 只剩会话捕获 / 清扫上下文取 `services/runtime/types`（驱动接缝，非目标）。census AST，带负对照。
// ③ `DeclarationFace` 仍是声明清单的面集合：驱动的 `declarationFaces` 记录与 shared `DeclaredInjectionManifest` 的键一一对应。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { DeclaredInjectionManifest } from '@agent-workflow/shared'
import type { DeclarationFace } from '@/modules/runtime-management/public/participants'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const RM_PORTS = 'modules/runtime-management/application/ports/'
const slash = (path: string) => path.split('\\').join('/')
const OBSERVATIONS = [
  'NormalizedTokenDelta',
  'PersistedEventKind',
  'NormalizedEvent',
  'NormalizedEventData',
  'SystemEventObservation',
] as const
const CAPABILITIES = ['DeclarationFace', 'RuntimeDriverCapabilities'] as const

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

const specifiersOf = (relativePath: string) => {
  const path = join(SRC, relativePath)
  const unit = sourceUnit(slash(relative(REPO_ROOT, path)), readFileSync(path, 'utf8'))
  return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
}

describe('RFC-462 —— 观测词汇只在 runtime-management 定义一次', () => {
  const corpus = walk(SRC).map((path) => ({
    path: slash(relative(SRC, path)),
    text: readFileSync(path, 'utf8'),
  }))
  const definers = (name: string) =>
    corpus
      .filter((file) => new RegExp(`export\\s+(interface|type)\\s+${name}\\b`).test(file.text))
      .map((file) => file.path)

  test('事件一族与系统事件观测在 agentObservations，驱动能力声明在 agentProtocol', () => {
    for (const name of OBSERVATIONS)
      expect([name, definers(name)]).toEqual([name, [RM_PORTS + 'agentObservations.ts']])
    for (const name of CAPABILITIES)
      expect([name, definers(name)]).toEqual([name, [RM_PORTS + 'agentProtocol.ts']])
  }, 30_000)

  test('services/runtime/types 只从 runtime-management public 再导出它们', () => {
    const types = readFileSync(join(SRC, 'services/runtime/types.ts'), 'utf8')
    const reexport =
      /export type \{([^}]*)\} from '@\/modules\/runtime-management\/public\/participants'/.exec(
        types,
      )
    expect(reexport).not.toBeNull()
    const names = reexport![1]!.split(',').map((name) => name.trim())
    for (const name of [...OBSERVATIONS, ...CAPABILITIES]) expect(names).toContain(name)
  })
})

describe('RFC-462 —— 消费方改取 owner', () => {
  test('task-execution 两处与 runtime-management agentProtocol 不再取 services/', () => {
    for (const path of [
      'modules/task-execution/application/ports/agentExecution.ts',
      'modules/runtime-management/application/ports/agentProtocol.ts',
    ])
      expect([path, specifiersOf(path).filter((s) => s.startsWith('@/services/'))]).toEqual([
        path,
        [],
      ])
    const run = specifiersOf('modules/task-execution/application/taskAgentRun.ts')
    expect(run).not.toContain('@/services/runtime/types')
    expect(run).toContain('@/modules/runtime-management/public/participants')
    expect(run).toContain('@/modules/runtime-management/public/types')
  })

  test('agentMaterialEvidence 只剩会话捕获 / 清扫上下文取 services/runtime/types', () => {
    const text = readFileSync(join(SRC, RM_PORTS, 'agentMaterialEvidence.ts'), 'utf8')
    const fromServices = /import type \{([^}]*)\} from '@\/services\/runtime\/types'/.exec(text)
    expect(fromServices).not.toBeNull()
    expect(
      fromServices![1]!
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .sort(),
    ).toEqual([
      'SessionCaptureContext',
      'SystemAgentSessionSweepContext',
      'SystemAgentSessionSweepOutcome',
    ])
    expect(specifiersOf(RM_PORTS + 'agentMaterialEvidence.ts')).toContain('./agentObservations')
  })

  test('负对照：判据认得出经 services/ 取的写法', () => {
    const probe = sourceUnit(
      'packages/backend/src/modules/task-execution/application/probe.ts',
      "import type { NormalizedEvent } from '@/services/runtime/types'\n",
    )
    expect(importEdges(probe).map((edge) => edge.specifier)).toEqual(['@/services/runtime/types'])
  })
})

describe('RFC-462 —— DeclarationFace 仍是声明清单的面集合', () => {
  test('与 shared DeclaredInjectionManifest 的键一一对应（编译期双向断言）', () => {
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    const same: Same<DeclarationFace, keyof DeclaredInjectionManifest> = true
    expect(same).toBe(true)
  })
})
