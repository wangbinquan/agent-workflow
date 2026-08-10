// RFC-270 §1 — 特权节点的**权限镜头**：脱敏与回填的一对。
//
// 两类节点的内容在这个平台上是特权数据：脚本节点的正文是 daemon 宿主要执行的
// 代码，代码平台调用节点的请求是平台要以管理员 token 发出的东西。RFC-253 /
// RFC-269 已经把「谁能**写**」界定清楚了（`scripts:author` /
// `code-host-calls:author`，门在两个持久化原语上）；本模块把同一条边界原样复制
// 成「谁能**看**」——读出口按镜头遮蔽，写路径在门之前按同一个镜头从库里回填。
//
// 为什么脱敏与回填必须住在同一个文件里：它们共用 §字段清单。清单分家的那天，
// 「遮了没回填」就是静默丢数据，「回填了没遮」就是白遮一场。`shared/tests/
// privileged-node-redaction.test.ts` 里那条「脱敏∘回填后敏感投影不变」的不变式
// 测试是这条约束的守门人。
//
// ⚠ 绝不脱敏枚举字段。`language` / `readonly` / `provider` /
// `request.method` / `allowDestructive` / `timeoutMs` 一律原样透出：把它们脱成
// `'***'` 会让 `ScriptNodeSchema` / `CodeHostCallNodeSchema` 严格解析失败，而
// `workflow.validator.ts` 正是拿这两个 schema 做严格再解析的（脚本 :1180 /
// 代码平台 :1362），于是遮蔽会变成「整份工作流校验不过」。画布卡片也只显示这些
// 结构性字段（语言 / 依赖**个数** / provider / action / method），遮了图就没法读。

import { canonicalJson } from './workflow-canonical'
import { definitionHasScriptNode, serializeScriptSensitiveProjectionV1 } from './scriptNode'
import {
  definitionHasCodeHostCallNode,
  serializeCodeHostSensitiveProjectionV1,
} from './codeHost/authorProjection'
import type { WorkflowDefinition, WorkflowNode } from './schemas/workflow'

/**
 * 每类特权节点是否要对当前观察者遮蔽。`true` = 遮。
 *
 * 由 permissions 推出（后端 `services/privilegedNodeLens.ts`），因此「能写的一定
 * 能看」是构造保证的，不需要额外断言。
 */
export interface PrivilegedNodeLens {
  scripts: boolean
  codeHost: boolean
}

/** 有全部权限、或平台自身搬运已经过门的字节时的镜头：什么都不遮、什么都不填。 */
export const PRIVILEGED_LENS_TRANSPARENT: PrivilegedNodeLens = { scripts: false, codeHost: false }

export function lensIsTransparent(lens: PrivilegedNodeLens): boolean {
  return !lens.scripts && !lens.codeHost
}

/**
 * 脚本节点里 `scripts:author` 治理的**内容**字段。
 *
 * 刻意不含 `language` / `readonly` / `outputs`：前两个是结构字段、
 * `outputs` 是端口名（下游连线按名字引用它，遮了整张图的拓扑就断了）。
 */
export const SCRIPT_REDACTED_FIELDS = ['script', 'env', 'dependencies'] as const

/**
 * 代码平台调用节点里 `code-host-calls:author` 治理的**内容**字段。
 *
 * `request` 整体入列（回填时也整体还原），但脱敏只动 `path` / `body` / `query`
 * 三处值——`method` 是枚举，留着才解析得过，也才画得出卡片上的方法标签。
 * `provider` / `action` 是注册表键，`allowDestructive` / `timeoutMs` 是判据输入，
 * 都不在列：它们对无权限用户可见但不可改，被改了就该原样撞门。
 */
export const CODE_HOST_REDACTED_FIELDS = ['params', 'request'] as const

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 该节点在此镜头下要被治理的字段清单；`null` = 不是特权节点或镜头透明。 */
function redactedFieldsFor(kind: string, lens: PrivilegedNodeLens): readonly string[] | null {
  if (kind === 'script') return lens.scripts ? SCRIPT_REDACTED_FIELDS : null
  if (kind === 'code-host-call') return lens.codeHost ? CODE_HOST_REDACTED_FIELDS : null
  return null
}

/**
 * 键存活、值归零的 map 遮蔽。
 *
 * **必须**用 `Object.fromEntries` 而不是逐键赋值：env 名字文法允许 `__proto__`，
 * 直接赋值会命中遗留的原型 setter 让那个键凭空消失（`intentSecretSlots.ts:172`
 * 已经踩过一次），键一少就等于静默改了工作流形状。
 */
function maskValues(map: Record<string, unknown>, marker: string): Record<string, unknown> {
  return Object.fromEntries(Object.keys(map).map((key) => [key, marker]))
}

