// RFC-271 决策 29 — 引用**解析契约**。
//
// 只统一「引用长什么样」是个空壳（R3/R7 的教训）：运行期的解析带着 authoring 侧
// 没有的属性，不进契约就表达不了 `freezeCallClosure`。
//
// 五属性分两层：
//   域级（静态）  freeze / aclAt          —— 由域声明，同域恒定
//   调用级（动态）purpose / onMissing / failureOwner
//                                        —— 同域不同目的行为不同
//
// 调用级那三条是 R7-P1-5 逼出来的，两个实证：
//   · resolveDependsClosure 默认 missing 硬失败，tolerant UI preview 传
//     allowMissing:true 就静默跳过 —— 一条域级 dangle 表达不了。
//   · scheduler 四处失败归属实测不同：主 agent-single 直接返回
//     agent-identity-missing / agent-not-found；wrapper-fanout 的 inner 在
//     hydration 里**跳过**缺失 ref、shard source 为空时 wrapper 仍**成功**、
//     非空才把 wrapper row 标 failed。
//
// **resolve 不 throw**：直接 throw 会被 runScope 冒泡成任务级 "scheduler error"，
// 把原有的 node/wrapper 级失败归属整个丢掉。各调用点自己把 Result 映射成它原有的
// 错误码与 node_run 归属。

import type { ResourceRefAst } from './ast'

/** 快照语义：解析结果是否在任务生命周期内冻结。 */
export type RefFreeze = 'per-task' | 'none'

/** 可见性判定的时点/主体。call 域是 'launch'（按启动者），保存期是 'save'。 */
export type RefAclAt = 'launch' | 'save' | 'none'

/**
 * 解析目的。同一个 ref、同一个域，行为随目的而变。
 * `export` 是配置包导出（R9-P1-2：它是第六个 exact-target consumer）。
 */
export type RefPurpose = 'dispatch' | 'validate' | 'preview' | 'export'

/** 解析不到时怎么办。 */
export type RefOnMissing =
  /** 硬失败（保存期校验、运行期派发）。 */
  | 'fail'
  /** 静默跳过（tolerant UI preview / wrapper-fanout hydration）。 */
  | 'skip'
  /** 保留为 late-bound，启动时才 fail closed（call 的 name 形态、导出）。 */
  | 'dangle'

/** 失败归属——决定错误最终记到哪一行。 */
export type RefFailureOwner = 'node' | 'wrapper' | 'task' | 'caller'

/** 域级静态属性。 */
export interface RefDomainPolicy {
  readonly freeze: RefFreeze
  readonly aclAt: RefAclAt
}

/** 调用级动态属性。 */
export interface RefCallPolicy {
  readonly purpose: RefPurpose
  readonly onMissing: RefOnMissing
  readonly failureOwner: RefFailureOwner
}

export type RefPolicy = RefDomainPolicy & RefCallPolicy

/**
 * typed Result —— **绝不 throw**。
 *
 * `dangling` 与 `missing` 是**两件事**：前者是「按契约允许解析不到」（call 的
 * name 形态、导出），后者是「本该解析到却没有」。把它们合并会让 AC-7b 的
 * 「零匹配与全不可见逐字节同形」无从表达。
 */
export type RefResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'missing'; readonly ref: ResourceRefAst }
  | { readonly ok: false; readonly reason: 'invisible'; readonly ref: ResourceRefAst }
  | {
      readonly ok: false
      readonly reason: 'ambiguous'
      readonly ref: ResourceRefAst
      readonly candidateCount: number
    }
  | { readonly ok: false; readonly reason: 'dangling'; readonly ref: ResourceRefAst }
  | { readonly ok: false; readonly reason: 'unreadable'; readonly ref: ResourceRefAst }

// （RFC-282 D3：原 `RefResolver<T,Ctx>` 接口对象零实现、零消费——生产采用的是
//  「函数 + RefCallPolicy 实参」形态（services/ref/runtimeRef.ts），接口已删除。）

// --- 各域的静态策略（单一事实源；resolver 实现从这里取，不各写各的） ---

export const REF_DOMAIN_POLICIES = {
  /** 运行期派发：不冻结（每次读当前行），ACL 已在 launch 时定过。 */
  runtime: { freeze: 'none', aclAt: 'none' },
  /** call 目标：启动时冻结一次、按启动者判可见性。 */
  call: { freeze: 'per-task', aclAt: 'launch' },
  /** intent：会话内解析，按会话 owner。 */
  intent: { freeze: 'none', aclAt: 'save' },
  /** 导入选择器：按导入者。 */
  importSelector: { freeze: 'none', aclAt: 'save' },
  /** bundle 内引用：由 provider 解析，ACL 在 provider 侧。 */
  bundle: { freeze: 'none', aclAt: 'save' },
} as const satisfies Record<string, RefDomainPolicy>

// --- 已定案的调用实例（design 里逐字写死的那几个） ---

/** 配置包导出（R10 补齐：v11 只填了 purpose）。 */
export const EXPORT_CALL_POLICY: RefCallPolicy = {
  purpose: 'export',
  // 与 AC-7b 一致：name 域零匹配 / 全不可见都产出逐字节相同的 dangling。
  onMissing: 'dangle',
  // 导出没有 node_run / wrapper，失败由 HTTP 调用方承担。
  failureOwner: 'caller',
}

/** 主派发（agent-single）：缺 ref 就是节点失败。 */
export const DISPATCH_CALL_POLICY: RefCallPolicy = {
  purpose: 'dispatch',
  onMissing: 'fail',
  failureOwner: 'node',
}

/**
 * wrapper-fanout 的 inner hydration：**跳过**缺失 ref，失败归属 wrapper。
 * ⚠️ 与主派发不同——这是实测差异，不是笔误（scheduler 的 hydration 先跳过，
 * shard source 为空时 wrapper 仍成功，非空才标 wrapper failed）。
 */
export const FANOUT_HYDRATE_CALL_POLICY: RefCallPolicy = {
  purpose: 'dispatch',
  onMissing: 'skip',
  failureOwner: 'wrapper',
}

/** 保存期校验：advisory，缺失硬失败但归属调用方（校验结果不是 node_run）。 */
export const VALIDATE_CALL_POLICY: RefCallPolicy = {
  purpose: 'validate',
  onMissing: 'fail',
  failureOwner: 'caller',
}

/** tolerant UI preview：静默跳过（agentDeps 的 allowMissing:true）。 */
export const PREVIEW_CALL_POLICY: RefCallPolicy = {
  purpose: 'preview',
  onMissing: 'skip',
  failureOwner: 'caller',
}
