import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { startSystemMockSuite, SystemMockClient, type StartedSystemMockSuite } from '../src'

let suite: StartedSystemMockSuite
const cli = resolve(import.meta.dir, '../src/development/approval-adapter-cli.ts')

beforeAll(async () => {
  suite = await startSystemMockSuite()
})

beforeEach(async () => {
  await suite.client.reset()
})

afterAll(async () => {
  await suite.close()
})

async function adapter(
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; body: Record<string, unknown> | null }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, cli, ...argv],
    env: {
      PATH: Bun.env.PATH ?? '',
      HOME: Bun.env.HOME ?? '',
      TMPDIR: Bun.env.TMPDIR ?? '/tmp',
      AW_APPROVAL_MOCK_URL: suite.endpoints.developmentApprovalBaseUrl,
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  const line = stdout.trim().split('\n').at(-1)
  return {
    exitCode,
    body: line === undefined || line === '' ? null : (JSON.parse(line) as Record<string, unknown>),
  }
}

describe('RFC-310 approval system mock', () => {
  test('keeps two repository remotes and approval receipts isolated across client recreation', async () => {
    const parent = await suite.client.seedCodeHost({
      provider: 'gitlab',
      projectPath: 'rfc310/parent-application',
      baseFiles: { 'src/App.java': 'class App {}\n' },
    })
    const child = await suite.client.seedCodeHost({
      provider: 'gitlab',
      projectPath: 'rfc310/gate-configuration',
      baseFiles: { 'gates/parent.yml': 'enabled: false\n' },
    })
    const key = '1'.repeat(64)
    const intentDigest = '2'.repeat(64)
    await suite.client.seedDevelopmentApproval({
      idempotencyKey: key,
      statuses: ['pending'],
      responseLost: true,
    })

    const submitted = await adapter(['--submit-approval', 'cross-repo-approval'], {
      AW_IDEMPOTENCY_KEY: key,
      AW_APPROVAL_INTENT_DIGEST: intentDigest,
      AW_APPROVAL_STEP_RUN: 'cross-repo-approval',
      AW_APPROVAL_DRAFT_REF: `draft:${child.projectId}`,
      AW_APPROVAL_DEADLINE: '2026-08-20T00:00:00+00:00',
    })
    expect(submitted.exitCode).toBe(0)

    const restartedClient = new SystemMockClient(suite.endpoints.controlUrl, suite.controlToken)
    const afterRestart = await restartedClient.snapshot()
    expect(afterRestart.codeHosts.map((project) => project.projectPath).sort()).toEqual([
      child.projectPath,
      parent.projectPath,
    ])
    expect(parent.projectId).not.toBe(child.projectId)
    expect(parent.repoHttpUrl).not.toBe(child.repoHttpUrl)
    expect(parent.headSha).not.toBe(child.headSha)
    expect(afterRestart.approvals).toMatchObject([
      {
        idempotencyKey: key,
        intentDigest,
        lostResponseSent: true,
      },
    ])

    await restartedClient.seedDevelopmentApproval({
      idempotencyKey: key,
      statuses: ['pending', 'approved'],
    })
    const correlationRef = String(submitted.body?.correlationRef)
    expect((await adapter(['--observe-approval', correlationRef])).body?.status).toBe('pending')
    expect((await adapter(['--observe-approval', correlationRef])).body?.status).toBe('approved')
    expect((await adapter(['--observe-approval', correlationRef])).body?.status).toBe('approved')
    expect((await restartedClient.snapshot()).approvals).toMatchObject([
      { correlationRef, observationIndex: 2 },
    ])
  })

  test('adopts a committed submit after response loss and never duplicates the request', async () => {
    const key = 'a'.repeat(64)
    const intentDigest = 'b'.repeat(64)
    await suite.client.seedDevelopmentApproval({
      idempotencyKey: key,
      statuses: ['pending', 'approved'],
      responseLost: true,
    })

    const first = await adapter(['--submit-approval', 'step-run-1'], {
      AW_IDEMPOTENCY_KEY: key,
      AW_APPROVAL_INTENT_DIGEST: intentDigest,
      AW_APPROVAL_STEP_RUN: 'step-run-1',
      AW_APPROVAL_DRAFT_REF: 'draft:1',
      AW_APPROVAL_DEADLINE: '2026-08-20T00:00:00+00:00',
    })
    expect(first.exitCode).toBe(0)
    expect(first.body).toMatchObject({
      protocol: 'aw-adapter@1',
      operation: 'approval.submit',
      intentDigest,
      externalRequestRef: 'APP-00001',
    })

    const replay = await adapter(['--submit-approval', 'step-run-1'], {
      AW_IDEMPOTENCY_KEY: key,
      AW_APPROVAL_INTENT_DIGEST: intentDigest,
      AW_APPROVAL_STEP_RUN: 'step-run-1',
      AW_APPROVAL_DRAFT_REF: 'draft:1',
      AW_APPROVAL_DEADLINE: '2026-08-20T00:00:00+00:00',
    })
    expect(replay.exitCode).toBe(0)
    expect(replay.body?.externalRequestRef).toBe('APP-00001')
    expect((await suite.client.snapshot()).approvals).toHaveLength(1)
  })

  test('lookup is explicit and observations follow the seeded pending-to-approved sequence', async () => {
    const missing = await adapter(['--lookup-approval', 'missing-key'])
    expect(missing.body).toEqual({
      protocol: 'aw-adapter@1',
      operation: 'approval.lookup',
      found: false,
    })

    const key = 'c'.repeat(64)
    await suite.client.seedDevelopmentApproval({
      idempotencyKey: key,
      statuses: ['pending', 'approved'],
    })
    const submitted = await adapter(['--submit-approval', 'step-run-2'], {
      AW_IDEMPOTENCY_KEY: key,
      AW_APPROVAL_INTENT_DIGEST: 'd'.repeat(64),
      AW_APPROVAL_STEP_RUN: 'step-run-2',
      AW_APPROVAL_DRAFT_REF: 'draft:2',
      AW_APPROVAL_DEADLINE: '2026-08-20T00:00:00+00:00',
    })
    const correlationRef = String(submitted.body?.correlationRef)
    expect((await adapter(['--observe-approval', correlationRef])).body?.status).toBe('pending')
    const approved = await adapter(['--observe-approval', correlationRef])
    expect(approved.body).toMatchObject({
      status: 'approved',
      evidenceRef: 'approval-evidence:APP-00001',
    })
  })

  test('the same idempotency key only adopts the exact same approval intent', async () => {
    const key = 'e'.repeat(64)
    const firstDigest = 'f'.repeat(64)
    const submitted = await adapter(['--submit-approval', 'step-run-3'], {
      AW_IDEMPOTENCY_KEY: key,
      AW_APPROVAL_INTENT_DIGEST: firstDigest,
      AW_APPROVAL_STEP_RUN: 'step-run-3',
      AW_APPROVAL_DRAFT_REF: 'draft:3',
      AW_APPROVAL_DEADLINE: '2026-08-20T00:00:00+00:00',
    })
    expect(submitted.exitCode).toBe(0)

    const collision = await adapter(['--submit-approval', 'step-run-4'], {
      AW_IDEMPOTENCY_KEY: key,
      AW_APPROVAL_INTENT_DIGEST: '0'.repeat(64),
      AW_APPROVAL_STEP_RUN: 'step-run-4',
      AW_APPROVAL_DRAFT_REF: 'draft:4',
      AW_APPROVAL_DEADLINE: '2026-08-21T00:00:00+00:00',
    })
    expect(collision.exitCode).toBe(5)
    expect(collision.body).toBeNull()
    expect((await suite.client.snapshot()).approvals).toMatchObject([
      { idempotencyKey: key, intentDigest: firstDigest },
    ])
  })

  test('rejected, expired, and unavailable remain distinct provider receipts', async () => {
    for (const [index, status] of ['rejected', 'expired', 'unavailable'].entries()) {
      const key = String(index + 1).repeat(64)
      await suite.client.seedDevelopmentApproval({
        idempotencyKey: key,
        statuses: [status as 'rejected' | 'expired' | 'unavailable'],
      })
      const submitted = await adapter(['--submit-approval', `terminal-step-${index}`], {
        AW_IDEMPOTENCY_KEY: key,
        AW_APPROVAL_INTENT_DIGEST: String(index + 4).repeat(64),
        AW_APPROVAL_STEP_RUN: `terminal-step-${index}`,
        AW_APPROVAL_DRAFT_REF: `draft:${index}`,
        AW_APPROVAL_DEADLINE: '2026-08-20T00:00:00+00:00',
      })
      expect(submitted.exitCode).toBe(0)
      expect(
        (await adapter(['--observe-approval', String(submitted.body?.correlationRef)])).body
          ?.status,
      ).toBe(status)
    }
  })

  test('transport faults do not masquerade as an approval receipt', async () => {
    const key = '9'.repeat(64)
    await suite.client.seedDevelopmentApproval({ idempotencyKey: key, statuses: ['pending'] })
    const submitted = await adapter(['--submit-approval', 'step-run-transport'], {
      AW_IDEMPOTENCY_KEY: key,
      AW_APPROVAL_INTENT_DIGEST: '8'.repeat(64),
      AW_APPROVAL_STEP_RUN: 'step-run-transport',
      AW_APPROVAL_DRAFT_REF: 'draft:transport',
      AW_APPROVAL_DEADLINE: '2026-08-20T00:00:00+00:00',
    })

    await suite.client.addFault({
      service: 'development-approval',
      method: 'GET',
      pathPrefix: '/development-approval/approvals/',
      status: 503,
      times: 1,
    })
    const failed = await adapter(['--observe-approval', String(submitted.body?.correlationRef)])
    expect(failed.exitCode).toBe(5)
    expect(failed.body).toBeNull()
  })
})
