// RFC-310 PR-6 T63 —— pipeline-gate adapter 执行链（真 CLI 子进程）。
//
// 锁：①collect 经真 adapter CLI 拉 mock provider：gate 状态转述 + 日志落
// sink + head 绑定 → completeness='complete'；②partial provider（无 head
// 绑定）→ completeness='partial'、providerHeadSha=null——fence 永远无法判
// pass；③trigger 幂等/response-lost adopt 语义经 envelope 透传；④rerun
// attempt 递增；⑤运行时成对约束：未声明的 operation 拒（operation-not-
// declared）、purpose 错拒（adapter-purpose-mismatch）——没有声明的写操作
// 不因 executable 支持而可达；⑥AW_PIPELINE_FIXTURE_JSON 后门（部分开发机拦
// 「子进程→回环 HTTP」，见 dev-gotchas 2026-08-18 条）本地 fixture 可跑通
// 同一 envelope 合同。
// CLI 子进程连 startPipelineProviderMock 的形态与 PR-3 requirement CLI E2E
// 同款（本机与 CI 均实测可达；主 session 踩的坑仅限 suite gateway 形态）。

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  startPipelineProviderMock,
  type StartedPipelineProviderMock,
} from '@agent-workflow/system-mocks'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createDevelopmentAdapter,
  publishDevelopmentAdapter,
} from '../src/modules/integration/application/developmentAdapterCommands'
import { createPipelineEvidenceAdapter } from '../src/modules/integration/infrastructure/developmentPipelineAdapter'
import { createDbAdapterBindingResolver } from '../src/modules/integration/infrastructure/developmentRequirementSourceAdapter'
import { createSqliteDevelopmentAdapterStore } from '../src/modules/integration/infrastructure/sqliteDevelopmentAdapterStore'
import type { DevelopmentAdapterOperation } from '../src/modules/integration/domain/developmentAdapterDefinition'

setDefaultTimeout(120_000)

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const PIPELINE_CLI = Bun.resolveSync(
  '@agent-workflow/system-mocks/development/pipeline-adapter-cli',
  import.meta.dir,
)

const HEAD = 'a1'.repeat(20)
const TARGET = 'b2'.repeat(20)

let provider: StartedPipelineProviderMock
let db: DbClient

function publishAdapter(input: {
  readonly name: string
  readonly purpose: 'pipeline-gate' | 'requirement-source'
  readonly operations: readonly DevelopmentAdapterOperation[]
}): string {
  const store = createSqliteDevelopmentAdapterStore(db)
  const created = createDevelopmentAdapter(
    store,
    { userId: 'admin', actorHasScriptsAuthor: true },
    {
      name: input.name,
      now: Date.now(),
      content: {
        schemaVersion: 1,
        purpose: input.purpose,
        operations: [...input.operations],
        contractVersion: 1,
        executableRef: PIPELINE_CLI,
        parameterSchemaRef: null,
        connectionRef: null,
        secretProjection: [],
        outputBudget: {
          maxFiles: 64,
          maxFileBytes: 8 * 1024 * 1024,
          maxTotalBytes: 32 * 1024 * 1024,
        },
        timeoutMs: 30_000,
      },
    },
  )
  const published = publishDevelopmentAdapter(
    store,
    { userId: 'admin', actorHasScriptsAuthor: true },
    { id: created.id, now: Date.now() },
  )
  return `${created.id}@${published.revision}`
}

function runner(): ReturnType<typeof createPipelineEvidenceAdapter> {
  const store = createSqliteDevelopmentAdapterStore(db)
  return createPipelineEvidenceAdapter({
    resolveBinding: createDbAdapterBindingResolver((id, revision) =>
      store.getRevision(id, revision),
    ),
    extraEnv: { AW_PIPELINE_MOCK_URL: provider.url },
  })
}

beforeAll(async () => {
  provider = await startPipelineProviderMock()
  db = createInMemoryDb(MIGRATIONS)
})

afterAll(async () => {
  await provider.close()
  db.$client.close()
})

