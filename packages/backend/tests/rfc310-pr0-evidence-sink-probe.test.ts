// RFC-310 PR-0 T6 —— EvidenceSink + runnable provider mock probe。
//
// 证明（pr0-go-no-go.md §C）：C1 大日志经流式 sink 时峰值内存不随总字节
// 线性增长；C2 safe-walk 拒绝 traversal/symlink/非常规文件/超预算；C3
// requirement/pipeline provider mock 是可起的真 HTTP 服务并能产出多文件/
// 流式大响应。内存断言带余量（共享 runner 有噪音）：64MB 日志的 RSS 峰值
// 增幅必须 < 48MB——若它随日志线性，这里会是 64MB+。

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  startPipelineProviderMock,
  type StartedPipelineProviderMock,
} from '@agent-workflow/system-mocks/development/pipeline-provider'
import {
  startRequirementProviderMock,
  type StartedRequirementProviderMock,
} from '@agent-workflow/system-mocks/development/requirement-provider'
import {
  OneShotEvidenceSink,
  safeImportStagedTree,
  type SinkBudget,
} from './helpers/rfc310EvidenceSink'
import { runTestCommand } from './helpers/testCommand'

setDefaultTimeout(90_000)

const BIG_LOG_BYTES = 64 * 1024 * 1024
const HEAD = 'c'.repeat(40)
const BUDGET: SinkBudget = {
  maxFiles: 16,
  maxFileBytes: 128 * 1024 * 1024,
  maxTotalBytes: 192 * 1024 * 1024,
}

let ROOT = ''
let requirementMock: StartedRequirementProviderMock
let pipelineMock: StartedPipelineProviderMock

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), 'rfc310-sink-'))
  requirementMock = await startRequirementProviderMock()
  requirementMock.mock.seed({
    externalId: 'REQ-1042',
    revision: '7',
    title: 'Support retry budget in importer',
    files: [
      {
        fileId: 'body',
        name: 'requirement.md',
        role: 'body',
        mediaType: 'text/markdown',
        content: '# REQ-1042\nDo it.\n',
      },
      {
        fileId: 'design',
        name: 'design.md',
        role: 'design',
        mediaType: 'text/markdown',
        content: '## interface\n',
      },
      {
        fileId: 'cases',
        name: 'cases.csv',
        role: 'attachment',
        mediaType: 'text/csv',
        content: 'id,expect\n1,ok\n',
      },
    ],
  })
  pipelineMock = await startPipelineProviderMock()
  pipelineMock.mock.seed({
    headSha: HEAD,
    targetSha: 'd'.repeat(40),
    gates: [
      {
        gateKey: 'compile',
        required: true,
        status: 'fail',
        runRef: 'run-42',
        attempt: 1,
        retryability: 'unsafe',
        failureCategories: ['compile'],
        logs: [{ logId: 'big', bytes: BIG_LOG_BYTES }],
      },
    ],
  })
})

afterAll(async () => {
  await requirementMock.close()
  await pipelineMock.close()
  rmSync(ROOT, { recursive: true, force: true })
})

