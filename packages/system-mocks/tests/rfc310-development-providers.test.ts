// RFC-310 —— development provider mocks 的包内合同测试。
//
// 锁两个 runnable mock 的 HTTP 合同（backend 侧的流式/safe-walk 防护在
// packages/backend/tests/rfc310-pr0-evidence-sink-probe.test.ts）：元数据形状、
// 逐文件下载、未知资源 404、大日志的 content-length 与真实字节数一致。

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

  test('requirement mock Q&A: writeback creates correlation, answers flow only after seeding', async () => {
    const post = await fetch(`${requirement.url}/requirements/REQ-7/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions: [{ questionId: 'q1', text: 'scope?' }] }),
    })
    expect(post.status).toBe(201)
    const { correlationId } = (await post.json()) as { correlationId: string }
    expect(correlationId.length).toBeGreaterThan(0)

    // 未答：complete=false；未知 correlation：404；未知需求的 writeback：404。
    const pending = (await (
      await fetch(`${requirement.url}/requirements/REQ-7/questions/${correlationId}/answers`)
    ).json()) as { complete: boolean }
    expect(pending.complete).toBe(false)
    expect(
      (await fetch(`${requirement.url}/requirements/REQ-7/questions/none/answers`)).status,
    ).toBe(404)
    expect(
      (
        await fetch(`${requirement.url}/requirements/NOPE/questions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404)

    expect(
      requirement.mock.seedAnswers(correlationId, [{ questionId: 'q1', answer: 'all' }], 'rev-9'),
    ).toBe(true)
    expect(requirement.mock.seedAnswers('missing', [], 'x')).toBe(false)
    const answered = (await (
      await fetch(`${requirement.url}/requirements/REQ-7/questions/${correlationId}/answers`)
    ).json()) as { complete: boolean; answerRevision: string; answers: unknown[] }
    expect(answered).toEqual({
      complete: true,
      answerRevision: 'rev-9',
      answers: [{ questionId: 'q1', answer: 'all' }],
    })
    expect(requirement.mock.listQuestionSets().some((s) => s.correlationId === correlationId)).toBe(
      true,
    )
  })

  test('requirement-adapter-cli end to end: acquire stages files into the sink and prints one envelope line', async () => {
    const sink = mkdtempSync(join(tmpdir(), 'aw-adapter-cli-'))
    try {
      const cli = resolve(import.meta.dir, '..', 'src', 'development', 'requirement-adapter-cli.ts')
      const proc = Bun.spawn({
        cmd: [process.execPath, cli, '--acquire', 'REQ-7'],
        cwd: sink,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          AW_ADAPTER_SINK: sink,
          AW_EXTERNAL_ID: 'REQ-7',
          AW_REQUIREMENT_MOCK_URL: requirement.url,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      expect(exitCode).toBe(0)
      const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
      const envelope = JSON.parse(lines[lines.length - 1]!) as {
        protocol: string
        operation: string
        sourceRevision: string
        files: { relativePath: string; role: string }[]
      }
      expect(envelope.protocol).toBe('aw-adapter@1')
      expect(envelope.operation).toBe('acquire')
      expect(envelope.sourceRevision).toBe('3')
      expect(envelope.files).toEqual([{ relativePath: 'files/body.md', role: 'body' }])
      expect(readFileSync(join(sink, 'files', 'body.md'), 'utf8')).toBe('hello\n')
    } finally {
      rmSync(sink, { recursive: true, force: true })
    }
  })

  test('unknown external id exits 4 (business failure signal for the platform runner)', async () => {
    const sink = mkdtempSync(join(tmpdir(), 'aw-adapter-cli-404-'))
    try {
      const cli = resolve(import.meta.dir, '..', 'src', 'development', 'requirement-adapter-cli.ts')
      const proc = Bun.spawn({
        cmd: [process.execPath, cli, '--acquire', 'DOES-NOT-EXIST'],
        cwd: sink,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          AW_ADAPTER_SINK: sink,
          AW_EXTERNAL_ID: 'DOES-NOT-EXIST',
          AW_REQUIREMENT_MOCK_URL: requirement.url,
        },
        stdout: 'ignore',
        stderr: 'pipe',
      })
      expect(await proc.exited).toBe(4)
    } finally {
      rmSync(sink, { recursive: true, force: true })
    }
  })
})
