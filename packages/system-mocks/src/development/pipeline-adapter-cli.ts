// RFC-310 PR-6 —— 测试用 pipeline-gate adapter（真实外部程序）。
//
// 平台的 adapter runner 以子进程方式执行它：cwd=one-shot sink、env 只有
// PATH/HOME/TMPDIR/AW_ADAPTER_SINK/AW_PIPELINE_*（+ AW_IDEMPOTENCY_KEY）/
// AW_PIPELINE_MOCK_URL。它从 pipeline mock 拉门禁状态并把日志逐个下载进
// sink，最后向 stdout 输出一行 `aw-adapter@1` envelope。
//
// 日志下载统一交给 curl 子进程直接流式落盘。Bun fetch + Bun.write(Response)
// 面对快速生产者的大响应会失去背压并可能永久等待；system-mock E2E 使用 MB
// 级日志锁住这里，生产自建 adapter 也应沿用同一流式策略。
//
// AW_PIPELINE_FIXTURE_JSON：测试后门——部分开发机的安全策略拦「子进程→回环
// HTTP」（dev-gotchas 2026-08-18 条目），backend 集成测试可用本地 fixture
// JSON 替代 mock HTTP（{pipeline: <GET /pipelines 响应形状>, logFiles?:
// {relativePath: content}}），CI 与本机都稳定。
//
// trigger 的 response-lost 语义（design §6.5）：POST 5xx 不能直接判失败——
// run 可能已创建。CLI 按同 idempotencyKey 重试一次；provider 幂等面返回既有
// run + adopted:true，绝不再造第二个 run。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface MockGateWire {
  gateKey: string
  required: boolean
  status: string
  runRef: string
  attempt: number
  retryability: string
  failureCategories: string[]
  logs: { logId: string; bytes: number }[]
}

