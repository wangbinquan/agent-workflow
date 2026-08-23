// RFC-310 —— 自建流水线门禁系统 mock（runnable，真 HTTP，流式大日志）。
//
// 模拟企业自研 CI/门禁：按 head 提供多 gate 状态与日志清单，日志用**流式
// 生成器**按需产出（服务端不在内存里拼整串，客户端才能证明自己的峰值内存
// 不随日志总量线性增长——plan T6 的验收就是这条）。PR-6 T70 扩展了
// trigger/rerun 幂等面与 partial/outage/head-race/target-race/retry-response-lost 故障
// 注入；全部行为**确定性**（零随机），同一 seed 序列永远产生同一响应序列。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:http'

export interface MockGateLog {
  logId: string
  /** 生成的日志总字节数（内容确定：按行号循环填充）。 */
  bytes: number
}

export interface MockPipelineGate {
  gateKey: string
  required: boolean
  status: 'queued' | 'running' | 'pass' | 'fail' | 'canceled' | 'skipped'
  runRef: string
  attempt: number
  retryability: 'safe' | 'unsafe' | 'unknown'
  failureCategories: string[]
  logs: MockGateLog[]
}

export interface MockPipelineSeed {
  headSha: string
  targetSha: string
  gates: MockPipelineGate[]
  /** 整站故障：所有请求 503（provider outage 素材）。 */
  outage?: boolean
  /** partial：GET 响应不带 head/target 绑定字段（adapter 只能报 completeness partial）。 */
  partial?: boolean
  /** head race：GET 被读 flipAfterReads 次后响应里的 headSha 翻成 newHeadSha
   *（两次 head fence 的素材——URL 定位不变，内容里的 head 前进了）。 */
  headRace?: { flipAfterReads: number; newHeadSha: string }
  /** target race：GET 被读 flipAfterReads 次后响应里的 targetSha 翻成
   * newTargetSha（source head 不变、目标分支前进的门禁失效素材）。 */
  targetRace?: { flipAfterReads: number; newTargetSha: string }
  /** retry-response-lost：第一次 trigger 成功创建 run 但响应 500；第二次同
   *  idempotencyKey 返回既有 run + adopted:true。 */
  retryResponseLost?: boolean
}

const CHUNK = 64 * 1024

/** 确定性日志块：行号 + 固定 payload，重复到 size。 */
function* logChunks(logId: string, totalBytes: number): Generator<Buffer> {
  let produced = 0
  let line = 0
  let buffer = ''
  while (produced < totalBytes) {
    while (Buffer.byteLength(buffer) < CHUNK && produced + Buffer.byteLength(buffer) < totalBytes) {
      line += 1
      buffer += `${logId} line ${line}: compile unit ok padding-padding-padding-padding\n`
    }
    let chunk = Buffer.from(buffer)
    buffer = ''
    if (produced + chunk.byteLength > totalBytes) {
      chunk = chunk.subarray(0, totalBytes - produced)
    }
    produced += chunk.byteLength
    yield chunk
  }
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
  return true
}

export class PipelineProviderMock {
  readonly #pipelines = new Map<string, MockPipelineSeed>()
  /** GET /pipelines/<head> 的读计数（head/target race 翻转判定）。 */
  readonly #reads = new Map<string, number>()
  /** idempotencyKey → 结算结果（trigger/rerun 幂等表）。 */
  readonly #triggerByKey = new Map<string, { runRef: string; lostOnce: boolean }>()
  readonly #rerunByKey = new Map<string, { runRef: string; attempt: number }>()
  #runSeq = 0

  seed(pipeline: MockPipelineSeed): void {
    this.#pipelines.set(pipeline.headSha, pipeline)
  }

  reset(): void {
    this.#pipelines.clear()
    this.#reads.clear()
    this.#triggerByKey.clear()
    this.#rerunByKey.clear()
    this.#runSeq = 0
  }

