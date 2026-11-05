// RFC-442 — 协作的三个 services/ 兼容层收口（RFC-294 W4 B / D 第八步）。
//
// 锁四件事：
// ① 位置：`services/taskFeedback`、`services/taskClarifyDirective`、`services/taskQuestionConflicts` 不存在；提问节点判定与
//    冲突码在 collaboration domain，infrastructure 不再定义判定。
// ② 引用：源码里没有任何文件 import 三个旧路径（census 的 AST 提取；别名与相对路径都认，带负对照）。
// ③ 方向：三个路由不 import `services/`，对 collaboration 只经 exact public 入口；两个 domain 文件只依赖共享合同。
// ④ 行为：提问节点为真，非提问节点与坏 JSON 为假；冲突码字面值逐个不变（REST 合同，客户端按字面值匹配）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { CLARIFY_SOURCE_PORT_NAME } from '@agent-workflow/shared'

import { isAskingNodeInSnapshot } from '@/modules/collaboration/public/queries'
import { TASK_QUESTION_CONFLICT } from '@/modules/collaboration/public/types'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const COLLABORATION = join(SRC, 'modules', 'collaboration')

/** 退役的三个路径（相对 `src/`，不带扩展名）。 */
const RETIRED = [
  'services/taskFeedback',
  'services/taskClarifyDirective',
  'services/taskQuestionConflicts',
]

const DOMAIN_FILES = ['domain/clarifyAskingNode.ts', 'domain/taskQuestionConflicts.ts'] as const