describe('rfc310 pr0 evidence sink probe', () => {
  test('C3: requirement mock serves metadata + per-file streams into the sink; import re-hashes', async () => {
    const metaRes = await fetch(`${requirementMock.url}/requirements/REQ-1042`)
    expect(metaRes.status).toBe(200)
    const meta = (await metaRes.json()) as {
      revision: string
      files: { fileId: string; name: string }[]
    }
    expect(meta.revision).toBe('7')
    expect(meta.files).toHaveLength(3)

    const staged = join(ROOT, 'staged-req')
    const sink = new OneShotEvidenceSink(staged, BUDGET)
    for (const file of meta.files) {
      const res = await fetch(`${requirementMock.url}/requirements/REQ-1042/files/${file.fileId}`)
      expect(res.status).toBe(200)
      await sink.addFile(`files/${file.name}`, res.body!)
    }
    const sinkEntries = sink.close()
    expect(sinkEntries).toHaveLength(3)
    await expect(
      sink.addFile(
        'files/late.md',
        (async function* () {
          yield new TextEncoder().encode('late')
        })(),
      ),
    ).rejects.toThrow('closed')

    const imported = safeImportStagedTree(staged, join(ROOT, 'evidence-req'), BUDGET)
    expect(imported.map((e) => e.relativePath)).toEqual([
      'files/cases.csv',
      'files/design.md',
      'files/requirement.md',
    ])
    expect(new Map(imported.map((e) => [e.relativePath, e.sha256]))).toEqual(
      new Map(sinkEntries.map((e) => [e.relativePath, e.sha256])),
    )
  })

  test('C1: streaming a 64MB pipeline log keeps peak RSS growth far below the log size', async () => {
    const pipelineRes = await fetch(`${pipelineMock.url}/pipelines/${HEAD}`)
    expect(pipelineRes.status).toBe(200)

    // RSS 是进程级指标：分片进程里跑了几百个文件后基态/GC 噪音会淹没断言
    //（单跑绿、全量红，2026-08-18 实测），所以在干净子进程里流式消费并测量。
    const staged = join(ROOT, 'staged-pipe')
    const probe = join(import.meta.dir, 'fixtures', 'rfc310-stream-probe.ts')
    const out = await runTestCommand(
      [
        process.execPath,
        probe,
        `${pipelineMock.url}/runs/run-42/logs/big`,
        staged,
        String(BIG_LOG_BYTES),
      ],
      { cwd: import.meta.dir, timeoutMs: 60_000, label: 'rfc310-stream-probe' },
    )
    const result = JSON.parse(out.trim()) as { bytes: number; peakDelta: number }
    expect(result.bytes).toBe(BIG_LOG_BYTES)
    expect(result.peakDelta).toBeLessThan(48 * 1024 * 1024)
  })

  test('C2: sink rejects traversal paths and budget overruns', async () => {
    const sink = new OneShotEvidenceSink(join(ROOT, 'staged-bad'), {
      maxFiles: 2,
      maxFileBytes: 16,
      maxTotalBytes: 24,
    })
    const bytes = (s: string) =>
      (async function* () {
        yield new TextEncoder().encode(s)
      })()
    await expect(sink.addFile('../escape.md', bytes('x'))).rejects.toThrow('traversal')
    await expect(sink.addFile('/abs.md', bytes('x'))).rejects.toThrow('absolute')
    await expect(sink.addFile('a/../b.md', bytes('x'))).rejects.toThrow('traversal')
    await expect(sink.addFile('big.md', bytes('this line is way beyond max'))).rejects.toThrow(
      'file too large',
    )
    await sink.addFile('ok-1.md', bytes('0123456789'))
    await expect(sink.addFile('ok-2.md', bytes('0123456789abcdef'))).rejects.toThrow(
      'total too large',
    )
  })

  // 2026-08-20 实撞的回归：`createWriteStream` 的 open 是异步的，写失败晚于调用点
  // 到达。旧实现只在 'drain' 上等待、且没有 'error' 监听者，于是这种迟到的失败要么
  // 让 addFile 永久挂住，要么变成**进程级**未处理错误——bun 报「Unhandled error
  // between tests」，把整个 shard 判红，指的还是一条早已通过的用例。
  // 这里用「目标路径是一个目录」制造一个确定性的异步 open 失败（EISDIR）。
  test('C2: a late asynchronous stream failure rejects addFile instead of escaping the promise', async () => {
    const staged = join(ROOT, 'staged-late-error')
    mkdirSync(join(staged, 'collides'), { recursive: true })
    const sink = new OneShotEvidenceSink(staged, BUDGET)
    await expect(
      sink.addFile(
        'collides',
        (async function* () {
          yield new TextEncoder().encode('payload')
        })(),
      ),
    ).rejects.toThrow()
    // 失败不占预算：sink 仍能继续收合法文件。
    const ok = await sink.addFile(
      'fine.txt',
      (async function* () {
        yield new TextEncoder().encode('fine')
      })(),
    )
    expect(ok.bytes).toBe(4)
  })

  test.skipIf(process.platform === 'win32')(
    'C2: safe import rejects symlinks and non-regular files in the staged tree',
    async () => {
      const staged = join(ROOT, 'staged-symlink')
      mkdirSync(staged, { recursive: true })
      writeFileSync(join(staged, 'ok.txt'), 'fine\n')
      symlinkSync('/etc/hosts', join(staged, 'sneaky-link'))
      expect(() => safeImportStagedTree(staged, join(ROOT, 'evidence-symlink'), BUDGET)).toThrow(
        'symlink',
      )

      const fifoDir = join(ROOT, 'staged-fifo')
      mkdirSync(fifoDir, { recursive: true })
      const { execFileSync } = await import('node:child_process')
      execFileSync('mkfifo', [join(fifoDir, 'pipe')])
      expect(() => safeImportStagedTree(fifoDir, join(ROOT, 'evidence-fifo'), BUDGET)).toThrow(
        'not a regular file',
      )
    },
  )
})
