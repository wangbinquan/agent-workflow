// RFC-353 T5（RFC-294 W4-E3）—— knowledge-evolution 对外的 fusion **类型**合同。
//
// 这些形状此前住在 `modules/memory/public/fusion.ts`，那是 RFC-294 明令的反向：
// design §638 把 fusion aggregate 判给 knowledge-evolution，memory 的禁止清单第一条就写着
// 「fusion engine」。端口住在被消费的那一侧，等于让 memory 替 KE 保管它的聚合契约。
//
// 拆成 `types.ts` / `participants.ts` 两个 **exact** 入口（RFC-317 T24 只允许
// commands/queries/participants/events/operations/types 六个文件名）——原来那个 `fusion.ts`
// 是 memory 的 NON_EXACT_PUBLIC 例外，本刀顺带把那条例外还掉。

// ---------------------------------------------------------------------------
// RFC-370 §10 V20 —— fusion 引擎任务的工作区载荷：种子树（技能某一版本的精确字节，可叠一层上轮
// 提案作未提交改动）与收集回来的提案（相对基线的 diff、agent 的结果清单、编辑后的完整树）。
// ---------------------------------------------------------------------------

/** One file of a skill tree (SKILL.md included), as exact bytes. */
export interface FusionTreeFile {
  readonly path: string
  readonly content: Uint8Array
}

export interface FusionWorkspaceSeed {
  /** Committed as the workspace baseline: the diff the merger approves is measured from it. */
  readonly base: readonly FusionTreeFile[]
  /** Written over the baseline as uncommitted changes (a re-run refines its last attempt). */
  readonly overlay: readonly FusionTreeFile[] | null
}

/** The agent's result manifest as the workspace held it. */
export type FusionResultManifestRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-a-file' }
  | { readonly kind: 'file'; readonly text: string }

export interface FusionEngineTaskResult {
  readonly diff: string
  readonly manifest: FusionResultManifestRead
  readonly files: readonly FusionTreeFile[]
}
