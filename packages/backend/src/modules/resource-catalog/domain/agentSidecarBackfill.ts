// RFC-358 T9（决策 D5 / 行为变更 B-5）—— agent「省略即保留」的 sidecar 判据，一份。
//
// 四个字段在 intent 变更集里是 `.optional()`：省略表示「保持存值」（RFC-348 用户裁决 ①）。
// 此前这条判据在两个 provider 各写了一份，而且**只覆盖了 update**：
//   · SQLite  `legacyIntentApplyResourceParticipants.ts` 的 agent-update 分支
//   · PostgreSQL `postgresqlIntentApplyResourcePorts.ts` 的 `applyAgentPatch`
//
// create 分支两边都没有回填——于是 `applyMode:'copy'`（它把 update 归一成 create）会
// **静默丢掉**这四个字段。挂载 builtin / 他人资源时 copy 是唯一合法模式，所以「复制一个
// builtin agent 再改」必然踩到：副本的分支端口、输出 kind、角色、fanout 重命名全部消失。
//
// 这同时是 RFC-358 draft/apply 口径分叉的根因：draft 期看到的是 `live ⊕ payload`
// （带存值的 outputKinds），apply 期 create 分支拿到的是 payload only，于是同一份草稿
// draft 判绿、apply 判红，错误文案还会误说「引用的资源发生了变化」。

/** 省略即保留的字段集。改这里之前先想清楚：加一个字段就多一处要与意图变更集 schema
 *  （`.optional()` vs `.default([])`）保持同步的地方。 */
export const AGENT_SIDECAR_KEYS = [
  'branchPorts',
  'outputKinds',
  'role',
  'outputWrapperPortNames',
] as const

/**
 * 把 `source` 里的 sidecar 补进 `payload` 中**未显式出现**的键。
 *
 * 显式出现的空值（`[]` / `{}` / `'normal'`）是「清空」，必须原样保留——所以判据是
 * `key in payload`，不是 `payload[key] === undefined`。
 */
export function withAgentSidecarsFrom(
  payload: Readonly<Record<string, unknown>>,
  // 只读那四个键，所以这里要的是「一行 agent 的形状」而不是精确的 `Agent`——两个
  // provider 手里的行类型不同（一个是 Agent，一个是依赖注入的宽记录），收窄到精确
  // 类型只会逼出无谓的强转。
  source: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload }
  for (const key of AGENT_SIDECAR_KEYS) {
    if (!(key in out) && source[key] !== undefined) out[key] = source[key]
  }
  return out
}