describe('rfc310 pr6 T63 — pipeline adapter execution chain', () => {
  test('collect stages logs into the sink and reports head-bound complete gates', async () => {
    provider.mock.seed({
      headSha: HEAD,
      targetSha: TARGET,
      gates: [
        {
          gateKey: 'unit',
          required: true,
          status: 'fail',
          runRef: 'run-1',
          attempt: 1,
          retryability: 'safe',
          failureCategories: ['unit-test'],
          logs: [{ logId: 'l1', bytes: 5_000 }],
        },
      ],
    })
    const binding = publishAdapter({
      name: 'pg-full',
      purpose: 'pipeline-gate',
      operations: ['collect', 'trigger', 'rerun'],
    })
    const sink = mkdtempSync(join(tmpdir(), 'rfc310-pr6-sink-'))
    const out = await runner().collect({
      adapterBindingRef: binding,
      headSha: HEAD,
      targetSha: TARGET,
      gateKeys: ['unit'],
      sinkPath: sink,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.envelope.completeness).toBe('complete')
    expect(out.envelope.providerHeadSha).toBe(HEAD)
    expect(out.envelope.gates[0]).toMatchObject({
      gateKey: 'unit',
      status: 'fail',
      failureCategories: ['unit-test'],
    })
    const logFile = join(sink, 'logs', 'unit', 'l1.log')
    expect(existsSync(logFile)).toBe(true)
    expect(readFileSync(logFile, 'utf8').length).toBe(5_000)
    expect(out.outputBudget).toMatchObject({ maxFiles: 64 })

    // trigger：新建 run；同 key 二次 adopt。
    const t1 = await runner().trigger({
      adapterBindingRef: binding,
      headSha: HEAD,
      gateKeys: ['deploy-check'],
      idempotencyKey: 'trig-a',
      sinkPath: mkdtempSync(join(tmpdir(), 'rfc310-pr6-sink-')),
    })
    expect(t1.ok).toBe(true)
    if (!t1.ok) return
    expect(t1.envelope.adopted).toBe(false)
    const t2 = await runner().trigger({
      adapterBindingRef: binding,
      headSha: HEAD,
      gateKeys: ['deploy-check'],
      idempotencyKey: 'trig-a',
      sinkPath: mkdtempSync(join(tmpdir(), 'rfc310-pr6-sink-')),
    })
    expect(t2.ok).toBe(true)
    if (!t2.ok) return
    expect(t2.envelope.adopted).toBe(true)
    expect(t2.envelope.runRef).toBe(t1.envelope.runRef)

    // rerun：attempt 递增，receipt 绑定 exact head。
    const r1 = await runner().rerun({
      adapterBindingRef: binding,
      runRef: 'run-1',
      gateKey: 'unit',
      headSha: HEAD,
      idempotencyKey: 'rerun-a',
      sinkPath: mkdtempSync(join(tmpdir(), 'rfc310-pr6-sink-')),
    })
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(r1.envelope.attempt).toBe(2)
    expect(r1.envelope.headSha).toBe(HEAD)
  })

  test('partial provider (no head binding) yields completeness=partial with null head', async () => {
    const head = 'c3'.repeat(20)
    provider.mock.seed({
      headSha: head,
      targetSha: TARGET,
      gates: [
        {
          gateKey: 'unit',
          required: true,
          status: 'pass',
          runRef: 'p-run',
          attempt: 1,
          retryability: 'safe',
          failureCategories: [],
          logs: [],
        },
      ],
      partial: true,
    })
    const binding = publishAdapter({
      name: 'pg-partial',
      purpose: 'pipeline-gate',
      operations: ['collect'],
    })
    const out = await runner().collect({
      adapterBindingRef: binding,
      headSha: head,
      targetSha: TARGET,
      gateKeys: ['unit'],
      sinkPath: mkdtempSync(join(tmpdir(), 'rfc310-pr6-sink-')),
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.envelope.completeness).toBe('partial')
    expect(out.envelope.providerHeadSha).toBeNull()
  })

  test('paired-constraint runtime half: undeclared operation and wrong purpose are refused', async () => {
    const collectOnly = publishAdapter({
      name: 'pg-collect-only',
      purpose: 'pipeline-gate',
      operations: ['collect'],
    })
    const trigger = await runner().trigger({
      adapterBindingRef: collectOnly,
      headSha: HEAD,
      gateKeys: ['unit'],
      idempotencyKey: 'nope',
      sinkPath: mkdtempSync(join(tmpdir(), 'rfc310-pr6-sink-')),
    })
    expect(trigger.ok).toBe(false)
    if (trigger.ok) return
    expect(trigger.failure.code).toBe('operation-not-declared')

    const wrongPurpose = publishAdapter({
      name: 'req-as-pipeline',
      purpose: 'requirement-source',
      operations: ['acquire'],
    })
    const out = await runner().collect({
      adapterBindingRef: wrongPurpose,
      headSha: HEAD,
      targetSha: TARGET,
      gateKeys: ['unit'],
      sinkPath: mkdtempSync(join(tmpdir(), 'rfc310-pr6-sink-')),
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.code).toBe('adapter-purpose-mismatch')

    const missing = await runner().collect({
      adapterBindingRef: '01UNKNOWN@1',
      headSha: HEAD,
      targetSha: TARGET,
      gateKeys: ['unit'],
      sinkPath: mkdtempSync(join(tmpdir(), 'rfc310-pr6-sink-')),
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.failure.code).toBe('adapter-binding-unresolved')
  })

  test('fixture backdoor: same envelope contract without any network', async () => {
    const fixturePath = join(mkdtempSync(join(tmpdir(), 'rfc310-pr6-fixture-')), 'pipeline.json')
    writeFileSync(
      fixturePath,
      JSON.stringify({
        pipeline: {
          headSha: HEAD,
          targetSha: TARGET,
          gates: [
            {
              gateKey: 'unit',
              required: true,
              status: 'fail',
              runRef: 'fx-run',
              attempt: 3,
              retryability: 'unsafe',
              failureCategories: ['compile'],
              logs: [{ logId: 'fx', bytes: 11 }],
            },
          ],
        },
        logFiles: { 'logs/unit/fx.log': 'hello logs\n' },
      }),
    )
    const store = createSqliteDevelopmentAdapterStore(db)
    const adapter = createPipelineEvidenceAdapter({
      resolveBinding: createDbAdapterBindingResolver((id, revision) =>
        store.getRevision(id, revision),
      ),
      extraEnv: { AW_PIPELINE_FIXTURE_JSON: fixturePath },
    })
    const binding = publishAdapter({
      name: 'pg-fixture',
      purpose: 'pipeline-gate',
      operations: ['collect'],
    })
    const sink = mkdtempSync(join(tmpdir(), 'rfc310-pr6-sink-'))
    const out = await adapter.collect({
      adapterBindingRef: binding,
      headSha: HEAD,
      targetSha: TARGET,
      gateKeys: ['unit'],
      sinkPath: sink,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.envelope.gates[0]).toMatchObject({ attempt: 3, retryability: 'unsafe' })
    expect(readFileSync(join(sink, 'logs', 'unit', 'fx.log'), 'utf8')).toBe('hello logs\n')
  })
})
