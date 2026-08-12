// RFC-280 T3 — 节点启动验证快照的持久化形状（node_runs.startup_verification_json）。
//
// 三段结构：declared（平台声明注入了什么）× observation（runtime 启动清单实际
// 报告了什么，三态）× verification（差集判定）。前端节点详情用它重建
// 「没声明 / disabled / 声明未加载 / 无法观测」的完整对照；后端 runner 写入。
// 字符串状态值保持 runtime 原文（claude: connected/failed/pending…；opencode:
// connected/disabled/failed/needs_auth/…），不在 schema 层收窄。

import { z } from 'zod'

export const ObservedMcpServerSchema = z.object({
  name: z.string(),
  status: z.string(),
  hint: z.string().optional(),
})
export type ObservedMcpServer = z.infer<typeof ObservedMcpServerSchema>

export const DeclaredInjectionManifestSchema = z.object({
  mcpServers: z.array(z.string()),
  skippedDisabledMcps: z.array(z.string()),
  skills: z.array(z.string()),
  subagents: z.array(z.string()),
  plugins: z.array(z.string()),
  tools: z.array(z.string()).nullable(),
  droppedParams: z.array(z.string()),
  unsupported: z.array(z.string()),
  unobservable: z.array(z.string()),
})
export type DeclaredInjectionManifest = z.infer<typeof DeclaredInjectionManifestSchema>

export const StartupObservationSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('verified'),
    source: z.enum(['claude-init', 'opencode-inventory']),
    mcpServers: z.array(ObservedMcpServerSchema),
    tools: z.array(z.string()).optional(),
    agents: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
  }),
  z.object({ state: z.literal('unavailable'), reason: z.string() }),
  z.object({ state: z.literal('malformed'), reason: z.string() }),
])
export type StartupObservation = z.infer<typeof StartupObservationSchema>

export const StartupVerificationResultSchema = z.object({
  observation: z.enum(['verified', 'unavailable', 'malformed']),
  observationReason: z.string().optional(),
  mcpUnusable: z.array(ObservedMcpServerSchema),
  skillsMissing: z.array(z.string()),
  subagentsMissing: z.array(z.string()),
  toolsMissing: z.array(z.string()),
  pluginsMissing: z.array(z.string()),
})
export type StartupVerificationResult = z.infer<typeof StartupVerificationResultSchema>

export const StartupVerificationRecordSchema = z.object({
  declared: DeclaredInjectionManifestSchema,
  observation: StartupObservationSchema,
  verification: StartupVerificationResultSchema,
  /**
   * RFC-284 T14（D9）—— 子进程退出后有界 drain 超时（descendant 扣管道），
   * 尾部输出丢失：exitCode 可信、证据不完整。可选=向后兼容（旧行无此键）；
   * 仅在真丢失时写 true（无观测宿主的 run 不合成占位 record——设计门裁决）。
   */
  outputTailTruncated: z.boolean().optional(),
})
export type StartupVerificationRecord = z.infer<typeof StartupVerificationRecordSchema>

/** GET /api/tasks/:id/node-runs/:nodeRunId/startup-verification 的响应。 */
export const StartupVerificationResponseSchema = z.union([
  z.object({ available: z.literal(true), record: StartupVerificationRecordSchema }),
  z.object({ available: z.literal(false) }),
])
export type StartupVerificationResponse = z.infer<typeof StartupVerificationResponseSchema>

/** verification 是否携带任何值得用户注意的内容（前端 banner 显隐判据）。 */
export function startupVerificationHasFindings(record: StartupVerificationRecord): boolean {
  const v = record.verification
  // 三轮实现门 P2-B：不计 `pluginsMissing`。verifyStartup 恒返回
  // `pluginsMissing: []`（plugin 键域对不上,改由 `declared.unobservable` 呈现）,
  // 而 banner 也没有 pluginsMissing 渲染行——把它计入 hasFindings 会让「预言 true
  // 但 banner 无行可渲染」成为一处休眠的不一致。保持 hasFindings 的判据与 banner
  // 实际渲染集严格一致（⊇ 关系,不多不少）。
  return (
    v.observation !== 'verified' ||
    v.mcpUnusable.length > 0 ||
    v.skillsMissing.length > 0 ||
    v.subagentsMissing.length > 0 ||
    v.toolsMissing.length > 0 ||
    record.declared.skippedDisabledMcps.length > 0 ||
    record.declared.droppedParams.length > 0 ||
    // RFC-284 T14：尾部输出丢失是独立可见 finding（banner 有对应渲染行——
    // hasFindings 与渲染集的 ⊇ 关系继续成立）。
    record.outputTailTruncated === true ||
    record.declared.unsupported.length > 0 ||
    record.declared.unobservable.length > 0
  )
}
