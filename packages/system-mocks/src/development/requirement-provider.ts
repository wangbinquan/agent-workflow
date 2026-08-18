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

export class RequirementProviderMock {
  readonly #requirements = new Map<string, MockRequirementSeed>()

  seed(requirement: MockRequirementSeed): void {
    this.#requirements.set(requirement.externalId, requirement)
  }

  handle(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
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
