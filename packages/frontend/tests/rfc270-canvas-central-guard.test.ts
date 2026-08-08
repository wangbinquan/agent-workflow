// RFC-270（Codex 实现门 P2）—— 画布中央守卫的**基线对齐**性质。
//
// 这道守卫第一次上线就被撤回过一次。撤回当时的判断是错的（用户实报的「移动节点
// 被拦」真凶是 owner 门抛的 `forbidden`，与特权节点无关），但撤回时提出的技术
// 疑虑是成立的、只是没验证过：`applyWorkflowTransition` 处理 `replace-definition`
// 时还会跑 `reconcileRemovalAndReferences` / `applyInputDeclarationSync` /
// `reconcileDerivedPorts`，所以拿**未归一化**的 `definition` 直接对比归一化后的
// `result.next`，会把归一化自己产生的差异算到用户头上。
//
// 本文件锁的就是那条性质：**两端走同一条管线**。实测这套归一化对两个敏感投影是
// 中性且幂等的，但守卫不靠这个实测结论活着 —— 它把基线也过一遍同样的变换，于是
// 「归一化哪天不再中性」也不会变成误拦。下面第一组用例正是那个前提的哨兵：它一旦
// 变红，说明归一化开始动敏感投影了，而守卫因为基线对齐仍然是对的。

import { describe, expect, test } from 'vitest'
import {
  privilegedProjectionChange,
  serializeScriptSensitiveProjectionV1,
  type PrivilegedNodeLens,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { applyWorkflowTransition } from '../src/lib/workflow-transition'
import { createWorkflowSemanticContext } from '../src/lib/workflow-connection-plan'

const NO_SCRIPT_AUTHOR: PrivilegedNodeLens = { scripts: true, codeHost: false }
const ctx = createWorkflowSemanticContext([])

/** 画布提交口做的事：把 next 过一遍变换。 */
const commit = (previous: WorkflowDefinition, next: WorkflowDefinition): WorkflowDefinition =>
  applyWorkflowTransition(previous, { kind: 'replace-definition', next }, ctx).next

/** 守卫的基线：把 previous 也过一遍**同样**的变换。 */
const baselineOf = (previous: WorkflowDefinition): WorkflowDefinition => commit(previous, previous)

/** 归一化重的形状：review 绑定 + output port bind + 缺失的 input 声明。 */
function definition(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'in1', kind: 'input', inputKey: 'ctx', position: { x: 0, y: 0 } },
      { id: 'a1', kind: 'agent-single', agentId: 'AG1', position: { x: 100, y: 0 } },
      {
        id: 's1',
        kind: 'script',
        language: 'python',
        script: '***',
        dependencies: ['***'],
        position: { x: 200, y: 0 },
      },
      {
        id: 'rv',
        kind: 'review',
        position: { x: 300, y: 0 },
        inputSource: { nodeId: 's1', portName: 'stdout' },
      },
      {
        id: 'out1',
        kind: 'output',
        position: { x: 400, y: 0 },
        ports: [{ name: 'r', bind: { nodeId: 's1', portName: 'stdout' } }],
      },
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'in1', portName: 'ctx' },
        target: { nodeId: 'a1', portName: 'ctx' },
      },
      {
        id: 'e2',
        source: { nodeId: 'a1', portName: 'out' },
        target: { nodeId: 's1', portName: 'diff' },
      },
    ],
  } as unknown as WorkflowDefinition
}