function redactScriptNode(
  rec: Record<string, unknown>,
  marker: string,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  let touched = false

  const body = rec.script
  // 空正文保持空：空正文本身是 `script-body-empty` 校验错误，遮蔽既不该制造它
  // 也不该掩盖它。
  if (typeof body === 'string' && body.length > 0 && body !== marker) {
    patch.script = marker
    touched = true
  }

  const env = rec.env
  if (isPlainObject(env) && Object.keys(env).length > 0) {
    patch.env = maskValues(env, marker)
    touched = true
  }

  // 长度保留：画布卡片显示的是依赖**个数**（`ScriptNode.tsx` 经
  // `WorkflowCanvas` 的 `dependencyCount`），遮成空数组会让卡片撒谎。
  const deps = rec.dependencies
  if (Array.isArray(deps) && deps.length > 0) {
    patch.dependencies = deps.map(() => marker)
    touched = true
  }

  return touched ? { ...rec, ...patch } : null
}

function redactCodeHostNode(
  rec: Record<string, unknown>,
  marker: string,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  let touched = false

  // 畸形 `params` 也要遮：保存路径用的是宽松的 `WorkflowNodeSchema`（passthrough），
  // 严格的 `CodeHostCallNodeSchema` 只在校验器里跑，所以库里**可以**存着
  // `params: "字符串"` 这种形状。只处理「plain object」等于对畸形值开了个口子。
  const params = rec.params
  if (params !== undefined) {
    if (isPlainObject(params)) {
      if (Object.keys(params).length > 0) {
        patch.params = maskValues(params, marker)
        touched = true
      }
    } else {
      patch.params = marker
      touched = true
    }
  }

  const request = rec.request
  if (request !== undefined) {
    if (!isPlainObject(request)) {
      // author 门把**整个** `request` 当敏感（`authorProjection.ts` 里是
      // `request: rec.request ?? null`），所以形状不认识时**整体**遮掉，
      // 而不是原样透出 —— fail closed。
      patch.request = marker
      touched = true
    } else {
      const nextRequest: Record<string, unknown> = { ...request }
      let requestTouched = false
      // 非 string 的 `path` 同样遮：`typeof === 'string'` 的判定放过数字 / 对象，
      // 而那些值一样是作者写进去的请求内容。
      if (nextRequest.path !== undefined && nextRequest.path !== '') {
        nextRequest.path = marker
        requestTouched = true
      }
      // 空 body 是合法的（`codeHostJsonBodyIssue` 明确放行），保持空。
      if (nextRequest.body !== undefined && nextRequest.body !== '') {
        nextRequest.body = marker
        requestTouched = true
      }
      const query = nextRequest.query
      if (query !== undefined) {
        if (isPlainObject(query)) {
          if (Object.keys(query).length > 0) {
            nextRequest.query = maskValues(query, marker)
            requestTouched = true
          }
        } else {
          nextRequest.query = marker
          requestTouched = true
        }
      }
      if (requestTouched) {
        patch.request = nextRequest
        touched = true
      }
    }
  }

  return touched ? { ...rec, ...patch } : null
}

/**
 * 按镜头遮蔽一份工作流定义里的特权节点内容。
 *
 * 形参是 `<T>` 而不是 `WorkflowDefinition`：任务快照（`tasks.workflowSnapshot`）
 * 在类型上是 `unknown`，而它恰恰是同一批字节活得最久的那个出口，必须能过同一个
 * 遮蔽器。不像定义的输入原样返回，与 `maskWorkflowScriptEnv` 同款。
 *
 * 镜头透明或没有任何节点被改动时**返回同一个引用**，让调用方的短路判断有效。
 */
export function redactPrivilegedNodes<T>(
  definition: T,
  lens: PrivilegedNodeLens,
  marker: string,
): T {
  if (lensIsTransparent(lens)) return definition
  if (!isPlainObject(definition)) return definition
  const def = definition as Record<string, unknown>
  if (!Array.isArray(def.nodes)) return definition

  let touched = false
  const nodes = def.nodes.map((node) => {
    if (!isPlainObject(node)) return node
    const kind = node.kind
    if (typeof kind !== 'string' || redactedFieldsFor(kind, lens) === null) return node
    const next =
      kind === 'script' ? redactScriptNode(node, marker) : redactCodeHostNode(node, marker)
    if (next === null) return node
    touched = true
    return next
  })
  return touched ? ({ ...def, nodes } as T) : definition
}

