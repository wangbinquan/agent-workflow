// RFC-370 §10 V20 —— fusion 引擎任务的工作区载荷：种子树（技能某一版本的精确字节，可叠一层上轮提案作未提交改动）与
// 收集回来的提案里 agent 的结果清单。
// RFC-560 (RFC-294 S9 step 15): moved here from `public/types.ts` — once the fusion engine task port left the public
// surface, no other context read these shapes; they are Knowledge Evolution's own value types.

/** One file of a skill tree (SKILL.md included), as exact bytes. */
export interface FusionTreeFile {
  readonly path: string
  readonly content: Uint8Array
}

/** The agent's result manifest as the workspace held it. */
export type FusionResultManifestRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-a-file' }
  | { readonly kind: 'file'; readonly text: string }
