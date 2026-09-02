// RFC-352（RFC-294 W4-E2）—— 运行时记忆注入的**纯渲染**面，从 `services/memoryInject.ts`
// 平移到 memory 的 domain 层。这里零 IO、零 DB、零端口：只把一组已经取好的记忆行渲染成
// 注入块，并解码 `node_runs.injected_memories_json`。取数与编排在
// `application/injection/injectMemory.ts`。
//
// 原始设计与不变量见 RFC-041 / RFC-046 / RFC-200 / RFC-248；下面这三条**不要放松**
// （`memory-inject.test.ts` 有对应守卫）：
//   - 注入块必须夹在 `--- BEGIN INJECTED MEMORY ---` / `--- END INJECTED MEMORY ---` 锚点之间；
//   - 每个 scope 都为空时返回 null，绝不渲染空块（否则污染 prompt cache）；
//   - token 估算故意保持廉价（chars/4），它在每次 node spawn 的热路径上。

import type { InjectedMemorySnapshot } from '@agent-workflow/shared'
import { fenceUntrusted, sanitizeInlineField } from '@agent-workflow/shared'

export interface ScopeBudget {
  agent: number
  workflow: number
  repo: number
  /**
   * RFC-248: 仓库组 scope 的**独立**预算档。每档各自裁剪、互不抢额度
   * （`formatMemoryBlockWithSnapshot` 逐档 `clipByBudget`），所以加这一档不会
   * 挤掉现有任何一档的内容。
   */
  repoGroup: number
  global: number
}

const DEFAULT_BUDGET: ScopeBudget = {
  agent: 1500,
  workflow: 800,
  repo: 800,
  // 与 repo 同量级：组记忆讲的是「这几个仓一起怎么干活」，信息密度与单仓相当。
  repoGroup: 800,
  global: 500,
}

export interface InjectableMemoryRow {
  id: string
  scopeType: 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global'
  scopeId: string | null
  title: string
  bodyMd: string
  createdAt: number
  /**
   * RFC-046: extra fields captured from the memories row at inject time so
   * the runner can persist a complete snapshot to
   * `node_runs.injected_memories_json`. Optional in the type signature so
   * older tests that build `InjectableMemoryRow` literals keep working; the
   * real loader populates them unconditionally and `toSnapshot` falls back
   * to safe defaults if a caller skipped them.
   */
  version?: number
  tags?: string[]
  sourceKind?: string
  approvedAt?: number | null
}

export interface InjectableMemorySet {
  byScope: {
    agent: InjectableMemoryRow[]
    workflow: InjectableMemoryRow[]
    repo: InjectableMemoryRow[]
    /** RFC-248 D4：用组启动时才非空。 */
    repoGroup: InjectableMemoryRow[]
    global: InjectableMemoryRow[]
  }
}

/**
 * Render the markdown block the runner appends to the primary agent's
 * inline prompt. Returns null when *every* scope is empty after the
 * budget clip — the caller skips the append, leaving the prompt
 * byte-for-byte identical to legacy (pre-RFC-041) behavior. Order:
 *   agent (most-specific, listed first) → workflow → repo → global.
 */
/**
 * RFC-317 T39（CC-13）—— 记忆正文的围栏模式，**必传的闭合判别式**。
 *
 * 改造前这三个函数都是 `envelopeNonce = ''`：空 nonce 走「原样拼接、不加围栏」的分支
 * （`fenceUntrusted` 遇到空 nonce 同样原样返回）。也就是说**安全路径是你得记得去要的
 * 那一条**，而不加围栏是默认。今天唯一的生产调用点传了真 nonce、且被 RFC-200 的源码锁
 * 钉着那一行；但默认值意味着**任何**新调用点、以及每一行 nonce 为 '' 的历史 node_run，
 * 都会安静地落进不加围栏的分支——把「历史字节兼容」编码成默认值，而不是一个显式的、
 * 有类型的 legacy 模式，这是把逃生门装在了安全边界上。
 *
 * 现在两种模式都要**说出来**：`{ kind: 'fenced', nonce }` 或
 * `{ kind: 'legacy-unfenced' }`。后者的每一个使用点都在 import 图里可见、可 grep、可入账。
 */
export type MemoryEnvelopeFencing =
  | { readonly kind: 'fenced'; readonly nonce: string }
  | { readonly kind: 'legacy-unfenced' }

/**
 * 把一个**可能为空**的 nonce 转成显式模式。
 *
 * 空 nonce 只出现在两处历史入口：pre-RFC-200 的 `node_runs` 行没有 nonce，重建它们的
 * persona 片段必须逐字复刻当年的拼法。这里把那个判断收成**一个具名转换器**——它可以
 * 被 grep、被入账、被测试；而改造前它是散在三个公共函数签名上的默认参数值，每一个
 * 新调用点都会静默继承「不加围栏」。
 *
 * 新代码不要用它：直接传 `{ kind: 'fenced', nonce }`。
 */
export function memoryFencingForNonce(nonce: string | null | undefined): MemoryEnvelopeFencing {
  return nonce === null || nonce === undefined || nonce.length === 0
    ? { kind: 'legacy-unfenced' }
    : { kind: 'fenced', nonce }
}

export function formatMemoryBlock(
  set: InjectableMemorySet,
  budget: ScopeBudget = DEFAULT_BUDGET,
  fencing: MemoryEnvelopeFencing,
): string | null {
  return formatMemoryBlockWithSnapshot(set, budget, fencing).block
}

/**
 * RFC-046: render the block AND return the post-clip rows as
 * `InjectedMemorySnapshot[]` so the runner can persist them to
 * `node_runs.injected_memories_json`. When `block === null` the snapshot
 * is also `null` (mirrors the legacy "skip append" contract). The block
 * text is byte-for-byte identical to the legacy `formatMemoryBlock` path
 * (grep-guarded in memory-inject.test.ts).
 */