/**
 * 保存前的回填：把被遮蔽的字段换回库里的值。
 *
 * **由镜头决定，不由值决定**（RFC-270 AC-8）。绝不去看「客户端发来的是不是
 * `***`」——那会让一个有权限的作者「把脚本正文真的改成 `***`」这个完全合法的
 * 编辑被静默吞掉。镜头为遮 ⇒ 该字段客户端本来就看不见，它发什么都没有意义，
 * 一律以库为准；镜头透明 ⇒ 一个字节都不碰。
 *
 * 只回填**两边都存在**的同 id 同 kind 节点：
 *   · `previous` 里没有的（新增特权节点）不回填 ⇒ 原样撞门；
 *   · `next` 里没有的（删除特权节点）什么都不做 ⇒ 原样撞门。
 * 结构性改动（入边、wrapper 归属）不在回填范围内，同样原样撞门——它们不是被
 * 遮蔽的字段，无权限用户本来就不该改。
 */
export function rehydratePrivilegedNodes(
  next: WorkflowDefinition,
  previous: WorkflowDefinition,
  lens: PrivilegedNodeLens,
): WorkflowDefinition {
  if (lensIsTransparent(lens)) return next
  // 按 id 分桶而不是 `new Map(id → node)`：`WorkflowDefinitionSchema` 的
  // `nodes` 只是 `z.array(...)`，没有 id 唯一性约束，而保存路径不跑校验器 ——
  // 库里**可以**存着两个同 id 的特权节点。折叠成一个的话，回填会把最后那个的
  // 正文灌进每一个同 id 节点，于是敏感投影被我们自己改掉，用户明明一个特权字段
  // 都没碰却吃一个 author-forbidden 403。按出现顺序逐个配对，一一对应。
  const previousById = new Map<string, WorkflowNode[]>()
  for (const node of previous.nodes) {
    const bucket = previousById.get(node.id)
    if (bucket === undefined) previousById.set(node.id, [node])
    else bucket.push(node)
  }
  const consumed = new Map<string, number>()

  let touched = false
  const nodes = next.nodes.map((node) => {
    const fields = redactedFieldsFor(node.kind, lens)
    if (fields === null) return node
    const seen = consumed.get(node.id) ?? 0
    consumed.set(node.id, seen + 1)
    const before = previousById.get(node.id)?.[seen]
    if (before === undefined || before.kind !== node.kind) return node

    const rec = node as unknown as Record<string, unknown>
    const beforeRec = before as unknown as Record<string, unknown>
    const out: Record<string, unknown> = { ...rec }
    let nodeTouched = false
    for (const field of fields) {
      const restored = beforeRec[field]
      if (restored === undefined) {
        // 库里没有该字段：客户端若带了一个，也要删掉才能与库对齐。
        if (field in out) {
          delete out[field]
          nodeTouched = true
        }
        continue
      }
      if (canonicalJson(out[field] ?? null) !== canonicalJson(restored)) nodeTouched = true
      out[field] = restored
    }
    if (!nodeTouched) return node
    touched = true
    return out as unknown as WorkflowNode
  })

  return touched ? { ...next, nodes } : next
}

/**
 * RFC-270（Codex 实现门 P2）—— 这次改动是否触碰了当前观察者管不着的执行面。
 *
 * 前台原本只在 xyflow 的 `draggable` / `deletable` / `isValidConnection` 和
 * palette 上设卡，于是**每一条自定义编辑入口**都是绕过口：EdgeInspector 改端口
 * 名 / 重连 / 删边、Connect Next、ConnectionDialog、右键菜单的删除与
 * wrap / decompose、复制粘贴与「再来一个」。后果都一样 —— 本地做得成、自动保存
 * 时吃一个 403，正是 RFC-270 要消灭的那种体验。
 *
 * 逐个入口补太脆（下一个新入口照样漏），所以判据放在**画布唯一的提交口**上，
 * 并且直接复用两个 author 门的敏感投影：判据与后端**逐字同源**，不可能漂移出
 * 「前台放行、后端 403」或反过来的组合。
 *
 * 返回被触碰的那一类；`null` = 这次改动与特权节点的执行面无关，放行。
 */
export function privilegedProjectionChange(
  previous: WorkflowDefinition,
  next: WorkflowDefinition,
  lens: PrivilegedNodeLens,
): 'script' | 'code-host-call' | null {
  if (lensIsTransparent(lens)) return null
  if (
    lens.scripts &&
    (definitionHasScriptNode(previous) || definitionHasScriptNode(next)) &&
    serializeScriptSensitiveProjectionV1(previous) !== serializeScriptSensitiveProjectionV1(next)
  ) {
    return 'script'
  }
  if (
    lens.codeHost &&
    (definitionHasCodeHostCallNode(previous) || definitionHasCodeHostCallNode(next)) &&
    serializeCodeHostSensitiveProjectionV1(previous) !==
      serializeCodeHostSensitiveProjectionV1(next)
  ) {
    return 'code-host-call'
  }
  return null
}