function withNodes(
  def: WorkflowDefinition,
  edit: (nodes: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
): WorkflowDefinition {
  const nodes = def.nodes.map((n) => ({ ...(n as unknown as Record<string, unknown>) }))
  return { ...def, nodes: edit(nodes) as unknown as WorkflowDefinition['nodes'] }
}

describe('RFC-270 · 归一化对敏感投影中性（守卫的前提哨兵）', () => {
  test('把定义原样过一遍变换，脚本敏感投影一字不变', () => {
    const def = definition()
    expect(serializeScriptSensitiveProjectionV1(baselineOf(def))).toBe(
      serializeScriptSensitiveProjectionV1(def),
    )
  })

  test('归一化是幂等的（跑两遍与跑一遍同投影）', () => {
    const once = baselineOf(definition())
    expect(serializeScriptSensitiveProjectionV1(baselineOf(once))).toBe(
      serializeScriptSensitiveProjectionV1(once),
    )
  })
})

describe('RFC-270 · 中央守卫：合法编辑一律放行', () => {
  // 这一组是撤回事故的回归锁 —— 它们全都必须放行，拦住任何一条都是把基本操作
  // 弄坏，代价远大于守卫本身的收益。
  const def = definition()
  const guard = (next: WorkflowDefinition) =>
    privilegedProjectionChange(baselineOf(def), commit(def, next), NO_SCRIPT_AUTHOR)

  test('移动**无关**节点 → 放行', () => {
    expect(
      guard(
        withNodes(def, (ns) =>
          ns.map((n) => (n.id === 'a1' ? { ...n, position: { x: 9, y: 9 } } : n)),
        ),
      ),
    ).toBeNull()
  })

  test('移动**脚本节点自己** → 放行（门明确允许挪位置）', () => {
    expect(
      guard(
        withNodes(def, (ns) =>
          ns.map((n) => (n.id === 's1' ? { ...n, position: { x: 7, y: 7 } } : n)),
        ),
      ),
    ).toBeNull()
  })

  test('给脚本节点改标题 → 放行', () => {
    expect(
      guard(withNodes(def, (ns) => ns.map((n) => (n.id === 's1' ? { ...n, title: '打分' } : n)))),
    ).toBeNull()
  })

  test('改无关 agent 节点的引用 → 放行', () => {
    expect(
      guard(withNodes(def, (ns) => ns.map((n) => (n.id === 'a1' ? { ...n, agentId: 'AG2' } : n)))),
    ).toBeNull()
  })

  test('删除一条与脚本无关的边 → 放行', () => {
    expect(guard({ ...def, edges: def.edges.filter((e) => e.id !== 'e1') })).toBeNull()
  })

  test('镜头透明（有权限）时任何改动都放行', () => {
    const removed = withNodes(def, (ns) => ns.filter((n) => n.id !== 's1'))
    expect(
      privilegedProjectionChange(baselineOf(def), commit(def, removed), {
        scripts: false,
        codeHost: false,
      }),
    ).toBeNull()
  })
})

describe('RFC-270 · 中央守卫：越权编辑一律拦下', () => {
  const def = definition()
  const guard = (next: WorkflowDefinition) =>
    privilegedProjectionChange(baselineOf(def), commit(def, next), NO_SCRIPT_AUTHOR)

  test('删除脚本节点（右键菜单 / deleteSelected）→ 拦', () => {
    expect(guard(withNodes(def, (ns) => ns.filter((n) => n.id !== 's1')))).toBe('script')
  })

  test('复制出第二个脚本节点（duplicateNode / paste）→ 拦', () => {
    expect(
      guard(
        withNodes(def, (ns) => [
          ...ns,
          { id: 's2', kind: 'script', language: 'python', script: 'x', position: { x: 0, y: 9 } },
        ]),
      ),
    ).toBe('script')
  })

  test('删掉脚本节点的入边（EdgeInspector 删边）→ 拦', () => {
    expect(guard({ ...def, edges: def.edges.filter((e) => e.id !== 'e2') })).toBe('script')
  })

  test('改脚本节点入边的目标端口名（EdgeInspector 改名）→ 拦', () => {
    const renamed = {
      ...def,
      edges: def.edges.map((e) =>
        e.id === 'e2' ? { ...e, target: { nodeId: 's1', portName: 'renamed' } } : e,
      ),
    } as WorkflowDefinition
    expect(guard(renamed)).toBe('script')
  })

  test('把脚本节点包进 loop（wrapSelection）→ 拦', () => {
    expect(
      guard(
        withNodes(def, (ns) => [
          ...ns,
          { id: 'w1', kind: 'wrapper-loop', nodeIds: ['s1'], maxIterations: 50 },
        ]),
      ),
    ).toBe('script')
  })
})
