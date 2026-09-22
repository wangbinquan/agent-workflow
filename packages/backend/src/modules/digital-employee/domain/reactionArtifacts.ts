// RFC-368 T2 —— Reaction 的 content-addressed 文本产物（重试反馈 / 失败诊断）与裁剪规则。
//
// 今天这两样都是**裸错误串**：`previousError = \`${errorCode}: ${errorDetail}\`` 截断 4000 字符
// （`application/runtimeService.ts:3238`），原样拼进重试提示词，也原样落进 `round.outputJson`
// 与 `blockReason`。里面混着宿主机绝对路径、栈帧、重复行——对 agent 纠错没帮助，却占满上下文。
//
// 裁剪规则（proposal.md §4 C1，用户 2026-09-22 逐条拍板）：
//   R1 errorCode 原样保留——它是判据，不能动。
//   R2 绝对路径改写成工作区相对路径。agent 在自己的 worktree 里，拿到宿主机绝对路径用不了。
//   R3 栈帧行（`    at …`）**整行丢弃**。用户明确裁决并接受其风险：某类失败若只有栈帧能说明
//      问题，这条会丢信息。
//   R4 连续重复行折叠成一行 + `(× N)`。
//   R5 裁剪后仍超 4000 字符则截断（与今天同一个上限）。
//
// 顺序是固定的：R2 → R3 → R4 → 拼 errorCode 前缀 → R5。R2 必须在 R3 之前（栈帧行里也有路径，
// 虽然会被丢掉，但路径改写不依赖行是否保留）；R4 必须在 R3 之后（丢掉栈帧之后才会暴露出
// 真正相邻的重复行）；R5 必须最后（前面每一步都在减长度）。

import { createHash } from 'node:crypto'

export type ReactionArtifactKind = 'retry-feedback' | 'diagnostics'

/** 与今天 `previousError` / `errorDetail` 的上限同值，不是新旋钮。 */
export const REACTION_ARTIFACT_MAX_CHARS = 4_000

export interface SanitizedReactionText {
  readonly body: string
  readonly digest: string
}

/** `    at foo (/path/to/file.ts:1:2)` 这一类。行首允许任意空白，`at` 后必须有内容。 */
const STACK_FRAME_LINE = /^\s*at\s+\S/

function rewriteWorkspacePaths(text: string, workspaceRoot: string | null): string {
  if (workspaceRoot === null || workspaceRoot.length === 0) return text
  // 只改写工作区根**之下**的路径；工作区根自身出现时改写成 `.`，否则会留下空串。
  const escaped = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text
    .replace(new RegExp(`${escaped}[/\\\\]`, 'g'), '')
    .replace(new RegExp(escaped, 'g'), '.')
}

function dropStackFrames(lines: readonly string[]): string[] {
  return lines.filter((line) => !STACK_FRAME_LINE.test(line))
}

function collapseRepeats(lines: readonly string[]): string[] {
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    let repeats = 1
    while (index + repeats < lines.length && lines[index + repeats] === line) repeats += 1
    out.push(repeats > 1 ? `${line} (× ${repeats})` : line)
    index += repeats
  }
  return out
}

/**
 * 把一次失败裁剪成可存档、可拼进提示词的正文，并给出内容地址。
 *
 * `digest` 是**裁剪后正文**的 sha256——内容地址必须对应实际存下去的字节，否则同一条反馈
 * 会因为裁剪前的噪音不同而存成两行（AC-9 的去重就失效了）。
 */
export function sanitizeReactionText(input: {
  readonly errorCode: string
  readonly errorDetail: string
  readonly workspaceRoot: string | null
}): SanitizedReactionText {
  const rewritten = rewriteWorkspacePaths(input.errorDetail, input.workspaceRoot)
  const kept = collapseRepeats(dropStackFrames(rewritten.split('\n')))
  const detail = kept.join('\n').trim()
  const composed = detail.length === 0 ? input.errorCode : `${input.errorCode}: ${detail}`
  const body = composed.slice(0, REACTION_ARTIFACT_MAX_CHARS)
  return { body, digest: createHash('sha256').update(body).digest('hex') }
}

/** 产物 ref 的外部形态。`kind` 进 ref 是为了让一个 ref 自解释它该被谁读。 */
export function reactionArtifactRef(kind: ReactionArtifactKind, digest: string): string {
  return `${kind}:${digest}`
}

export function parseReactionArtifactRef(
  ref: string,
): { readonly kind: ReactionArtifactKind; readonly digest: string } | null {
  const separator = ref.indexOf(':')
  if (separator <= 0) return null
  const kind = ref.slice(0, separator)
  const digest = ref.slice(separator + 1)
  if (kind !== 'retry-feedback' && kind !== 'diagnostics') return null
  if (!/^[a-f0-9]{64}$/.test(digest)) return null
  return { kind, digest }
}
