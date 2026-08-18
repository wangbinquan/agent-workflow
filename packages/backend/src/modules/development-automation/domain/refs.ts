// RFC-310 T3 —— strict opaque refs（design.md §1.4）。
//
// 每类 ref 是 brand 过的 string 包装：wire/JSON 层是 plain string（ULID），
// TS 层靠 unique brand 阻止「随手把任意 string 当 ref 传」。唯一铸造点是
// 各自的 `mint*` / schema；跨 context DTO 只携带这些 ref，绝不携带行对象、
// 路径或 credential（design §1.5）。

import { z } from 'zod'

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

export interface OpaqueRefCodec<Brand extends string> {
  readonly kind: Brand
  readonly schema: z.ZodType<string & { readonly __ref: Brand }>
  mint(value: string): string & { readonly __ref: Brand }
  is(value: string): value is string & { readonly __ref: Brand }
}

function defineUlidRef<const Brand extends string>(kind: Brand): OpaqueRefCodec<Brand> {
  type Ref = string & { readonly __ref: Brand }
  const schema = z
    .string()
    .regex(ULID_RE, `${kind} must be a ULID`)
    .transform((v) => v as Ref) as unknown as z.ZodType<Ref>
  return {
    kind,
    schema,
    mint(value: string): Ref {
      if (!ULID_RE.test(value)) throw new Error(`${kind}: not a ULID: ${value}`)
      return value as Ref
    },
    is(value: string): value is Ref {
      return ULID_RE.test(value)
    },
  }
}

export const developmentMissionRef = defineUlidRef('development-mission-ref')
export const actionRunRef = defineUlidRef('action-run-ref')
export const decisionReceiptRef = defineUlidRef('decision-receipt-ref')
export const requirementBundleRef = defineUlidRef('requirement-bundle-ref')
export const pipelineEvidenceBundleRef = defineUlidRef('pipeline-evidence-bundle-ref')
export const repositoryUploadPlanRef = defineUlidRef('repository-upload-plan-ref')
export const agentExecutionRef = defineUlidRef('agent-execution-ref')
export const workSelectionReceiptRef = defineUlidRef('work-selection-receipt-ref')

export type DevelopmentMissionRef = ReturnType<(typeof developmentMissionRef)['mint']>
export type ActionRunRef = ReturnType<(typeof actionRunRef)['mint']>
export type DecisionReceiptRef = ReturnType<(typeof decisionReceiptRef)['mint']>
export type RequirementBundleRef = ReturnType<(typeof requirementBundleRef)['mint']>
export type PipelineEvidenceBundleRef = ReturnType<(typeof pipelineEvidenceBundleRef)['mint']>
export type RepositoryUploadPlanRef = ReturnType<(typeof repositoryUploadPlanRef)['mint']>
export type AgentExecutionRef = ReturnType<(typeof agentExecutionRef)['mint']>
export type WorkSelectionReceiptRef = ReturnType<(typeof workSelectionReceiptRef)['mint']>

/** revision 附带版本的 mission ref（OCC 用）。 */
export const missionRevisionRefSchema = z
  .object({
    missionId: developmentMissionRef.schema,
    revision: z.number().int().nonnegative(),
  })
  .strict()

export type MissionRevisionRef = z.infer<typeof missionRevisionRefSchema>