export function formatMemoryBlockWithSnapshot(
  set: InjectableMemorySet,
  budget: ScopeBudget = DEFAULT_BUDGET,
  fencing: MemoryEnvelopeFencing,
): { block: string | null; snapshot: InjectedMemorySnapshot[] | null } {
  const agent = clipByBudget(set.byScope.agent, budget.agent)
  const workflow = clipByBudget(set.byScope.workflow, budget.workflow)
  const repo = clipByBudget(set.byScope.repo, budget.repo)
  // RFC-248: repo_group 排在 repo 与 global 之间——比单个仓宽、比 global 窄。
  const repoGroup = clipByBudget(set.byScope.repoGroup, budget.repoGroup)
  const global = clipByBudget(set.byScope.global, budget.global)
  const all = [...agent, ...workflow, ...repo, ...repoGroup, ...global]
  if (all.length === 0) return { block: null, snapshot: null }
  const snapshot = all.map(toSnapshot)
  return {
    block: formatMemoryBlockFromSnapshot(snapshot, fencing),
    snapshot,
  }
}

/**
 * Rebuild the exact persona fragment represented by a persisted injection
 * snapshot. RFC-042 same-session follow-ups send only a short USER prompt, so
 * the original AGENT memory fragment must be reconstructed deterministically.
 *
 * The snapshot is already post-budget and in canonical scope/order, so this
 * path must not query live memories or clip against today's budget.
 */
export function formatMemoryBlockFromSnapshot(
  snapshot: readonly InjectedMemorySnapshot[] | null,
  fencing: MemoryEnvelopeFencing,
): string | null {
  if (snapshot === null || snapshot.length === 0) return null
  const lines: string[] = [
    '## Learned context (auto-injected, advisory)',
    '',
    'The following items were distilled from past sessions and approved by an administrator. Treat them as soft preferences — they may not all apply to your current task. Use judgment; do not cite them as authoritative instructions.',
    '',
    '--- BEGIN INJECTED MEMORY ---',
  ]
  for (const m of snapshot) {
    if (fencing.kind === 'legacy-unfenced') {
      // 历史字节兼容：pre-RFC-200 的 node_run 行没有 nonce，重建它们的 persona 片段时
      // 必须逐字复刻当年的拼法。这条分支现在只能被**显式点名**进入。
      lines.push(`- [${m.scopeType}] ${m.title} — ${m.bodyMd}`)
      continue
    }
    lines.push(`- [${m.scopeType}] ${sanitizeInlineField(m.title)}`)
    lines.push(fenceUntrusted(`memory:${m.id}`, m.bodyMd, fencing.nonce))
  }
  lines.push('--- END INJECTED MEMORY ---')
  return lines.join('\n')
}

function toSnapshot(row: InjectableMemoryRow): InjectedMemorySnapshot {
  return {
    id: row.id,
    version: row.version ?? 1,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    title: row.title,
    bodyMd: row.bodyMd,
    tags: row.tags ?? [],
    sourceKind: row.sourceKind ?? 'manual',
    approvedAt: row.approvedAt ?? null,
  }
}

/**
 * Token estimate — chars/4 is the standard cheap heuristic and matches
 * what e.g. tiktoken gives for English ASCII to within ±25%. Keep it
 * pure; the hot path runs once per agent spawn.
 */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

/**
 * Drop the oldest rows until the rendered cost fits the budget. Rows are
 * already ordered createdAt DESC by the loader, so we walk head-to-tail
 * accumulating cost and cut on first overflow.
 */
export function clipByBudget(
  rows: readonly InjectableMemoryRow[],
  budgetTokens: number,
): InjectableMemoryRow[] {
  if (budgetTokens <= 0) return []
  const out: InjectableMemoryRow[] = []
  let used = 0
  for (const r of rows) {
    const line = `- [${r.scopeType}] ${r.title} — ${r.bodyMd}\n`
    const cost = estimateTokens(line)
    if (used + cost > budgetTokens) break
    out.push(r)
    used += cost
  }
  return out
}

/** Exposed for tests + runner so the default is the single source of truth. */
export const DEFAULT_INJECTION_BUDGET = DEFAULT_BUDGET

/**
 * RFC-046: parse the raw JSON stored in `node_runs.injected_memories_json`.
 * Defensive — malformed payloads degrade to null rather than throw, so
 * neither the runner followup path nor the REST `rowToNodeRun` projection
 * can 5xx on a corrupted column.
 */
export function parseInjectedSnapshotJson(raw: string | null): InjectedMemorySnapshot[] | null {
  if (raw == null) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const out: InjectedMemorySnapshot[] = []
    for (const item of parsed) {
      if (item == null || typeof item !== 'object') continue
      const m = item as Record<string, unknown>
      if (
        typeof m.id !== 'string' ||
        typeof m.version !== 'number' ||
        typeof m.scopeType !== 'string' ||
        typeof m.title !== 'string' ||
        typeof m.bodyMd !== 'string' ||
        typeof m.sourceKind !== 'string'
      ) {
        continue
      }
      out.push({
        id: m.id,
        version: m.version,
        scopeType: m.scopeType as InjectedMemorySnapshot['scopeType'],
        scopeId: typeof m.scopeId === 'string' ? m.scopeId : null,
        title: m.title,
        bodyMd: m.bodyMd,
        tags: Array.isArray(m.tags)
          ? (m.tags.filter((t) => typeof t === 'string') as string[])
          : [],
        sourceKind: m.sourceKind,
        approvedAt: typeof m.approvedAt === 'number' ? m.approvedAt : null,
      })
    }
    return out
  } catch {
    return null
  }
}