  handle(req: IncomingMessage, res: ServerResponse, pathname: string, body = ''): boolean {
    const anyOutage = [...this.#pipelines.values()].some((p) => p.outage === true)
    if (anyOutage && pathname.startsWith('/pipelines/')) {
      return json(res, 503, { error: 'provider-outage' })
    }

    const pipelineMatch = /^\/pipelines\/([0-9a-f]{40})$/.exec(pathname)
    if (pipelineMatch !== null && req.method === 'GET') {
      const headSha = pipelineMatch[1]!
      const pipeline = this.#pipelines.get(headSha)
      if (pipeline === undefined) return json(res, 404, { error: 'pipeline-not-found' })
      const reads = (this.#reads.get(headSha) ?? 0) + 1
      this.#reads.set(headSha, reads)
      const flipped =
        pipeline.headRace !== undefined && reads > pipeline.headRace.flipAfterReads
          ? pipeline.headRace.newHeadSha
          : pipeline.headSha
      const flippedTarget =
        pipeline.targetRace !== undefined && reads > pipeline.targetRace.flipAfterReads
          ? pipeline.targetRace.newTargetSha
          : pipeline.targetSha
      const payload: Record<string, unknown> = {
        gates: pipeline.gates.map((gate) => ({
          gateKey: gate.gateKey,
          required: gate.required,
          status: gate.status,
          runRef: gate.runRef,
          attempt: gate.attempt,
          retryability: gate.retryability,
          failureCategories: gate.failureCategories,
          logs: gate.logs.map((log) => ({ logId: log.logId, bytes: log.bytes })),
        })),
      }
      if (pipeline.partial !== true) {
        // partial 模式：响应不带 head 绑定（adapter 无法证明 head 一致 ⇒
        // completeness='partial'，绝不判 pass）。
        payload.headSha = flipped
        payload.targetSha = flippedTarget
      }
      return json(res, 200, payload)
    }

    const triggerMatch = /^\/pipelines\/([0-9a-f]{40})\/trigger$/.exec(pathname)
    if (triggerMatch !== null && req.method === 'POST') {
      const headSha = triggerMatch[1]!
      const pipeline = this.#pipelines.get(headSha)
      if (pipeline === undefined) return json(res, 404, { error: 'pipeline-not-found' })
      let parsed: { gateKeys?: string[]; idempotencyKey?: string }
      try {
        parsed = JSON.parse(body || '{}') as typeof parsed
      } catch {
        return json(res, 400, { error: 'bad-json' })
      }
      const gateKeys = parsed.gateKeys ?? []
      const key = parsed.idempotencyKey
      if (key === undefined || gateKeys.length === 0) {
        return json(res, 400, { error: 'missing-gateKeys-or-idempotencyKey' })
      }
      const existing = this.#triggerByKey.get(key)
      if (existing !== undefined) {
        // 幂等：同 key 永远同 run；response-lost 后的重试在此 adopt。
        return json(res, 200, {
          receiptRef: `trigger-receipt:${key}`,
          runRef: existing.runRef,
          headSha,
          adopted: true,
        })
      }
      this.#runSeq += 1
      const runRef = `trig-${this.#runSeq}`
      for (const gateKey of gateKeys) {
        const gate = pipeline.gates.find((g) => g.gateKey === gateKey)
        if (gate === undefined) {
          pipeline.gates.push({
            gateKey,
            required: true,
            status: 'queued',
            runRef,
            attempt: 1,
            retryability: 'safe',
            failureCategories: [],
            logs: [],
          })
        }
        // 已有 run 的 gate 不被 trigger 重建（trigger 只服务 missing run）。
      }
      this.#triggerByKey.set(key, { runRef, lostOnce: false })
      if (pipeline.retryResponseLost === true) {
        // run 已创建成功，但响应“丢失”（500）——客户端只能按同 key 重试 adopt。
        this.#triggerByKey.set(key, { runRef, lostOnce: true })
        return json(res, 500, { error: 'response-lost' })
      }
      return json(res, 201, {
        receiptRef: `trigger-receipt:${key}`,
        runRef,
        headSha,
        adopted: false,
      })
    }

    const rerunMatch = /^\/pipelines\/([0-9a-f]{40})\/runs\/([^/]+)\/rerun$/.exec(pathname)
    if (rerunMatch !== null && req.method === 'POST') {
      const headSha = rerunMatch[1]!
      const runRef = decodeURIComponent(rerunMatch[2]!)
      const pipeline = this.#pipelines.get(headSha)
      if (pipeline === undefined) return json(res, 404, { error: 'pipeline-not-found' })
      let parsed: { gateKey?: string; idempotencyKey?: string }
      try {
        parsed = JSON.parse(body || '{}') as typeof parsed
      } catch {
        return json(res, 400, { error: 'bad-json' })
      }
      const { gateKey, idempotencyKey } = parsed
      if (gateKey === undefined || idempotencyKey === undefined) {
        return json(res, 400, { error: 'missing-gateKey-or-idempotencyKey' })
      }
      const cached = this.#rerunByKey.get(idempotencyKey)
      if (cached !== undefined) {
        return json(res, 200, {
          receiptRef: `rerun-receipt:${idempotencyKey}`,
          runRef: cached.runRef,
          attempt: cached.attempt,
          headSha,
        })
      }
      const gate = pipeline.gates.find((g) => g.runRef === runRef && g.gateKey === gateKey)
      if (gate === undefined) return json(res, 404, { error: 'gate-run-not-found' })
      if (gate.status === 'running') return json(res, 409, { error: 'gate-already-running' })
      gate.attempt += 1
      gate.status = 'queued'
      this.#rerunByKey.set(idempotencyKey, { runRef, attempt: gate.attempt })
      return json(res, 201, {
        receiptRef: `rerun-receipt:${idempotencyKey}`,
        runRef,
        attempt: gate.attempt,
        headSha,
      })
    }

    const logMatch = /^\/runs\/([^/]+)\/logs\/([^/]+)$/.exec(pathname)
    if (logMatch !== null) {
      const runRef = decodeURIComponent(logMatch[1]!)
      const logId = decodeURIComponent(logMatch[2]!)
      for (const pipeline of this.#pipelines.values()) {
        for (const gate of pipeline.gates) {
          if (gate.runRef !== runRef) continue
          const log = gate.logs.find((l) => l.logId === logId)
          if (log === undefined) continue
          res.writeHead(200, {
            'content-type': 'text/plain',
            'content-length': String(log.bytes),
          })
          const iterator = logChunks(logId, log.bytes)
          const pump = (): void => {
            for (;;) {
              const next = iterator.next()
              if (next.done === true) {
                res.end()
                return
              }
              if (!res.write(next.value)) {
                res.once('drain', pump)
                return
              }
            }
          }
          pump()
          return true
        }
      }
      return json(res, 404, { error: 'log-not-found' })
    }
    return false
  }
}

export interface StartedPipelineProviderMock {
  url: string
  mock: PipelineProviderMock
  close(): Promise<void>
}

/** 独立起一个 pipeline provider mock（PR-0 probe / 包内合同测试用；suite 集成见 suite.ts）。 */
export async function startPipelineProviderMock(): Promise<StartedPipelineProviderMock> {
  const mock = new PipelineProviderMock()
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (!mock.handle(req, res, pathname, Buffer.concat(chunks).toString('utf8'))) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unknown-route' }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock listen failed')
  return {
    url: `http://127.0.0.1:${address.port}`,
    mock,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}
