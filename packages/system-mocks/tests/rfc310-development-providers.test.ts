// RFC-310 —— development provider mocks 的包内合同测试。
//
// 锁两个 runnable mock 的 HTTP 合同（backend 侧的流式/safe-walk 防护在
// packages/backend/tests/rfc310-pr0-evidence-sink-probe.test.ts）：元数据形状、
// 逐文件下载、未知资源 404、大日志的 content-length 与真实字节数一致。

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'

import {
  startPipelineProviderMock,
  type StartedPipelineProviderMock,
} from '../src/development/pipeline-provider'
import {
  startRequirementProviderMock,
  type StartedRequirementProviderMock,
} from '../src/development/requirement-provider'

setDefaultTimeout(30_000)

const HEAD = 'e'.repeat(40)
let requirement: StartedRequirementProviderMock
let pipeline: StartedPipelineProviderMock

beforeAll(async () => {
  requirement = await startRequirementProviderMock()
  requirement.mock.seed({
    externalId: 'REQ-7',
    revision: '3',
    title: 'demo',
    files: [
      {
        fileId: 'f1',
        name: 'body.md',
        role: 'body',
        mediaType: 'text/markdown',
        content: 'hello\n',
      },
    ],
  })
  pipeline = await startPipelineProviderMock()
  pipeline.mock.seed({
    headSha: HEAD,
    targetSha: 'f'.repeat(40),
    gates: [
      {
        gateKey: 'unit',
        required: true,
        status: 'pass',
        runRef: 'r1',
        attempt: 1,
        retryability: 'safe',
        failureCategories: [],
        logs: [{ logId: 'l1', bytes: 300_000 }],
      },
    ],
  })
})

afterAll(async () => {
  await requirement.close()
  await pipeline.close()
})

describe('rfc310 development provider mocks', () => {
  test('requirement mock: metadata, file download, 404 on unknown', async () => {
    const meta = (await (await fetch(`${requirement.url}/requirements/REQ-7`)).json()) as {
      revision: string
      files: { fileId: string; bytes: number }[]
    }
    expect(meta.revision).toBe('3')
    expect(meta.files[0]!.bytes).toBe(6)
    const body = await (await fetch(`${requirement.url}/requirements/REQ-7/files/f1`)).text()
    expect(body).toBe('hello\n')
    expect((await fetch(`${requirement.url}/requirements/NOPE`)).status).toBe(404)
    expect((await fetch(`${requirement.url}/requirements/REQ-7/files/nope`)).status).toBe(404)
  })

  test('pipeline mock: gate metadata and log stream length match the seed exactly', async () => {
    const detail = (await (await fetch(`${pipeline.url}/pipelines/${HEAD}`)).json()) as {
      gates: { logs: { logId: string; bytes: number }[] }[]
    }
    expect(detail.gates[0]!.logs[0]!.bytes).toBe(300_000)
    const res = await fetch(`${pipeline.url}/runs/r1/logs/l1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('300000')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes.byteLength).toBe(300_000)
    expect((await fetch(`${pipeline.url}/pipelines/${'0'.repeat(40)}`)).status).toBe(404)
    expect((await fetch(`${pipeline.url}/runs/r1/logs/none`)).status).toBe(404)
  })
})
