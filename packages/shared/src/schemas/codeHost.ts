// RFC-269 — 代码平台连接（凭据面）的 wire 契约。
//
// token 的三形态沿用仓内既有姿势（RFC-255 / RFC-257）：写入接受明文、存储
// 密封、**读路径只回尾 4 位**。这里定义的是后两者能出现在响应里的形状 ——
// 明文 token 在任何 GET 响应里都没有位置。

import { z } from 'zod'
import { CodeHostProviderSchema } from './webhook'

/** 「测试连接」的四类可区分结果（design D7）。 */
export const CODE_HOST_TEST_CODES = [
  /** 401/403 —— token 错或 scope 不足。 */
  'unauthorized',
  /** 404 —— base URL 指到了非 API 根。 */
  'not-found',
  /** DNS / 连接失败 / 超时。 */
  'unreachable',
  /** 2xx 但响应体不含期望字段 —— 通常是 base URL 指到了反代的登录页。 */
  'bad-response',
] as const
export const CodeHostTestCodeSchema = z.enum(CODE_HOST_TEST_CODES)
export type CodeHostTestCode = z.infer<typeof CodeHostTestCodeSchema>

export const CodeHostTestResultSchema = z.object({
  ok: z.boolean(),
  /** epoch ms。 */
  at: z.number(),
  /** 成功时回显的登录名（GitLab username / GitHub login）。 */
  login: z.string().optional(),
  code: CodeHostTestCodeSchema.optional(),
  /** 面向运维的可读原因；**永不含 token**。 */
  message: z.string().optional(),
})
export type CodeHostTestResult = z.infer<typeof CodeHostTestResultSchema>

/** GET 响应形态。`configured:false` 时其余字段为占位空值。 */
export const CodeHostConnectionWireSchema = z.object({
  provider: CodeHostProviderSchema,
  configured: z.boolean(),
  baseUrl: z.string(),
  /** token 尾 4 位；读路径唯一可见的部分。密封值损坏时为空串。 */
  tokenHint: z.string(),
  updatedAt: z.number().nullable(),
  updatedBy: z.string().nullable(),
  lastTest: CodeHostTestResultSchema.nullable(),
})
export type CodeHostConnectionWire = z.infer<typeof CodeHostConnectionWireSchema>

/**
 * PUT 请求体。
 *
 * **token 省略 = 保留原值**（管理员改 base URL 不必重录 token）。清除整套凭据
 * 走 DELETE，而不是「传空串」—— 一个手滑清空的输入框不该等于删除凭据。
 */
export const UpsertCodeHostConnectionSchema = z
  .object({
    baseUrl: z.string().min(1).max(2048),
    token: z.string().min(1).max(4096).optional(),
  })
  .strict()
export type UpsertCodeHostConnection = z.infer<typeof UpsertCodeHostConnectionSchema>

/**
 * 测试连接请求体。两个字段都可省：省略即用已保存的值，所以「先保存再测」与
 * 「边填边测」两种用法都成立。
 */
export const TestCodeHostConnectionSchema = z
  .object({
    baseUrl: z.string().min(1).max(2048).optional(),
    token: z.string().min(1).max(4096).optional(),
  })
  .strict()
export type TestCodeHostConnection = z.infer<typeof TestCodeHostConnectionSchema>
