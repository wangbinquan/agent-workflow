// RFC-271 决策 29 — 引用**解析契约**。
//
// 只统一「引用长什么样」是个空壳（R3/R7 的教训）：运行期的解析带着 authoring 侧
// 没有的属性，不进契约就表达不了 `freezeCallClosure`。
//
// 调用级三属性 purpose / onMissing / failureOwner 是 R7-P1-5 逼出来的，两个实证：
//   · resolveDependsClosure 默认 missing 硬失败，tolerant UI preview 传
//     allowMissing:true 就静默跳过 —— 一条域级 dangle 表达不了。
//   · scheduler 四处失败归属实测不同：主 agent-single 直接返回
//     agent-identity-missing / agent-not-found；wrapper-fanout 的 inner 在
//     hydration 里**跳过**缺失 ref、shard source 为空时 wrapper 仍**成功**、
//     非空才把 wrapper row 标 failed。
//
// **这些常量是「文档标记」而不是被读取的行为表**（RFC-317 T43 定性）。
// `resolveNodeAgentRef` 拿到 `call` 之后 `void call`——真正的分支在各调用点，
// policy 进签名是为了让「这个调用点用的是哪种归属」在代码里可读、可测：
// `rfc271-ref-contract.test.ts` 用源码层断言锁死哪个调用点配哪条 policy。
// 因此**别按「字段有没有被 deref」来判它死活**——整个对象作为标记被消费，
// 字段是标记的载荷。反过来，一条**任何调用点都不引用**的 policy 就是真死的。
//
// RFC-317 T43 据此删掉了两处零消费者的声明（连一个标记调用点都没有）：
//   · `REF_DOMAIN_POLICIES` / `RefDomainPolicy`（域级 freeze / aclAt）——per-task
//     冻结与 launch 时 ACL 判定确实在生产里存在，但都是各处手写实现、从不查这张表。
//     一张没人查的表不是单一事实源，是**第二份会漂移的真值**。
//   · `EXPORT_CALL_POLICY` 与随之无人可用的 `'export'` purpose。
// 这收缩了 RFC-271 AC-B2e 原文所称的「五属性」——存续语义为调用级三属性。
//
// **resolve 不 throw**：直接 throw 会被 runScope 冒泡成任务级 "scheduler error"，
// 把原有的 node/wrapper 级失败归属整个丢掉。各调用点自己把 Result 映射成它原有的
// 错误码与 node_run 归属。

import type { ResourceRefAst } from './ast'

/**
 * 解析目的。同一个 ref、同一个域，行为随目的而变。
 */
export type RefPurpose = 'dispatch' | 'validate' | 'preview'

/** 解析不到时怎么办。 */
export type RefOnMissing =
  /** 硬失败（保存期校验、运行期派发）。 */
  | 'fail'
  /** 静默跳过（tolerant UI preview / wrapper-fanout hydration）。 */
  | 'skip'
  /** 保留为 late-bound，启动时才 fail closed（call 的 name 形态）。 */
  | 'dangle'

/** 失败归属——决定错误最终记到哪一行。 */
export type RefFailureOwner = 'node' | 'wrapper' | 'task' | 'caller'

/** 调用级动态属性。 */
export interface RefCallPolicy {
  readonly purpose: RefPurpose
  readonly onMissing: RefOnMissing
  readonly failureOwner: RefFailureOwner
}

/**
 * typed Result —— **绝不 throw**。
 *
 * `dangling` 与 `missing` 是**两件事**：前者是「按契约允许解析不到」（call 的
 * name 形态），后者是「本该解析到却没有」。把它们合并会让 AC-7b 的
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

// --- 已定案的调用实例（design 里逐字写死的那几个） ---
//
// 每一条**都必须在某个调用点被当作实参传出去**，否则它就是上面说的那种真死声明。

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
