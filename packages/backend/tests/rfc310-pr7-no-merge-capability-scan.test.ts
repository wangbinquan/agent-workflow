// RFC-310 PR-7 T84 —— 「平台永不自动 merge/approve/resolve/force-push」的
// 源码级负扫描（design §0.3 不可协商不变量 / §10.4）。
//
// 范围限定：RFC-269 的通用 code-host action 目录里 `mr.merge`/`mr.approve`/
// `thread.resolve` 存在（工作流脚本的用户显式编排面，不属本 RFC 管辖）；本
// 扫描锁的是 **DevelopmentMission 自动化链路**——development-automation 全模块、
// integration 的 development/mr 系文件、source-control 全模块——这些代码里：
//   ①上述三个 action 字面量不可出现（连引用都不许，不存在「误接」通道）；
//   ②git push 的参数构造不得携带任何 force 形态（--force/--force-with-lease/
//     -f/+refspec）；
//   ③决策联合与 capability 目录没有 merge/approve/resolve 类条目。
// 变异实证（写入时验证）：在 deliverCandidate push args 加 '--force' 本测试红；
// 在 mrEnsure 引用 'mr.merge' 亦红。

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  ADAPTER_CAPABILITY_IDS,
  AGENT_CAPABILITY_IDS,
  PROGRAM_CAPABILITY_IDS,
} from '../src/modules/development-automation/domain/capabilityDefinition'

const ROOTS = [
  join(import.meta.dir, '../src/modules/development-automation'),
  join(import.meta.dir, '../src/modules/integration'),
  join(import.meta.dir, '../src/modules/source-control'),
]

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.ts')) acc.push(p)
  }
  return acc
}

function scanLines(
  matcher: (line: string) => boolean,
  lineFilter?: (line: string) => boolean,
): string[] {
  const offenders: string[] = []
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const rel = relative(join(import.meta.dir, '..'), file)
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const trimmed = line.trim()
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
            return
          if (lineFilter !== undefined && !lineFilter(line)) return
          if (matcher(line)) offenders.push(`${rel}:${index + 1}: ${trimmed.slice(0, 100)}`)
        })
    }
  }
  return offenders
}

describe('rfc310 pr7 T84 — no merge/approve/resolve/force-push reachability', () => {
  test('forbidden code-host actions are not referenced anywhere in the mission chain', () => {
    const forbidden =
      /'(mr\.merge|mr\.approve|thread\.resolve)'|"(mr\.merge|mr\.approve|thread\.resolve)"/
    expect(scanLines((line) => forbidden.test(line))).toEqual([])
  })

  test('no force push shape in any git argument construction', () => {
    // push 语境下的 force 形态；`force: true` 的 fs 选项（rmSync）与之无关，
    // 通过「行内含 push/git 参数上下文」过滤。
    const forceish = /--force(-with-lease)?|'-f'|"\s*-f\s*"|'\+refs\/|"\+refs\//
    // 语境过滤到 push：`git add -f`（上传目标按 §9.2 保全进 candidate）是
    // 正当的非 push 语义，不在本锁范围。
    const offenders = scanLines(
      (line) => forceish.test(line),
      (line) => /push/i.test(line),
    )
    expect(offenders).toEqual([])
  })

  test('decision union and capability catalog carry no merge/approve/resolve arm', () => {
    // 决策联合的 kind 全集从 decision.ts 源码文本提取（schema 被 superRefine
    // 包裹成 ZodEffects，运行时取 options 要碰私有 _def——文本级更稳）。
    const decisionSource = readFileSync(
      join(import.meta.dir, '../src/modules/development-automation/domain/decision.ts'),
      'utf8',
    )
    const kinds = [...decisionSource.matchAll(/kind: z\.literal\('([^']+)'\)/g)].map((m) => m[1]!)
    expect(kinds.length).toBeGreaterThan(10)
    for (const kind of kinds) {
      // 'merge-request'（MR 名词）与 'ready-to-merge'（readiness 标注，不执行
      // merge）放行；任何「执行 merge/approve/resolve」形态的动词 arm 都不许有。
      expect(kind).not.toMatch(/(?<!ready-to-)merge(?!-request)|approve|resolve/)
    }
    // 全集快照：新增 arm 必须显式修订本断言。
    expect([...kinds].sort()).toMatchSnapshot('rfc310-decision-kinds')

    const capabilities = [
      ...PROGRAM_CAPABILITY_IDS,
      ...ADAPTER_CAPABILITY_IDS,
      ...AGENT_CAPABILITY_IDS,
    ]
    for (const id of capabilities) {
      expect(id).not.toMatch(/merge|approve|resolve/)
    }
  })
})
