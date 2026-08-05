// RFC-259 — CodeHostAdapter 接口 v2 + provider 注册表（自 gitlabAdapter.ts 迁出，
// dispatcherTypes.ts 下沉同款边界卫生）。RFC-257 的路由层残留了四处 GitLab 专有
// 知识（手挑 x-gitlab-* 头 / UUID 提取 / 事件头 / object_kind 摘要）——v2 把它们
// 全部收进 adapter：路由按 headerAllowlist 构造 HeaderBag、按方法取摘要，零
// provider 分支。verify 扩 rawBody 原始字节（GitHub HMAC 对字节计算；GitLab
// 明文 token 比对忽略之）。
//
// 运行时依赖是单向的：本文件 import 各 adapter 实现组注册表；实现文件只做
// type-only import 本文件（编译期擦除，无 ESM 循环）。
import type { CodeHostEvent, CodeHostProvider } from '@agent-workflow/shared'

import { githubAdapter } from '@/services/webhook/githubAdapter'
import { gitlabAdapter } from '@/services/webhook/gitlabAdapter'

export type HeaderBag = Readonly<Record<string, string | undefined>>

export type NormalizeResult =
  | { ok: true; event: CodeHostEvent }
  | { ok: false; reason: 'unsupported-event' | 'parse-failed'; detail: string }

export interface CodeHostAdapter {
  readonly provider: CodeHostProvider
  /** 路由层按此白名单（全小写）构造 HeaderBag；provider 头知识不出 adapter 文件族。 */
  readonly headerAllowlist: ReadonlyArray<string>
  /** 去重 id 的头名（小写）：x-gitlab-event-uuid / x-github-delivery。头缺失 → 无去重降级（设计门 F-18）。 */
  readonly deliveryIdHeader: string
  /**
   * 原始事件头的头名（小写）：x-gitlab-event / x-github-event。值落
   * webhook_deliveries.gitlab_event_header 审计列（RFC-259 D8 语义泛化为
   * 「provider 原始事件头」）；**replay 用该列的值重建此头**再喂 normalize——
   * GitHub 的事件种类判别在头里不在 body 里，空 HeaderBag 的 replay 会把每条
   * GitHub 投递判成 parse-failed（RFC-259 自查 P0）。
   */
  readonly eventHeader: string
  /** 摘要判别符（webhook_deliveries.object_kind 列）：gitlab=body.object_kind；github=事件头值。 */
  summaryKindOf(headers: HeaderBag, parsed: unknown): string | null
  /** 验签。rawBody = 原始请求字节（RFC-259 D2）。 */
  verify(headers: HeaderBag, rawBody: Uint8Array, secret: string): 'valid' | 'invalid' | 'missing'
  normalize(headers: HeaderBag, body: unknown): NormalizeResult
}

/** replay 的 HeaderBag 重建（webhookDeliveries.ts 消费）：审计列值 → 事件头。 */
export function replayHeaders(
  adapter: CodeHostAdapter,
  eventHeaderValue: string | null,
): HeaderBag {
  return eventHeaderValue === null ? {} : { [adapter.eventHeader]: eventHeaderValue }
}

/**
 * RFC-257 出站回写占位（D1/proposal 非目标）：v1 零实现、零调用。后续回写
 * RFC 在同一 provider 注册表下实装；接口先定义以冻结抽象边界。
 */
export interface CodeHostReportSink {
  postMrComment(ref: { repoPath: string; mrIid: string }, body: string): Promise<void>
  setCommitStatus(
    ref: { repoPath: string; commitSha: string },
    state: string,
    description: string,
  ): Promise<void>
}

/** provider 注册表（路径段 /webhooks/:provider/:urlToken 直接选 adapter）。 */
export const CODE_HOST_ADAPTERS: Readonly<Record<string, CodeHostAdapter>> = {
  gitlab: gitlabAdapter,
  github: githubAdapter,
}
