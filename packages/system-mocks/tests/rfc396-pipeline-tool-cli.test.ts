// Exercise the same multiplexer compiled into the E2E tool artifact. Calling the
// dedicated pipeline CLI directly would miss a missing tool.ts dispatch branch.
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess } from '../src/core/process'
import { startPipelineProviderMock } from '../src/development/pipeline-provider'

interface CollectReceipt {
  protocol: string
  operation: string
  providerHeadSha: string
  targetSha: string
  completeness: string
  gates: {
    gateKey: string
    status: string
    runRef: string
    attempt: number
    files: { fileId: string; relativePath: string }[]
  }[]
}
interface MutationReceipt {
  protocol: string
  operation: string
  providerReceiptRef: string
  runRef: string
  headSha: string
  adopted?: boolean
  attempt?: number
}

test('RFC-396 tool CLI collects real pipeline logs and preserves trigger/rerun receipts', async () => {
  const provider = await startPipelineProviderMock()
  const sink = mkdtempSync(join(tmpdir(), 'rfc396-pipeline-tool-'))
  const head = 'a'.repeat(40)
  const target = 'b'.repeat(40)
  const cli = resolve(import.meta.dir, '..', 'src', 'tool.ts')
  const run = async <T>(args: string[], operationEnv: Record<string, string> = {}) => {
    const result = await runProcess(process.execPath, [cli, ...args], {
      cwd: sink,
      // Match the native adapter's explicit environment inputs; do not inherit
      // a fixture-file override that could silently replace the real HTTP path.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: tmpdir(),
        AW_ADAPTER_SINK: sink,
        AW_PIPELINE_MOCK_URL: provider.url,
        AW_PIPELINE_HEAD: head,
        AW_PIPELINE_TARGET: target,
        ...operationEnv,
      },
      timeoutMs: 10_000,
    })
    expect(result.exitCode, result.stderr.toString('utf8')).toBe(0)
    const lines = result.stdout.toString('utf8').split(/\r?\n/).filter(Boolean)
    expect(lines).toHaveLength(1)
    return JSON.parse(lines[0]!) as T
  }
  try {
    provider.mock.seed({
      headSha: head,
      targetSha: target,
      gates: [
        {
          gateKey: 'unit',
          required: true,
          status: 'fail',
          runRef: 'initial-unit',
          attempt: 1,
          retryability: 'safe',
          failureCategories: ['unit-test'],
          logs: [{ logId: 'rfc396-tool-log', bytes: 4096 }],
        },
      ],
    })
    const collected = await run<CollectReceipt>(['--collect-pipeline', head])
    expect(collected).toMatchObject({
      protocol: 'aw-adapter@1',
      operation: 'pipeline.collect',
      providerHeadSha: head,
      targetSha: target,
      completeness: 'complete',
    })
    expect(collected.gates).toHaveLength(1)
    expect(collected.gates[0]).toMatchObject({
      gateKey: 'unit',
      status: 'fail',
      runRef: 'initial-unit',
      attempt: 1,
      files: [{ fileId: 'unit/rfc396-tool-log', relativePath: 'logs/unit/rfc396-tool-log.log' }],
    })
    const retained = readFileSync(join(sink, collected.gates[0]!.files[0]!.relativePath))
    expect(retained.byteLength).toBe(4096)
    expect(retained.toString('utf8')).toContain('rfc396-tool-log line 1:')
    const original = await fetch(`${provider.url}/runs/initial-unit/logs/rfc396-tool-log`)
    expect(original.status).toBe(200)
    expect(retained).toEqual(Buffer.from(await original.arrayBuffer()))

    const triggerEnv = { AW_PIPELINE_GATES: 'integration', AW_IDEMPOTENCY_KEY: 'rfc396-trigger' }
    const triggered = await run<MutationReceipt>(['--trigger-pipeline', head], triggerEnv)
    expect(triggered).toMatchObject({
      protocol: 'aw-adapter@1',
      operation: 'pipeline.trigger',
      headSha: head,
      adopted: false,
    })
    expect(triggered.providerReceiptRef.length).toBeGreaterThan(0)
    expect(triggered.runRef.length).toBeGreaterThan(0)
    expect(await run<MutationReceipt>(['--trigger-pipeline', head], triggerEnv)).toEqual({
      ...triggered,
      adopted: true,
    })

    const rerunEnv = { AW_PIPELINE_GATE: 'unit', AW_IDEMPOTENCY_KEY: 'rfc396-rerun' }
    const rerun = await run<MutationReceipt>(['--rerun-pipeline', 'initial-unit'], rerunEnv)
    expect(rerun).toMatchObject({
      protocol: 'aw-adapter@1',
      operation: 'pipeline.rerun',
      headSha: head,
      runRef: 'initial-unit',
      attempt: 2,
    })
    expect(rerun.providerReceiptRef.length).toBeGreaterThan(0)
    expect(await run<MutationReceipt>(['--rerun-pipeline', 'initial-unit'], rerunEnv)).toEqual(
      rerun,
    )
    const state = await fetch(`${provider.url}/pipelines/${head}`)
    expect(state.status).toBe(200)
    const wire = (await state.json()) as {
      gates: { gateKey: string; runRef: string; attempt: number; status: string }[]
    }
    expect(wire.gates).toHaveLength(2)
    expect(wire.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateKey: 'unit',
          runRef: 'initial-unit',
          attempt: 2,
          status: 'queued',
        }),
        expect.objectContaining({
          gateKey: 'integration',
          runRef: triggered.runRef,
          attempt: 1,
          status: 'queued',
        }),
      ]),
    )
  } finally {
    await provider.close()
    rmSync(sink, { recursive: true, force: true })
  }
}, 60_000)
