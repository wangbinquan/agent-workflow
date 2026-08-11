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
  return (
    v.observation !== 'verified' ||
    v.mcpUnusable.length > 0 ||
    v.skillsMissing.length > 0 ||
    v.subagentsMissing.length > 0 ||
    v.toolsMissing.length > 0 ||
    v.pluginsMissing.length > 0 ||
    record.declared.skippedDisabledMcps.length > 0 ||
    record.declared.droppedParams.length > 0 ||
    record.declared.unsupported.length > 0 ||
    record.declared.unobservable.length > 0
  )
}
