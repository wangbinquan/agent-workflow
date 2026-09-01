// RFC-282 A3 (§2.4) — the ONE readable answer to "what happens when a node
// references a DISABLED resource".
//
// v2 stance (决策 4/20 撤回后): this table CHANGES NO VALUES. Today's rules
// stay exactly as they are — plugin hard-fails, MCP is skipped-and-declared,
// agent.enabled is not consulted at all. What the table adds is:
//   1. one place to read the rule AND its why (it used to take reading
//      scheduler + the unified injection layer + the RFC-228 integrity gate
//      side by side to answer the question);
//   2. a compile-time obligation: adding a disableable resource kind without
//      stating its disposition breaks the Record's exhaustiveness (§4.4-3).
//
// The table is an INDEX, not an implementation: `fail-closed`'s sites point at
// the five real emitters; their logic does not move here (moving it would be
// an RFC-228 fence change, which is out of scope — 设计门第二轮).

/**
 * Resource kinds that actually carry an `enabled` column: mcps / plugins ONLY
 * (verify with the rfc284 schema guard test, which reflects over the drizzle
 * tables instead of trusting comments). `skills` has NO such column — a
 * skill's unavailability is RFC-170 quarantine (an integrity fence, not a
 * user switch) and is handled by the injection resolver, not this table.
 * `agents` has NO such column either — RFC-284 T3 (决策 D2, 2026-08-12
 * 审计 N1): the original 'agent' entry here claimed `agents.enabled` existed
 * (citing a schema line that actually belongs to the runtimes table) and the
 * boot self-check reported that false claim to operators — exactly the
 * RFC-280 实现门 P2-D anti-pattern this file warns about for 'skill'.
 * If the product ever adds an agent enable/disable switch, add the column,
 * the consuming semantics, and the entry together in one RFC.
 */
export type DisableableResourceKind = 'mcp' | 'plugin'

export type DisabledDisposition =
  | 'fail-closed' // referencing a disabled row refuses launch/dispatch
  | 'skip-and-declare' // skipped; recorded on the declared manifest, node runs on
  // 'not-modeled' (column exists but nothing consumes it) — zero entries since
  // RFC-284 T3 removed the fabricated 'agent' row; the state stays in the union
  // so a future kind in that situation can be recorded honestly, and the
  // schema guard still forces its column to actually exist.
  | 'not-modeled'

export interface DisabledPolicyEntry {
  readonly disposition: DisabledDisposition
  /** Why THIS disposition — the product reasoning, kept next to the rule. */
  readonly why: string
  /** For 'fail-closed': the real emitters (file anchors, verified by the A2 lock). */
  readonly sites?: readonly string[]
  /** For 'skip-and-declare': which DeclaredManifest face carries the skip. */
  readonly declaredField?: 'skippedDisabledMcps'
}

/** The one spelling of the fail-closed plugin error code. All five emitters
 *  import THIS (B3): the wire bytes are unchanged, but "where does this code
 *  come from" now has exactly one grep-able answer — this table. */
export { PLUGIN_DISABLED_ERROR_CODE } from '@/modules/resource-catalog/public/types'

/** The real `plugin-disabled` emitters (all preserved verbatim — v2 has zero
 *  product behavior change; four upstream launch gates consume them). */
export const PLUGIN_DISABLED_SITES: readonly string[] = [
  'services/workflow.validator.ts',
  'services/agent.ts',
  'modules/resource-catalog/application/agents/agentResourceIntegrity.ts',
  'services/execution/resolveInjection.ts',
]

export const DISABLED_RESOURCE_POLICY: Readonly<
  Record<DisableableResourceKind, DisabledPolicyEntry>
> = {
  plugin: {
    disposition: 'fail-closed',
    why:
      'plugin 影响 runtime 的行为面（工具/钩子），缺失会让 agent 跑出「看似成功但能力不全」' +
      '的结果 ⇒ 5 个产出点 + 4 道上游 launch 门共同保证它到不了执行（RFC-228）。',
    sites: PLUGIN_DISABLED_SITES,
  },
  mcp: {
    disposition: 'skip-and-declare',
    why: 'MCP 缺失只是少一个工具；RFC-280 落差③已裁定为「声明 + 告警」，节点照常运行。',
    declaredField: 'skippedDisabledMcps',
  },
}

/** All kinds whose disposition is real (not-modeled excluded) — the self-check
 *  reports 'not-modeled' entries separately so the gap stays VISIBLE instead
 *  of being buried inside a seemingly-exhaustive table. */
export function notModeledDisabledKinds(): DisableableResourceKind[] {
  return (Object.keys(DISABLED_RESOURCE_POLICY) as DisableableResourceKind[]).filter(
    (kind) => DISABLED_RESOURCE_POLICY[kind].disposition === 'not-modeled',
  )
}