const EXACT_PUBLIC = new Set([
  '@/modules/collaboration/public/commands',
  '@/modules/collaboration/public/queries',
  '@/modules/collaboration/public/types',
  '@/modules/collaboration/public/participants',
])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** 文件的全部模块说明符（静态 / 类型 / 动态 import、export-from、require），去重；与 R1 账本同一口径。 */
function specifiersOf(path: string): string[] {
  const rel = relative(REPO_ROOT, path).split('\\').join('/')
  const unit = sourceUnit(rel, readFileSync(path, 'utf8'))
  return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
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

const isRetired = (from: string, specifier: string): boolean =>
  RETIRED.includes(targetOf(from, specifier) ?? '')

describe('RFC-442 —— 位置', () => {
  test('三个 services/ 文件不再存在，domain 文件就位', () => {
    for (const gone of RETIRED) expect(existsSync(join(SRC, `${gone}.ts`)), gone).toBe(false)
    for (const path of DOMAIN_FILES) expect(existsSync(join(COLLABORATION, path)), path).toBe(true)
  })

  test('infrastructure 不再定义提问节点判定', () => {
    const infra = readFileSync(
      join(COLLABORATION, 'infrastructure', 'taskClarifyDirective.ts'),
      'utf8',
    )
    expect(infra).not.toContain('isAskingNodeInSnapshot')
    expect(infra).toContain('export function setNodeClarifyDirective(')
  })
})

describe('RFC-442 —— 引用与方向', () => {
  test('源码里没有文件 import 三个旧路径', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(500)
    const offenders = files.flatMap((path) =>
      specifiersOf(path)
        .filter((specifier) => isRetired(path, specifier))
        .map((specifier) => `${relative(SRC, path)} -> ${specifier}`),
    )
    expect(offenders).toEqual([])
  }, 60_000)

  test('负对照：同一判据认得出别名与相对路径两种写法', () => {
    const probe = join(SRC, 'routes', 'probe.ts')
    expect(isRetired(probe, '@/services/taskFeedback')).toBe(true)
    expect(isRetired(probe, '../services/taskClarifyDirective')).toBe(true)
    expect(
      isRetired(
        join(COLLABORATION, 'infrastructure', 'probe.ts'),
        '@/services/taskQuestionConflicts',
      ),
    ).toBe(true)
    expect(isRetired(probe, '@/modules/collaboration/public/queries')).toBe(false)
    expect(isRetired(probe, '@/services/taskFeedbackIndex')).toBe(false)
  })

  test('三个路由不 import services/，对 collaboration 只经 exact public 入口', () => {
    const offenders: string[] = []
    for (const name of ['taskFeedback', 'taskClarifyDirective', 'taskQuestions']) {
      const path = join(SRC, 'routes', `${name}.ts`)
      const found = specifiersOf(path)
      // 非空对照：三个路由都从 collaboration 取用，一条也提取不到就说明判据失效。
      expect(
        found.some((specifier) => specifier.startsWith('@/modules/collaboration/')),
        name,
      ).toBe(true)
      for (const specifier of found) {
        const target = targetOf(path, specifier) ?? ''
        if (target.startsWith('services/')) offenders.push(`${name} -> ${specifier}`)
        if (target.startsWith('modules/collaboration/') && !EXACT_PUBLIC.has(specifier)) {
          offenders.push(`${name} -> ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('两个 domain 文件只依赖共享合同', () => {
    for (const path of DOMAIN_FILES) {
      const found = specifiersOf(join(COLLABORATION, path))
      expect(
        found.filter((specifier) => specifier !== '@agent-workflow/shared'),
        path,
      ).toEqual([])
    }
  })
})

describe('RFC-442 —— 行为', () => {
  // `asker` 从反问出口连到澄清节点，是提问节点；`plain` 没有这条边。
  const snapshot = JSON.stringify({
    $schema_version: 1,
    nodes: [
      { id: 'asker', kind: 'agent-single', agentName: 'a' },
      { id: 'plain', kind: 'agent-single', agentName: 'b' },
      { id: 'clarify', kind: 'clarify' },
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'asker', portName: CLARIFY_SOURCE_PORT_NAME },
        target: { nodeId: 'clarify', portName: 'questions' },
      },
    ],
  })

  test('提问节点为真；非提问节点、未知节点与坏 JSON 为假', () => {
    expect(isAskingNodeInSnapshot(snapshot, 'asker')).toBe(true)
    expect(isAskingNodeInSnapshot(snapshot, 'plain')).toBe(false)
    expect(isAskingNodeInSnapshot(snapshot, 'missing')).toBe(false)
    expect(isAskingNodeInSnapshot('{not json', 'asker')).toBe(false)
  })

  test('判定与共享合同的 isClarifyAskingNode 一致', async () => {
    const { isClarifyAskingNode } = await import('@agent-workflow/shared')
    const definition = JSON.parse(snapshot) as Parameters<typeof isClarifyAskingNode>[0]
    for (const nodeId of ['asker', 'plain', 'missing']) {
      expect(isAskingNodeInSnapshot(snapshot, nodeId), nodeId).toBe(
        isClarifyAskingNode(definition, nodeId),
      )
    }
  })

  test('冲突码字面值不变（REST 合同）', () => {
    expect(TASK_QUESTION_CONFLICT).toEqual({
      alreadyDispatched: 'task-question-already-dispatched',
      borrowLedgerConflict: 'task-question-borrow-ledger-conflict',
      designerNotReady: 'task-question-designer-not-ready',
      homeMultiBorrow: 'task-question-home-multi-borrow',
      nodeDispatchInFlight: 'task-question-node-dispatch-in-flight',
      notAwaitingConfirm: 'task-question-not-awaiting-confirm',
      notFound: 'task-question-not-found',
      notSealed: 'task-question-not-sealed',
      reassignInvalid: 'task-question-reassign-invalid',
      roundMissing: 'task-question-round-missing',
      roundMultiTarget: 'task-question-round-multi-target',
      snapshotUnparseable: 'task-question-snapshot-unparseable',
      targetChanged: 'task-question-target-changed',
      terminal: 'task-question-terminal',
      unsafeDispatchTarget: 'task-question-unsafe-dispatch-target',
    })
  })
})
