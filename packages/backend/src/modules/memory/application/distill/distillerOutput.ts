// RFC-367 —— 蒸馏器输出的解析：从 agent 文本里取出 `candidates` 端口内容。
//
// 为什么单独成文件：这是本 RFC 的**唯一可断言面**（纯函数，零 IO），而它此前藏在
// `memoryDistiller.ts` 里、且失败一律 `log.warn` + 返回 `[]`——于是 2026-09-21 查出的事故
// （连续 10 次蒸馏的候选被静默丢光、最后一条落库候选停在 2026-07-17）在代码层面没有任何
// 可观测出口。现在失败是**判别式返回值**，由调用方决定补问还是判失败。
//
// 输入是**已规范化的 assistant 文本**（`runSystemAgent` 的 `eventText`），不是 stdout：
// 逐行 `driver.parseEvent` 的规范化只有 pump 一个 owner，这里不再做第二遍。

import { extractLastEnvelope, parseEnvelope } from '@/services/envelope'

export interface RawCandidate {
  scopeType: 'agent' | 'workflow' | 'repo' | 'global'
  scopeId: string | null
  title: string
  bodyMd: string
  knownTags?: string[]
  newTags?: string[]
  action: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with'
  referenceMemoryId?: string | null
  sourceRefs?: Array<{ kind: 'clarify' | 'review' | 'feedback'; id: string }>
}

/**
 * 协议层失败的分类。每一档都对应一句**不同的**补问开场白——把它们合并成一句
 * "no envelope found" 正是事故里模型反复改错方向的原因。
 */
export type DistillProtocolFailureCode =
  /** 没有（本 run nonce 的）envelope：含标签名被写残（实测出现过 `<wf-output>` / `<wflow-output>`）。 */
  | 'envelope-missing'
  /** envelope 在，但没有任何 `<port name="candidates">` 元素：JSON 直接躺在 envelope 里（常带 ``` 围栏）。 */
  | 'port-missing'
  /** port 开了但 `</port>` 缺失 / 损坏，框架无法框定内容。 */
  | 'port-malformed'
  /** port 内容不是合法 JSON。 */
  | 'json-malformed'
  /** JSON 合法但 `candidates` 不是数组（含字段缺失）。 */
  | 'candidates-not-array'

export type DistillerOutputParse =
  | { readonly ok: true; readonly candidates: RawCandidate[] }
  | { readonly ok: false; readonly code: DistillProtocolFailureCode; readonly detail?: string }

/**
 * 取最后一个（nonce 匹配的）envelope 里的 `candidates` 端口并 JSON 解析。
 *
 * `{"candidates": []}` 是**成功**路径——"没什么可蒸馏的" 是合法答案，必须与协议失败严格区分，
 * 否则本 RFC 只是把一种静默换成另一种。
 */
export function parseDistillerCandidates(
  eventText: string,
  envelopeNonce?: string,
): DistillerOutputParse {
  const envelope = extractLastEnvelope(eventText, envelopeNonce)
  if (envelope === null) return { ok: false, code: 'envelope-missing' }

  const parsed = parseEnvelope(envelope, ['candidates'], envelopeNonce)
  // 判定序：malformed 先于 missing。`envelope.ts` 在 `</port>` 缺失时把端口放进
  // `malformed` 且**不**放进 `collected`，而 `missingDeclared` 是 "不在 collected 里" 的补集
  // —— 一个没闭合的 port 会同时命中两者。先看 missing 就会对一个确实写了 `<port>` 的回复说
  // "你把 JSON 直接放在 envelope 里了"，又是一次把模型往错方向推。
  if (parsed.malformedPorts.includes('candidates')) {
    return { ok: false, code: 'port-malformed' }
  }
  if (parsed.missingDeclared.includes('candidates')) {
    return { ok: false, code: 'port-missing' }
  }

  const body = (parsed.ports.get('candidates') ?? '').trim()
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch (err) {
    return {
      ok: false,
      code: 'json-malformed',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, code: 'candidates-not-array', detail: 'port content is not a JSON object' }
  }
  const list = (json as { candidates?: unknown }).candidates
  if (!Array.isArray(list)) {
    return {
      ok: false,
      code: 'candidates-not-array',
      detail:
        list === undefined
          ? 'no "candidates" key in the port JSON'
          : 'the "candidates" key is not an array',
    }
  }
  return { ok: true, candidates: list as RawCandidate[] }
}

/**
 * 补问预算用尽（或无会话可续）后抛出的协议失败。调度器不认识这个类型——它只读
 * `message` 写进 `memory_distill_jobs.last_error` 并退避重试；类型存在是为了让编排层
 * 能把「模型格式没写对」与「进程出事」分开处理与断言。
 */
export class DistillerProtocolError extends Error {
  constructor(
    readonly code: DistillProtocolFailureCode,
    readonly roundsTried: number,
    readonly detail?: string,
  ) {
    super(
      `distiller output protocol failure after ${roundsTried} round(s): ${code}${
        detail !== undefined && detail !== '' ? ` (${detail})` : ''
      }`,
    )
    this.name = 'DistillerProtocolError'
  }
}