interface MockPipelineWire {
  headSha?: string
  targetSha?: string
  gates: MockGateWire[]
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

async function fetchToFile(url: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  const process = Bun.spawn({
    cmd: ['curl', '-sS', '--fail', '-o', dest, url],
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const exitCode = await process.exited
  if (exitCode !== 0) {
    throw new Error(
      `log download failed (${exitCode}): ${await new Response(process.stderr).text()}`,
    )
  }
}

async function collectPipeline(headSha: string): Promise<number> {
  const sink = process.env.AW_ADAPTER_SINK
  const mockUrl = process.env.AW_PIPELINE_MOCK_URL
  const fixture = process.env.AW_PIPELINE_FIXTURE_JSON
  const target = process.env.AW_PIPELINE_TARGET ?? ''
  if (!sink || (!mockUrl && !fixture)) {
    console.error('missing AW_ADAPTER_SINK / AW_PIPELINE_MOCK_URL(or FIXTURE)')
    return 2
  }

  let wire: MockPipelineWire
  let logFiles: Record<string, string> | null = null
  if (fixture !== undefined) {
    const parsed = JSON.parse(readFileSync(fixture, 'utf8')) as {
      pipeline: MockPipelineWire
      logFiles?: Record<string, string>
    }
    wire = parsed.pipeline
    logFiles = parsed.logFiles ?? {}
  } else {
    const res = await fetch(`${mockUrl}/pipelines/${headSha}`)
    if (res.status === 404) {
      console.error(`pipeline not found: ${headSha}`)
      return 4
    }
    if (res.status !== 200) {
      console.error(`pipeline fetch failed: ${res.status}`)
      return 5
    }
    wire = (await res.json()) as MockPipelineWire
  }

  const gates: unknown[] = []
  for (const gate of wire.gates) {
    const files: { fileId: string; relativePath: string }[] = []
    for (const log of gate.logs) {
      const relativePath = `logs/${gate.gateKey}/${log.logId}.log`
      if (logFiles !== null) {
        const content = logFiles[relativePath] ?? ''
        const abs = join(sink, relativePath)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content)
      } else {
        await fetchToFile(
          `${mockUrl}/runs/${encodeURIComponent(gate.runRef)}/logs/${encodeURIComponent(log.logId)}`,
          join(sink, relativePath),
        )
      }
      files.push({ fileId: `${gate.gateKey}/${log.logId}`, relativePath })
    }
    gates.push({
      gateKey: gate.gateKey,
      required: gate.required,
      status: gate.status,
      runRef: gate.runRef,
      attempt: gate.attempt,
      finishedAt: gate.status === 'queued' || gate.status === 'running' ? null : isoNow(),
      retryability: gate.retryability,
      failureCategories: gate.failureCategories,
      files,
    })
  }

  // provider 未回 head/target 绑定（partial 模式）⇒ completeness='partial'。
  const bound = typeof wire.headSha === 'string' && wire.headSha.length === 40
  console.log(
    JSON.stringify({
      protocol: 'aw-adapter@1',
      operation: 'pipeline.collect',
      providerKey: 'mock-pipeline',
      providerHeadSha: bound ? wire.headSha : null,
      targetSha: typeof wire.targetSha === 'string' ? wire.targetSha : bound ? target : null,
      completeness: bound ? 'complete' : 'partial',
      gates,
      redaction: 'complete',
    }),
  )
  return 0
}

async function triggerPipeline(headSha: string): Promise<number> {
  const mockUrl = process.env.AW_PIPELINE_MOCK_URL
  const gates = (process.env.AW_PIPELINE_GATES ?? '').split(',').filter((g) => g.length > 0)
  const idempotencyKey = process.env.AW_IDEMPOTENCY_KEY
  if (!mockUrl || !idempotencyKey || gates.length === 0) {
    console.error('missing AW_PIPELINE_MOCK_URL / AW_IDEMPOTENCY_KEY / AW_PIPELINE_GATES')
    return 2
  }
  const post = (): Promise<Response> =>
    fetch(`${mockUrl}/pipelines/${headSha}/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gateKeys: gates, idempotencyKey }),
    })
  let res = await post()
  if (res.status >= 500) {
    // response-lost：run 可能已创建，同 key 重试一次做 adopt 查询。
    res = await post()
  }
  if (res.status !== 200 && res.status !== 201) {
    console.error(`trigger failed: ${res.status}`)
    return 5
  }
  const body = (await res.json()) as {
    receiptRef: string
    runRef: string
    headSha: string
    adopted: boolean
  }
  console.log(
    JSON.stringify({
      protocol: 'aw-adapter@1',
      operation: 'pipeline.trigger',
      providerReceiptRef: body.receiptRef,
      runRef: body.runRef,
      headSha: body.headSha,
      adopted: body.adopted,
    }),
  )
  return 0
}

async function rerunPipeline(runRef: string): Promise<number> {
  const mockUrl = process.env.AW_PIPELINE_MOCK_URL
  const headSha = process.env.AW_PIPELINE_HEAD
  const gateKey = process.env.AW_PIPELINE_GATE
  const idempotencyKey = process.env.AW_IDEMPOTENCY_KEY
  if (!mockUrl || !headSha || !gateKey || !idempotencyKey) {
    console.error(
      'missing AW_PIPELINE_MOCK_URL / AW_PIPELINE_HEAD / AW_PIPELINE_GATE / AW_IDEMPOTENCY_KEY',
    )
    return 2
  }
  const res = await fetch(
    `${mockUrl}/pipelines/${headSha}/runs/${encodeURIComponent(runRef)}/rerun`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gateKey, idempotencyKey }),
    },
  )
  if (res.status === 409) {
    console.error('gate already running')
    return 6
  }
  if (res.status !== 200 && res.status !== 201) {
    console.error(`rerun failed: ${res.status}`)
    return 5
  }
  const body = (await res.json()) as {
    receiptRef: string
    runRef: string
    attempt: number
    headSha: string
  }
  console.log(
    JSON.stringify({
      protocol: 'aw-adapter@1',
      operation: 'pipeline.rerun',
      providerReceiptRef: body.receiptRef,
      runRef: body.runRef,
      attempt: body.attempt,
      headSha: body.headSha,
    }),
  )
  return 0
}

async function main(): Promise<number> {
  const [mode, argument] = process.argv.slice(2)
  const head = argument ?? process.env.AW_PIPELINE_HEAD ?? ''
  if (mode === '--collect-pipeline') return await collectPipeline(head)
  if (mode === '--trigger-pipeline') return await triggerPipeline(head)
  if (mode === '--rerun-pipeline') {
    if (!argument) {
      console.error('missing run ref')
      return 2
    }
    return await rerunPipeline(argument)
  }
  console.error(`unknown mode: ${mode}`)
  return 2
}

process.exit(await main())
