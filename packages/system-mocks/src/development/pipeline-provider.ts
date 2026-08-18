// RFC-310 —— 自建流水线门禁系统 mock（runnable，真 HTTP，流式大日志）。
//
// 模拟企业自研 CI/门禁：按 head 提供多 gate 状态与日志清单，日志用**流式
// 生成器**按需产出（服务端不在内存里拼整串，客户端才能证明自己的峰值内存
// 不随日志总量线性增长——plan T6 的验收就是这条）。trigger/rerun 幂等面与
// partial/outage/head-race 故障注入随 PR-6 T70 扩展。

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

export class PipelineProviderMock {
  readonly #pipelines = new Map<string, MockPipelineSeed>()

  seed(pipeline: MockPipelineSeed): void {
    this.#pipelines.set(pipeline.headSha, pipeline)
  }

  handle(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    const pipelineMatch = /^\/pipelines\/([0-9a-f]{40})$/.exec(pathname)
    if (pipelineMatch !== null) {
      const pipeline = this.#pipelines.get(pipelineMatch[1]!)
      if (pipeline === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'pipeline-not-found' }))
        return true
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          headSha: pipeline.headSha,
          targetSha: pipeline.targetSha,
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
        }),
      )
      return true
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
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'log-not-found' }))
      return true
    }
    return false
  }
}

export interface StartedPipelineProviderMock {
  url: string
  mock: PipelineProviderMock
  close(): Promise<void>
}

/** 独立起一个 pipeline provider mock（PR-0 probe 用；suite 集成随 PR-6）。 */
export async function startPipelineProviderMock(): Promise<StartedPipelineProviderMock> {
  const mock = new PipelineProviderMock()
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (!mock.handle(req, res, pathname)) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown-route' }))
    }
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
