// RFC-310 T16 —— IntegrationAdapterDefinition 内容合同（design.md §3.3）。
//
// 外部系统程序适配（需求取件/门禁采集/日志分类）的 typed 定义：只产
// facts/evidence，不作业务决策。operations 是 closed union 且必须与 purpose
// 对拍——没有声明的写操作不会因为 executable 实际支持就变得可达；只有
// writeback 没有 answers.collect 的 adapter 不能发布为「原渠道澄清可用」
// （成对约束）。executable/secretProjection 是 daemon 侧高危字段：写它们的
// 命令要求 `scripts:author`（application 层收布尔，路由层判权限点）。

import { z } from 'zod'

import { sha256Hex } from '@/util/hash'

export const DEVELOPMENT_ADAPTER_PURPOSES = [
  'requirement-source',
  'pipeline-gate',
  'pipeline-classifier',
  'approval-gateway',
] as const
export type DevelopmentAdapterPurpose = (typeof DEVELOPMENT_ADAPTER_PURPOSES)[number]

export const DEVELOPMENT_ADAPTER_OPERATIONS = [
  'acquire',
  'questions.writeback',
  'answers.collect',
  'collect',
  'trigger',
  'rerun',
  'classify',
  'submit',
  'lookup-by-idempotency-key',
  'observe',
] as const
export type DevelopmentAdapterOperation = (typeof DEVELOPMENT_ADAPTER_OPERATIONS)[number]

export const developmentAdapterContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.enum(DEVELOPMENT_ADAPTER_PURPOSES),
    operations: z.array(z.enum(DEVELOPMENT_ADAPTER_OPERATIONS)).min(1),
    contractVersion: z.literal(1),
    /** daemon 将执行的外部程序 ref（scripts:author 字段门的对象）。 */
    executableRef: z.string().min(1).max(1024),
    parameterSchemaRef: z.string().min(1).max(1024).nullable(),
    connectionRef: z.string().min(1).max(1024).nullable(),
    /** integration owner 校验过的 secret key 闭集投影；worker 从空环境加它。 */
    secretProjection: z.array(z.string().min(1).max(256)),
    outputBudget: z
      .object({
        maxFiles: z.number().int().min(1).max(10_000),
        maxFileBytes: z
          .number()
          .int()
          .min(1)
          .max(64 * 1024 * 1024 * 1024),
        maxTotalBytes: z
          .number()
          .int()
          .min(1)
          .max(64 * 1024 * 1024 * 1024),
      })
      .strict(),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(30 * 60 * 1000),
  })
  .strict()

export type DevelopmentAdapterContent = z.infer<typeof developmentAdapterContentSchema>

export interface AdapterContractViolation {
  readonly code:
    | 'duplicate-operation'
    | 'missing-required-operation'
    | 'operation-outside-purpose'
    | 'writeback-collect-must-pair'
    | 'duplicate-secret-key'
  readonly detail: string
}

const PURPOSE_OPERATIONS: Record<
  DevelopmentAdapterPurpose,
  {
    required: readonly DevelopmentAdapterOperation[]
    optional: readonly DevelopmentAdapterOperation[]
  }
> = {
  'requirement-source': {
    required: ['acquire'],
    optional: ['questions.writeback', 'answers.collect'],
  },
  'pipeline-gate': { required: ['collect'], optional: ['trigger', 'rerun'] },
  'pipeline-classifier': { required: ['classify'], optional: [] },
  'approval-gateway': {
    required: ['submit', 'lookup-by-idempotency-key', 'observe'],
    optional: [],
  },
}

/** purpose/operations 对拍（design §3.3）：违规清单（空 = 合法）。 */
export function validateAdapterContract(
  content: DevelopmentAdapterContent,
): AdapterContractViolation[] {
  const violations: AdapterContractViolation[] = []
  const seen = new Set<string>()
  for (const op of content.operations) {
    if (seen.has(op)) violations.push({ code: 'duplicate-operation', detail: op })
    seen.add(op)
  }
  const spec = PURPOSE_OPERATIONS[content.purpose]
  for (const required of spec.required) {
    if (!seen.has(required)) {
      violations.push({ code: 'missing-required-operation', detail: required })
    }
  }
  const allowed = new Set([...spec.required, ...spec.optional])
  for (const op of seen) {
    if (!allowed.has(op as DevelopmentAdapterOperation)) {
      violations.push({ code: 'operation-outside-purpose', detail: op })
    }
  }
  const hasWriteback = seen.has('questions.writeback')
  const hasCollect = seen.has('answers.collect')
  if (hasWriteback !== hasCollect) {
    violations.push({
      code: 'writeback-collect-must-pair',
      detail: hasWriteback
        ? 'questions.writeback without answers.collect'
        : 'answers.collect without questions.writeback',
    })
  }
  const secrets = new Set<string>()
  for (const key of content.secretProjection) {
    if (secrets.has(key)) violations.push({ code: 'duplicate-secret-key', detail: key })
    secrets.add(key)
  }
  return violations
}

/** adapter 内容是否含 daemon 高危字段（scripts:author 字段门的判据）。 */
export function requiresScriptsAuthor(content: DevelopmentAdapterContent): boolean {
  return content.executableRef.length > 0 || content.secretProjection.length > 0
}

// 镜像自 modules/development-automation/domain/canonicalJson.ts（RFC-284 镜像桥
// 先例）：integration 不能反向 import development-automation，20 行内自持。
function canonicalStringify(value: unknown): string {
  const encode = (v: unknown): string => {
    if (v === null) return 'null'
    if (typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v)
    if (typeof v === 'string') return JSON.stringify(v)
    if (Array.isArray(v)) return `[${v.map(encode).join(',')}]`
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).filter(
        ([, val]) => val !== undefined,
      )
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${encode(val)}`).join(',')}}`
    }
    throw new Error(`canonicalStringify: unsupported ${typeof v}`)
  }
  return encode(value)
}

export function adapterContentDigest(content: DevelopmentAdapterContent): string {
  return sha256Hex(canonicalStringify(content))
}
