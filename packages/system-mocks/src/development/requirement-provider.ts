// RFC-310 —— 自建需求系统 mock（runnable，真 HTTP）。
//
// 模拟一个典型的企业自研需求管理系统：按外部 ID 提供需求元数据 + 多文件
// 材料下载（正文/设计文档/附件），并支持澄清问题回写与答案收取。PR-0 先
// 提供只读取件面 + seed；问答/refresh/故障注入随 PR-3 T36/T38a 扩展。
// 平台侧永远经 IntegrationAdapter 消费它——生产代码 import 本包会被
// dependency-cruiser 的 no-production-to-system-mocks 拦下。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:http'

export interface MockRequirementFile {
  fileId: string
  name: string
  role: 'body' | 'design' | 'attachment'
  mediaType: string
  content: string
}

export interface MockRequirementSeed {
  externalId: string
  revision: string
  title: string
  files: MockRequirementFile[]
}

export interface MockQuestionSetRecord {
  correlationId: string
  externalId: string
  questions: { questionId: string; text: string }[]
  answers: { questionId: string; answer: string }[] | null
  answerRevision: string | null
}

export class RequirementProviderMock {
  readonly #requirements = new Map<string, MockRequirementSeed>()
  readonly #questionSets = new Map<string, MockQuestionSetRecord>()
  #correlationCounter = 0

  seed(requirement: MockRequirementSeed): void {
    this.#requirements.set(requirement.externalId, requirement)
  }

  /** 控制面：给某 correlation 灌答案（原渠道回答的模拟）。 */
  seedAnswers(
    correlationId: string,
    answers: { questionId: string; answer: string }[],
    answerRevision = 'a1',
  ): boolean {
    const record = this.#questionSets.get(correlationId)
    if (record === undefined) return false
    record.answers = answers
    record.answerRevision = answerRevision
    return true
  }

  listQuestionSets(): MockQuestionSetRecord[] {
    return [...this.#questionSets.values()]
  }

  /** 控制面 /reset：回到零 seed 状态（与 suite 其余 mock 的 reset 合同一致）。 */
  reset(): void {
    this.#requirements.clear()
    this.#questionSets.clear()
    this.#correlationCounter = 0
  }

  /**
   * bodyText 由调用方预读传入：suite 网关在 dispatch 前就消费了请求流
   * （journal/fault 需要），provider 内再挂 stream 监听只会永久悬挂——
   * 2026-08-18 suite 集成实测。standalone 入口同样先读后派。
   */
  handle(req: IncomingMessage, res: ServerResponse, pathname: string, bodyText: string): boolean {
    const detail = /^\/requirements\/([^/]+)$/.exec(pathname)
    if (detail !== null) {
      const requirement = this.#requirements.get(decodeURIComponent(detail[1]!))
      if (requirement === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'requirement-not-found' }))
        return true
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          externalId: requirement.externalId,
          revision: requirement.revision,
          title: requirement.title,
          files: requirement.files.map((file) => ({
            fileId: file.fileId,
            name: file.name,
            role: file.role,
            mediaType: file.mediaType,
            bytes: Buffer.byteLength(file.content),
          })),
        }),
      )
      return true
    }
    if (/^\/requirements\/[^/]+\/questions$/.test(pathname) && req.method === 'POST') {
      const externalId = decodeURIComponent(pathname.split('/')[2]!)
      if (!this.#requirements.has(externalId)) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'requirement-not-found' }))
        return true
      }
      this.#correlationCounter += 1
      const correlationId = `corr-${this.#correlationCounter}`
      const body =
        bodyText.length > 0
          ? (JSON.parse(bodyText) as { questions?: MockQuestionSetRecord['questions'] })
          : {}
      this.#questionSets.set(correlationId, {
        correlationId,
        externalId,
        questions: body.questions ?? [],
        answers: null,
        answerRevision: null,
      })
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ correlationId }))
      return true
    }
    const answersMatch = /^\/requirements\/([^/]+)\/questions\/([^/]+)\/answers$/.exec(pathname)
    if (answersMatch !== null) {
      const record = this.#questionSets.get(decodeURIComponent(answersMatch[2]!))
      if (record === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'correlation-not-found' }))
        return true
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          record.answers === null
            ? { complete: false }
            : { complete: true, answerRevision: record.answerRevision, answers: record.answers },
        ),
      )
      return true
    }
    const fileMatch = /^\/requirements\/([^/]+)\/files\/([^/]+)$/.exec(pathname)
    if (fileMatch !== null) {
      const requirement = this.#requirements.get(decodeURIComponent(fileMatch[1]!))
      const file = requirement?.files.find((f) => f.fileId === decodeURIComponent(fileMatch[2]!))
      if (requirement === undefined || file === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'file-not-found' }))
        return true
      }
      res.writeHead(200, { 'content-type': file.mediaType })
      res.end(file.content)
      return true
    }
    return false
  }
}

export interface StartedRequirementProviderMock {
  url: string
  mock: RequirementProviderMock
  close(): Promise<void>
}

/** 独立起一个 requirement provider mock（PR-0 probe 用；suite 集成随 PR-3）。 */
export async function startRequirementProviderMock(): Promise<StartedRequirementProviderMock> {
  const mock = new RequirementProviderMock()
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
