// RFC-310 PR-6 T65 —— pipeline evidence safe streaming import。
//
// 锁：①文件全集以平台 safe-walk 为准（digest 平台重算；envelope 未提及的文件
// 照收、fileId=relativePath 补登）；②envelope 引用 sink 里不存在的文件 = adapter
// 合同违约整体拒收（不静默剪枝）；③fileId 一对多/多对一冲突拒；④provider 无
// head 绑定 ⇒ completeness 强制 partial；⑤预算超限拒（symlink/逃逸由
// importStagedTree 单点锁，已有测试覆盖）；⑥manifest schema 自检 + canonical
// manifestDigest + manifest 本体内容寻址入池。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EvidenceStore } from '../src/modules/development-automation/infrastructure/evidenceStore'
import {
  importPipelineEvidence,
  type PipelineCollectEnvelopeLike,
} from '../src/modules/development-automation/infrastructure/pipelineEvidenceImport'

setDefaultTimeout(120_000)

const HEAD = 'a1'.repeat(20)
const TARGET = 'b2'.repeat(20)
const BUDGET = { maxFiles: 100, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 }

function sink(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc310-t65-sink-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

function envelope(
  overrides: Partial<PipelineCollectEnvelopeLike> = {},
): PipelineCollectEnvelopeLike {
  return {
    providerKey: 'jenkins-mock',
    providerHeadSha: HEAD,
    targetSha: TARGET,
    completeness: 'complete',
    gates: [
      {
        gateKey: 'unit',
        required: true,
        status: 'fail',
        runRef: 'run-9',
        attempt: 1,
        finishedAt: '2026-08-18T00:00:00+00:00',
        retryability: 'safe',
        failureCategories: ['unit-test'],
        files: [{ fileId: 'log-unit', relativePath: 'logs/unit/console.log' }],
      },
    ],
    redaction: 'complete',
    ...overrides,
  }
}

function store(): EvidenceStore {
  return new EvidenceStore(mkdtempSync(join(tmpdir(), 'rfc310-t65-ev-')))
}

describe('rfc310 pr6 T65 — pipeline evidence import', () => {
  test('walk is the truth: platform digests, unreferenced files included, manifest blob content-addressed', async () => {
    const evidence = store()
    const staged = sink({
      'logs/unit/console.log': 'FAILED: NullPointerException\n',
      'reports/extra.txt': 'adapter forgot to mention me\n',
    })
    const out = await importPipelineEvidence(
      { evidence },
      {
        stagedRoot: staged,
        envelope: envelope(),
        expectedHeadSha: HEAD,
        expectedTargetSha: TARGET,
        budget: BUDGET,
      },
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const manifest = out.manifest
    // 文件全集来自 walk：envelope 只报了一个，manifest 有两个。
    expect(manifest.files.map((f) => f.relativePath)).toEqual([
      'logs/unit/console.log',
      'reports/extra.txt',
    ])
    // envelope 报的 fileId 保留；未报的以 relativePath 补登。
    expect(manifest.files[0]).toMatchObject({ fileId: 'log-unit', mediaType: 'text/plain' })
    expect(manifest.files[1]).toMatchObject({ fileId: 'reports/extra.txt' })
    expect(manifest.gates[0]!.evidenceFileIds).toEqual(['log-unit'])
    // digest 平台算：blob 池里能按 sha 找回原字节。
    const logFile = manifest.files[0]!
    expect(readFileSync(evidence.blobPath(logFile.sha256), 'utf8')).toContain(
      'NullPointerException',
    )
    expect(manifest.totals).toEqual({
      files: 2,
      bytes: manifest.files.reduce((n, f) => n + f.bytes, 0),
    })
    expect(manifest.manifestDigest).toMatch(/^[0-9a-f]{64}$/)
    // manifest 本体入池（内容寻址 ref）。
    expect(out.manifestRef).toMatch(/^[0-9a-f]{64}$/)
    const persisted = JSON.parse(readFileSync(evidence.blobPath(out.manifestRef), 'utf8')) as {
      manifestDigest: string
    }
    expect(persisted.manifestDigest).toBe(manifest.manifestDigest)
  })

  test('contract violations reject wholesale: missing referenced file, conflicting fileIds, budget', async () => {
    const evidence = store()
    // envelope 引用 sink 没有的文件 → 整体拒。
    const missing = await importPipelineEvidence(
      { evidence },
      {
        stagedRoot: sink({}),
        envelope: envelope(),
        expectedHeadSha: HEAD,
        expectedTargetSha: TARGET,
        budget: BUDGET,
      },
    )
    expect(missing).toMatchObject({ ok: false, code: 'pipeline-evidence-file-missing-in-sink' })

    // 同一路径两个 fileId → 拒。
    const conflicting = await importPipelineEvidence(
      { evidence },
      {
        stagedRoot: sink({ 'a.log': 'x\n' }),
        envelope: envelope({
          gates: [
            {
              ...envelope().gates[0]!,
              files: [
                { fileId: 'id-1', relativePath: 'a.log' },
                { fileId: 'id-2', relativePath: 'a.log' },
              ],
            },
          ],
        }),
        expectedHeadSha: HEAD,
        expectedTargetSha: TARGET,
        budget: BUDGET,
      },
    )
    expect(conflicting).toMatchObject({ ok: false, code: 'pipeline-evidence-file-id-conflict' })

    // 预算超限（importStagedTree 的 budget 面）→ typed 拒。
    const overBudget = await importPipelineEvidence(
      { evidence },
      {
        stagedRoot: sink({ 'big.log': 'x'.repeat(2048) }),
        envelope: envelope({ gates: [] }),
        expectedHeadSha: HEAD,
        expectedTargetSha: TARGET,
        budget: { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096 },
      },
    )
    expect(overBudget).toMatchObject({ ok: false, code: 'pipeline-evidence-import-failed' })
  })

  test('provider without head binding is forced partial; head/target fall back to expected', async () => {
    const evidence = store()
    const out = await importPipelineEvidence(
      { evidence },
      {
        stagedRoot: sink({ 'logs/unit/console.log': 'x\n' }),
        envelope: envelope({ providerHeadSha: null, targetSha: null, completeness: 'complete' }),
        expectedHeadSha: HEAD,
        expectedTargetSha: TARGET,
        budget: BUDGET,
      },
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.manifest.completeness).toBe('partial')
    expect(out.manifest.headSha).toBe(HEAD)
    expect(out.manifest.targetSha).toBe(TARGET)
  })
})
