// RFC-310 T71 —— 证据落盘的 GB 级 soak（默认关闭，nightly 开）。
//
// PR-0 的 C1 用 64MB 证明了「峰值 RSS 不随日志线性增长」。但 64MB 这个尺度
// **证不了它想证的东西**：一个偷偷全缓冲的实现在 64MB 下也只多吃 64MB，仍然
// 落在那条 48MB 阈值附近的噪音里，看起来像通过。真正会把 daemon 打死的是
// CI 里 GB 级的构建日志——而它从没被跑过。
//
// 这条 soak 把同一根探针放大到 GB 级，断言换成**绝对常数上限**：峰值增幅必须
// 落在 128MB 以内，与总字节数无关。2GB 输入配 128MB 上限 = 16 倍差距，任何
// 「按比例吃内存」的实现（哪怕只缓冲 1/8）都过不去；而 64MB 那条只有 0.75 倍
// 差距，压根分辨不出来。这就是它必须存在、且必须在 GB 级的理由。
//
// 默认 skip 的理由是成本而非可靠性：它要下载 2GB、占 2GB 临时磁盘、跑几十秒到
// 几分钟。每次 push 都付这笔钱不值得，所以它由 `RUN_EVIDENCE_SOAK=1` 打开，
// 由 `.github/workflows/evidence-soak-nightly.yml` 每晚跑一次；本地复现：
//   RUN_EVIDENCE_SOAK=1 bun test packages/backend/tests/rfc310-evidence-soak.test.ts
// 换尺寸：`EVIDENCE_SOAK_BYTES=4294967296`（需要至少同等空闲磁盘）。

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  startPipelineProviderMock,
  type StartedPipelineProviderMock,
} from '@agent-workflow/system-mocks/development/pipeline-provider'
import { runTestCommand } from './helpers/testCommand'

const ENABLED = process.env.RUN_EVIDENCE_SOAK === '1'

/** 默认 2GiB：足够让「按比例吃内存」的实现撞穿下面的常数上限。 */
const SOAK_BYTES = Number(process.env.EVIDENCE_SOAK_BYTES ?? String(2 * 1024 * 1024 * 1024))

/**
 * 峰值增幅的**绝对**上限——重点在「绝对」：它不随 SOAK_BYTES 放大。
 * 128MB 给 curl 子进程调度、hash 缓冲与 25ms 采样噪音留足余量，同时对 2GB
 * 输入仍保持 16 倍差距。
 */
const MAX_PEAK_DELTA = 128 * 1024 * 1024

const HEAD = 'e'.repeat(40)

setDefaultTimeout(20 * 60_000)

let ROOT = ''
let pipelineMock: StartedPipelineProviderMock

beforeAll(async () => {
  if (!ENABLED) return
  ROOT = mkdtempSync(join(tmpdir(), 'rfc310-soak-'))
  pipelineMock = await startPipelineProviderMock()
  pipelineMock.mock.seed({
    headSha: HEAD,
    targetSha: 'f'.repeat(40),
    gates: [
      {
        gateKey: 'compile',
        required: true,
        status: 'fail',
        runRef: 'soak-run',
        attempt: 1,
        retryability: 'unsafe',
        failureCategories: ['compile'],
        logs: [{ logId: 'huge', bytes: SOAK_BYTES }],
      },
    ],
  })
})

afterAll(async () => {
  if (!ENABLED) return
  await pipelineMock.close()
  // GB 级临时文件：失败路径也必须清，否则 nightly runner 几轮就把盘塞满。
  rmSync(ROOT, { recursive: true, force: true })
})

describe.skipIf(!ENABLED)('RFC-310 T71 —— GB 级证据落盘 soak', () => {
  test('peak RSS growth stays under a constant bound while streaming a GB-scale log', async () => {
    const staged = join(ROOT, 'staged-soak')
    const probe = join(import.meta.dir, 'fixtures', 'rfc310-stream-probe.ts')
    const out = await runTestCommand(
      [
        process.execPath,
        probe,
        `${pipelineMock.url}/runs/soak-run/logs/huge`,
        staged,
        String(SOAK_BYTES),
      ],
      { cwd: import.meta.dir, timeoutMs: 15 * 60_000, label: 'rfc310-evidence-soak' },
    )
    const result = JSON.parse(out.trim()) as { bytes: number; sha256: string; peakDelta: number }

    // ①字节数精确：流式 hash 不能在 GB 级上少读一截（32 位截断类 bug 就长这样）。
    expect(result.bytes).toBe(SOAK_BYTES)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    // ②落盘的确实是完整文件，而不是「登记了但只写了一半」。
    expect(statSync(join(staged, 'logs', 'compile', 'big.log')).size).toBe(SOAK_BYTES)
    // ③峰值增幅是常数，不随总量走——这条才是 soak 的全部意义。
    expect(result.peakDelta).toBeLessThan(MAX_PEAK_DELTA)
  })
})
