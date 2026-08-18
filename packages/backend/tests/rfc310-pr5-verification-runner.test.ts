// RFC-310 PR-5 T57 —— verification 程序执行器（真子进程）。
//
// 锁：①exit code ∈ successExitCodes 是唯一「过」判据——stdout 里打 "passed"
// 但非零退出照样 fail（§3.5「程序 stdout 不是事实」）；②timeout TERM→KILL
// 且判 fail；③stopPolicy 两态；④evidence：file-glob 产物 + stdout tail 全部
// 进内容寻址 blob，receipt 只持 ref；⑤`repo:` resolver 拒越界/缺失，路径
// 逃逸不可达。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EvidenceStore } from '../src/modules/development-automation/infrastructure/evidenceStore'
import {
  createRepoScriptResolver,
  runVerificationProfile,
} from '../src/modules/development-automation/infrastructure/verificationRunner'
import type { VerificationProfileContent } from '../src/modules/development-automation/domain/verificationProfile'

setDefaultTimeout(120_000)

function makeWorkspace(scripts: Record<string, string>): string {
  const ws = mkdtempSync(join(tmpdir(), 'rfc310-verify-ws-'))
  for (const [rel, content] of Object.entries(scripts)) {
    const abs = join(ws, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
    if (rel.endsWith('.sh')) chmodSync(abs, 0o755)
  }
  return ws
}

function step(
  overrides: Partial<VerificationProfileContent['steps'][number]> & { stepId: string },
): VerificationProfileContent['steps'][number] {
  return {
    programRef: 'repo:verify.sh',
    argsRef: null,
    timeoutMs: 10_000,
    networkProfileRef: 'none@1',
    successExitCodes: [0],
    evidenceSelectors: [],
    ...overrides,
  }
}

function profile(
  steps: VerificationProfileContent['steps'],
  stopPolicy: VerificationProfileContent['stopPolicy'] = 'first-failure',
): VerificationProfileContent {
  return { schemaVersion: 1, steps, stopPolicy, maxParallel: 1 }
}

function evidenceStore(): EvidenceStore {
  return new EvidenceStore(mkdtempSync(join(tmpdir(), 'rfc310-verify-ev-')))
}

describe('rfc310 pr5 T57 — verification runner', () => {
  test('exit code is the only pass verdict: stdout "passed" with exit 1 still fails', async () => {
    const ws = makeWorkspace({
      'verify.sh': '#!/bin/sh\necho "ALL TESTS PASSED"\nexit 1\n',
    })
    const evidence = evidenceStore()
    const receipt = await runVerificationProfile(
      { evidence, resolver: createRepoScriptResolver() },
      { workspacePath: ws, profile: profile([step({ stepId: 'unit' })]) },
    )
    expect(receipt.ok).toBe(false)
    expect(receipt.steps[0]).toMatchObject({ stepId: 'unit', ok: false, exitCode: 1 })
    // stdout 进了 evidence（诊断可查），但没有让它变成「过」。
    const tailRef = receipt.steps[0]!.outputTailRef
    expect(tailRef).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(evidence.blobPath(tailRef!), 'utf8')).toContain('ALL TESTS PASSED')
  })

  test('success path collects file-glob artifacts into content-addressed evidence', async () => {
    const ws = makeWorkspace({
      'verify.sh': '#!/bin/sh\nmkdir -p reports\necho "<junit/>" > reports/unit.xml\nexit 0\n',
    })
    const evidence = evidenceStore()
    const receipt = await runVerificationProfile(
      { evidence, resolver: createRepoScriptResolver() },
      {
        workspacePath: ws,
        profile: profile([
          step({
            stepId: 'unit',
            evidenceSelectors: [{ kind: 'file-glob', value: 'reports/**/*.xml' }],
          }),
        ]),
      },
    )
    expect(receipt.ok).toBe(true)
    const files = receipt.steps[0]!.evidenceFiles
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'reports/unit.xml' })
    expect(readFileSync(evidence.blobPath(files[0]!.sha256), 'utf8')).toBe('<junit/>\n')
    expect(receipt.receiptDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('timeout kills the process and fails the step', async () => {
    const ws = makeWorkspace({
      'verify.sh': '#!/bin/sh\nsleep 30\nexit 0\n',
    })
    const receipt = await runVerificationProfile(
      { evidence: evidenceStore(), resolver: createRepoScriptResolver() },
      {
        workspacePath: ws,
        profile: profile([step({ stepId: 'hang', timeoutMs: 500 })]),
      },
    )
    expect(receipt.ok).toBe(false)
    expect(receipt.steps[0]!.timedOut).toBe(true)
    expect(receipt.steps[0]!.ok).toBe(false)
  }, 20_000)

  test('stopPolicy first-failure halts; collect-all runs every step', async () => {
    const scripts = {
      'fail.sh': '#!/bin/sh\nexit 2\n',
      'ok.sh': '#!/bin/sh\nexit 0\n',
    }
    const first = await runVerificationProfile(
      { evidence: evidenceStore(), resolver: createRepoScriptResolver() },
      {
        workspacePath: makeWorkspace(scripts),
        profile: profile(
          [
            step({ stepId: 'a', programRef: 'repo:fail.sh' }),
            step({ stepId: 'b', programRef: 'repo:ok.sh' }),
          ],
          'first-failure',
        ),
      },
    )
    expect(first.steps.map((s) => s.stepId)).toEqual(['a'])

    const all = await runVerificationProfile(
      { evidence: evidenceStore(), resolver: createRepoScriptResolver() },
      {
        workspacePath: makeWorkspace(scripts),
        profile: profile(
          [
            step({ stepId: 'a', programRef: 'repo:fail.sh' }),
            step({ stepId: 'b', programRef: 'repo:ok.sh' }),
          ],
          'collect-all',
        ),
      },
    )
    expect(all.steps.map((s) => `${s.stepId}:${s.ok}`)).toEqual(['a:false', 'b:true'])
    expect(all.ok).toBe(false)

    // 自定义 successExitCodes：exit 2 也可以是「过」。
    const tolerant = await runVerificationProfile(
      { evidence: evidenceStore(), resolver: createRepoScriptResolver() },
      {
        workspacePath: makeWorkspace(scripts),
        profile: profile([
          step({ stepId: 'a', programRef: 'repo:fail.sh', successExitCodes: [0, 2] }),
        ]),
      },
    )
    expect(tolerant.ok).toBe(true)
  })

  test('repo: resolver refuses traversal, absolute, backslash and missing programs', () => {
    const ws = makeWorkspace({ 'ok.sh': '#!/bin/sh\nexit 0\n' })
    const resolver = createRepoScriptResolver()
    const resolve = (programRef: string) =>
      resolver.resolve({ programRef, argsRef: null, workspacePath: ws })
    expect(resolve('repo:ok.sh')).not.toBeNull()
    expect(resolve('repo:ok.sh@1')).not.toBeNull()
    expect(resolve('repo:../etc/passwd')).toBeNull()
    expect(resolve('repo:/bin/sh')).toBeNull()
    expect(resolve('repo:scripts\\evil.sh')).toBeNull()
    expect(resolve('repo:missing.sh')).toBeNull()
    expect(resolve('managed:whatever@1')).toBeNull()
    // 解析失败的 step 判 fail（不 spawn 任何东西）。
  })

  test('unresolvable program fails the step without spawning', async () => {
    const receipt = await runVerificationProfile(
      { evidence: evidenceStore(), resolver: createRepoScriptResolver() },
      {
        workspacePath: makeWorkspace({}),
        profile: profile([step({ stepId: 'gone', programRef: 'repo:missing.sh' })]),
      },
    )
    expect(receipt.ok).toBe(false)
    expect(receipt.steps[0]).toMatchObject({ ok: false, exitCode: null })
  })
})
