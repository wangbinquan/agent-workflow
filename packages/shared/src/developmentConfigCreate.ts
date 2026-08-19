// RFC-310 —— 五类数字员工配置资源「新建」的**前后端共用契约**。
//
// 为什么这个文件存在（两次真实事故的共同根因）：
//
//   · `/code/config/adapters` 整页 404 —— 前端把端点前缀写成 `/api/code/...`，
//     真实挂载点是 `/api/integrations/...`；
//   · adapter 建不出来 —— 前端只 POST `{name, purpose}`，后端在 create 期就
//     strict parse 完整内容，回 `Invalid literal value, expected 1`。
//
// 两次都是同一个形态：**前端造载荷、后端校载荷，中间没有任何机械联系**。页面
// 测试 mock 掉 fetch、自己写 URL 与 body，写错了照样绿；后端契约测试自己拼
// 载荷，也照样绿。两边各自绿着，合起来是坏的。
//
// 所以创建载荷不再由页面即兴拼装，而是这里的纯函数产出：前端调它发请求，后端
// 测试调它打真实 app（`tests/rfc310-config-create-contract.test.ts`）。任何一边
// 改了形状而另一边没跟上，那条后端测试立刻红——这就是缺失的那根机械联系。
//
// 零依赖叶子模块：纯数据 + 纯函数，无 fetch / 无 DB / 无 React。

/** 统一列表页承载的四族（automation policy 由 rule builder 单独成页）。 */
export const DEVELOPMENT_CONFIG_KINDS = [
  'employees',
  'action-templates',
  'verification-profiles',
  'adapters',
] as const

export type DevelopmentConfigKind = (typeof DEVELOPMENT_CONFIG_KINDS)[number]

/**
 * 各族 CRUD base（ACL 面同 base + `/:id/acl`）。
 *
 * adapter 是唯一一个**前缀与页面归属不同**的资源：它属 integration bounded
 * context，端点前缀随归属而非随页面（RFC-294）。最容易被下一个人"顺手改成和
 * 其它三个一致"，改了就是整页 404。
 */
export const DEVELOPMENT_CONFIG_API_BASE: Record<DevelopmentConfigKind, string> = {
  employees: '/api/code/digital-employees',
  'action-templates': '/api/code/action-templates',
  'verification-profiles': '/api/code/verification-profiles',
  adapters: '/api/integrations/development-adapters',
}

export const ADAPTER_PURPOSES = [
  'requirement-source',
  'pipeline-gate',
  'pipeline-classifier',
] as const

export type AdapterPurpose = (typeof ADAPTER_PURPOSES)[number]

/**
 * purpose → **必需** operations（后端 `PURPOSE_OPERATIONS[...].required` 的镜像；
 * 可选项在详情页的 JSON 编辑器里加）。
 */
export const ADAPTER_REQUIRED_OPERATIONS: Record<AdapterPurpose, readonly string[]> = {
  'requirement-source': ['acquire'],
  'pipeline-gate': ['collect'],
  'pipeline-classifier': ['classify'],
}

/** 新建 adapter 的最小合法内容里的预算 / 超时缺省（都在 schema 上下界内）。 */
export const ADAPTER_CREATE_DEFAULTS = {
  outputBudget: {
    maxFiles: 200,
    maxFileBytes: 32 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
  },
  timeoutMs: 120_000,
} as const

export interface DevelopmentConfigCreateInput {
  kind: DevelopmentConfigKind
  name: string
  /** action-template 必填：capability 闭集里的一个 id。 */
  capabilityId?: string
  /** adapter 必填：purpose + 可执行引用（占位值等于产出一个说不出话的资源）。 */
  purpose?: AdapterPurpose
  executableRef?: string
}

/**
 * 造出该族 create 端点接受的**最小完整**请求体。
 *
 * 三族（employees / verification-profiles / action-templates）后端允许空草稿
 * 起步——内容在详情页深编；adapter 不允许，它在 create 期就 strict parse
 * （「可执行引用不允许以草稿形态潜伏」），所以必须一次交出完整合法内容。
 */
export function buildDevelopmentConfigCreateBody(
  input: DevelopmentConfigCreateInput,
): Record<string, unknown> {
  const base: Record<string, unknown> = { name: input.name }
  if (input.kind === 'action-templates') {
    return { ...base, capabilityId: input.capabilityId }
  }
  if (input.kind === 'adapters') {
    const purpose = input.purpose ?? ADAPTER_PURPOSES[0]
    return {
      ...base,
      purpose,
      draft: {
        schemaVersion: 1,
        contractVersion: 1,
        purpose,
        operations: ADAPTER_REQUIRED_OPERATIONS[purpose],
        executableRef: (input.executableRef ?? '').trim(),
        parameterSchemaRef: null,
        connectionRef: null,
        secretProjection: [],
        outputBudget: ADAPTER_CREATE_DEFAULTS.outputBudget,
        timeoutMs: ADAPTER_CREATE_DEFAULTS.timeoutMs,
      },
    }
  }
  return base
}
