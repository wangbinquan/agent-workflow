// RFC-310 browser journey: a human configures a repository assignment and
// submits body + repository-bound files through the SPA. From that point on,
// the compiled daemon owns the lifecycle: Agent action, verification, commit,
// push, MR creation, review repair/reply, and terminal merge tracking.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { runGit } from './command'

import {
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  SystemMockClient,
  type MockCodeHostProject,
} from '@agent-workflow/system-mocks'

import { defaultAutomationPolicyContent } from '../packages/backend/src/modules/development-automation/domain/automationPolicy'
import { defaultSystemMockToolPath, startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
// 跨 mission 的每一跳都可能等一整个 wake sweep（`DAEMON_CADENCE.developmentWakeSweep`
// = 30s，durable wait + 定时 observe 是 RFC-310 的既定设计，不是这里的临时慢）。
// 本旅程有「子 Mission ready → 审批提交 → 审批 approved → 父门禁重跑 → 父 MR ready」
// 四五跳，预算按最坏路径给足；给不足只会得到一条与实现无关的假红。
test.setTimeout(600_000)

// RFC-310 T132/T140-B —— 跨仓 + 外部审批 + ready + merged 的完整交付旅程。
//
// 2026-08-20 首次跑绿（本机 chromium + system mock，约 3 分钟，连跑两次稳定）。
// 首跑照出并修掉的四处，留在这里当账：
//   ①三个 testid 在前端根本不存在（`digital-employee-control-center` /
//     `code-assignments-link` / `code-launch-mission`）——这条 spec 写完从未被执行过；
//   ②新建 Mission 向导的 `disposedRef` 只在 cleanup 置 true、挂载时不复位，
//     `<StrictMode>` 双调用后上传永远被判成"页面已关闭"（回归锁在 code-missions-page.test.tsx）；
//   ③声明「吃 mission 需求」的步骤在需求物化前就被派发，Agent 拿到的是**空需求**；
//     且该步骤的身份用了 requirement *fact 快照*指针，每轮都变 ⇒ 同一步骤活锁重跑
//     110 次（两条都锁在 rfc310-playbook-coordinator.test.ts）；
//   ④read-only 动作（approval.prepare）覆盖了 `__action.runId`，发布链据此找 candidate
//     现场 ⇒ 假的 `candidate-tree-drift`（锁在 rfc310-pr5-delivery-chain.test.ts）。
// 跨 mission 的每一跳最多等一个 wake sweep（30s，durable wait 是既定设计），所以
// 本 spec 的预算按最坏路径给足；给不足只会得到一条与实现无关的假红。

// Windows 腿：**解除暂缓**（2026-08-20）。此前停跑的理由是「原因尚未定位，而
// blockDetail 是 null，CI 日志里看不到任何可用信息」——那条可观测性缺口已在
// `239e8237` 修好：step-failed 的 block 现在带上 attempt 失败回执的 remediation，
// 而本 spec 的等待器抛的正是 `mission blocked: ${blockCode}: ${blockDetail}`。
// 也就是说当初写下的解除条件（「给 block 带上 remediation 后的下一轮 CI」）已经
// 满足，继续停跑就变成了「用 skip 掩盖一个现在**能**查清的问题」。
//
// 保留原始症状供比对：windows-latest 上 Agent 动作曾以
// `step-failed:implement-parent-change:agent-contract-exhausted` 收场；darwin 与
// hosted linux 一直是绿的（本机连跑两次 3.0m/3.1m，CI 的 ubuntu/macos 两格 ✓）。

// 每次运行（含 Playwright 的 retry）用新的项目路径：system mock 的 `seedCodeHost`
// 对同名项目返回 500 `already seeded`，于是重试那一轮会先死在 beforeAll 上，把**真正的**
// 失败原因盖掉——第一次 windows 红就是这样只剩一条"already seeded"可看。
const RUN_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const PROJECT_PATH = `rfc310/browser-digital-employee-${RUN_TAG}`
const CHILD_PROJECT_PATH = `rfc310/browser-gate-configuration-${RUN_TAG}`
const REVIEW_BODY =
  'Please document the public behavior in the delivered result.\nKeep this exact acceptance wording.'

let daemon: DaemonHandle
let mocks: SystemMockClient
let project: MockCodeHostProject
let childProject: MockCodeHostProject
let childRepositoryId = ''
let employeeName = ''
let employeeId = ''
let policyName = ''
let webhook: { urlToken: string; secret: string }

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

async function requestJson<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${daemon.token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${text}`)
  }
  return (text === '' ? undefined : JSON.parse(text)) as T
}

async function publishResource<T extends { id: string }>(
  base: string,
  body: Record<string, unknown>,
): Promise<T & { revision: number }> {
  const created = await requestJson<T>(base, { method: 'POST', body })
  const published = await requestJson<{ revision: number }>(`${base}/${created.id}/publish`, {
    method: 'POST',
    body: {},
  })
  return { ...created, revision: published.revision }
}

async function importRepository(repoUrl: string): Promise<string> {
  let batch = await requestJson<{
    batchId: string
    state: 'running' | 'completed'
    rows: Array<{ status: string; message: string | null }>
  }>('/api/cached-repos/batch-import', { method: 'POST', body: { urls: [repoUrl] } })
  const deadline = Date.now() + 60_000
  while (batch.state !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    batch = await requestJson(`/api/cached-repos/imports/${batch.batchId}`)
  }
  if (batch.state !== 'completed' || batch.rows.some((row) => row.status !== 'done')) {
    throw new Error(`repository import failed: ${JSON.stringify(batch.rows)}`)
  }
  const repos = await requestJson<{ items: Array<{ id: string; urlRedacted: string | null }> }>(
    '/api/cached-repos',
  )
  const repo = repos.items.find((row) => row.urlRedacted === repoUrl)
  if (repo === undefined) throw new Error(`imported repository ${repoUrl} is missing`)
  return repo.id
}

async function seedDigitalEmployee(): Promise<void> {
  const suffix = Date.now().toString(36)
  employeeName = `Java MR caretaker ${suffix}`
  policyName = `Rule-driven delivery ${suffix}`

  const agent = await requestJson<{ id: string }>('/api/agents', {
    method: 'POST',
    body: {
      name: `rfc310-browser-agent-${suffix}`,
      description: 'Capability-bound Agent used by the RFC-310 browser journey.',
      outputs: ['agent-result'],
      runtime: 'opencode',
      bodyMd: '',
    },
  })

  const verification = await publishResource<{ id: string }>('/api/code/verification-profiles', {
    name: `Repository verification ${suffix}`,
    draft: {
      schemaVersion: 1,
      steps: [
        {
          stepId: 'uploaded-check',
          programRef: 'repo:verify.sh',
          argsRef: null,
          timeoutMs: 30_000,
          networkProfileRef: 'none@1',
          successExitCodes: [0],
          evidenceSelectors: [{ kind: 'stdout-tail', value: 4096 }],
        },
      ],
      stopPolicy: 'first-failure',
      maxParallel: 1,
    },
  })

  const templateDraft = (
    capabilityId: 'change.implement' | 'mr.feedback.apply' | 'approval.prepare',
  ) => ({
    schemaVersion: 1,
    capabilityId,
    capabilityContractVersion: 1,
    labels: ['java', 'browser-e2e'],
    compatibility: [],
    executor: { kind: 'agent', agentRef: agent.id },
    runtimeProfileRef: 'opencode',
    promptSupplement:
      capabilityId === 'change.implement'
        ? 'Implement the immutable requirement bundle.'
        : capabilityId === 'mr.feedback.apply'
          ? 'Apply every exact review feedback revision supplied by the platform.'
          : 'Prepare the exact external approval request from the bound evidence.',
    skillRefs: [],
    mcpRefs: [],
    readOnlyResourceRefs: [],
    contextProfileRef: null,
    writablePathPolicyRef: null,
    additionalProtectedPathClasses: [],
    verificationProfileRef: `${verification.id}@${verification.revision}`,
    retryDefaults: { sameSession: 1, freshSession: 1 },
  })
  const implement = await publishResource<{ id: string }>('/api/code/action-templates', {
    name: `Java implementation ${suffix}`,
    capabilityId: 'change.implement',
    draft: templateDraft('change.implement'),
  })
  const feedback = await publishResource<{ id: string }>('/api/code/action-templates', {
    name: `MR feedback repair ${suffix}`,
    capabilityId: 'mr.feedback.apply',
    draft: templateDraft('mr.feedback.apply'),
  })
  const approvalPrepare = await publishResource<{ id: string }>('/api/code/action-templates', {
    name: `Gate approval preparation ${suffix}`,
    capabilityId: 'approval.prepare',
    draft: templateDraft('approval.prepare'),
  })

  const basePolicy = defaultAutomationPolicyContent()
  const policy = await publishResource<{ id: string }>('/api/code/automation-policies', {
    name: policyName,
    draft: {
      ...basePolicy,
      requirement: {
        ...basePolicy.requirement,
        upload: { ...basePolicy.requirement.upload, allowExecutableFileMode: true },
      },
      actionPriority: {
        rules: [
          {
            ruleId: 'repair-human-feedback-first',
            when: [
              { kind: 'number-compare', fact: 'mr.unhandledFeedbackCount', op: 'gt', value: 0 },
            ],
            capabilityId: 'mr.feedback.apply',
          },
          {
            ruleId: 'implement-java-once',
            when: [
              { kind: 'boolean-is', fact: 'requirement.bundleComplete', value: true },
              { kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] },
              { kind: 'enum-equals', fact: 'action.lastOutcome', value: 'none' },
            ],
            capabilityId: 'change.implement',
          },
        ],
      },
      verification: {
        requiredProfileRefs: [`${verification.id}@${verification.revision}`],
        stopPolicy: 'first-failure',
      },
    },
  })

  const childPolicy = await publishResource<{ id: string }>('/api/code/automation-policies', {
    name: `Gate repository delivery ${suffix}`,
    draft: {
      ...basePolicy,
      actionPriority: {
        rules: [
          {
            ruleId: 'implement-gate-repository-once',
            when: [
              { kind: 'boolean-is', fact: 'requirement.bundleComplete', value: true },
              { kind: 'enum-equals', fact: 'action.lastOutcome', value: 'none' },
            ],
            capabilityId: 'change.implement',
          },
        ],
      },
      verification: { requiredProfileRefs: [], stopPolicy: 'first-failure' },
    },
  })

  const approvalAdapter = await publishResource<{ id: string }>(
    '/api/integrations/development-adapters',
    {
      name: `Gate approval system ${suffix}`,
      purpose: 'approval-gateway',
      draft: {
        schemaVersion: 1,
        purpose: 'approval-gateway',
        operations: ['submit', 'lookup-by-idempotency-key', 'observe'],
        contractVersion: 1,
        executableRef: defaultSystemMockToolPath(),
        parameterSchemaRef: null,
        connectionRef: null,
        secretProjection: [],
        outputBudget: {
          maxFiles: 16,
          maxFileBytes: 1024 * 1024,
          maxTotalBytes: 4 * 1024 * 1024,
        },
        timeoutMs: 30_000,
      },
    },
  )

  const failure = (
    onExhausted: string,
    onRejected: string | null = null,
    onExpired: string | null = null,
  ) => ({
    retry: { sameScene: 1, freshScene: 1 },
    onExhausted,
    onRejected,
    onExpired,
  })

  const childEmployee = await publishResource<{ id: string }>('/api/code/digital-employees', {
    name: `Gate configuration maintainer ${suffix}`,
    draft: {
      schemaVersion: 1,
      description:
        'Maintains the independent gate configuration repository and leaves its MR ready.',
      businessStatus: 'enabled',
      supportedRepositoryFacts: [],
      steps: [
        {
          stepId: 'implement-gate-change',
          displayName: 'Implement the gate repository change',
          description: '',
          when: [],
          producer: {
            kind: 'agent',
            implementationRef: { id: implement.id, revision: implement.revision },
          },
          input: { kind: 'mission-requirement' },
          onSuccess: 'reconcile',
          join: null,
          onFailure: failure('block'),
        },
      ],
      problemTypes: [],
      problemProducers: [],
      problemHandlers: [],
      capabilityRoutes: [
        {
          capabilityId: 'change.implement',
          rules: [],
          fallbackTemplateRef: { id: implement.id, revision: implement.revision },
        },
      ],
      requirementSources: [],
      pipelineProviders: [],
      defaultPolicyRef: { id: childPolicy.id, revision: childPolicy.revision },
    },
  })

  await requestJson('/api/code/repository-assignments', {
    method: 'PUT',
    body: {
      scopeKind: 'repository',
      scopeRef: childRepositoryId,
      employee: { id: childEmployee.id, revision: childEmployee.revision },
      selectionPolicy: null,
      executionPolicy: { id: childPolicy.id, revision: childPolicy.revision },
      defaultRequirementSourceKey: null,
    },
  })

  const parentEmployee = await publishResource<{ id: string }>('/api/code/digital-employees', {
    name: employeeName,
    draft: {
      schemaVersion: 1,
      description: 'Java delivery employee that implements requirements and tends MR feedback.',
      businessStatus: 'enabled',
      supportedRepositoryFacts: [],
      steps: [
        {
          stepId: 'implement-parent-change',
          displayName: 'Implement the parent repository change',
          description: '',
          when: [],
          producer: {
            kind: 'agent',
            implementationRef: { id: implement.id, revision: implement.revision },
          },
          input: { kind: 'mission-requirement' },
          onSuccess: 'delegate-gate-change',
          join: null,
          onFailure: failure('block'),
        },
        {
          stepId: 'delegate-gate-change',
          displayName: 'Ask the gate configuration employee',
          description: 'Create and wait for an independent child MR in the gate repository.',
          when: [],
          producer: {
            kind: 'digital-employee',
            employeeRef: { id: childEmployee.id, revision: childEmployee.revision },
            repository: { kind: 'fixed', repositoryId: childRepositoryId },
            completion: 'ready-to-merge',
            deadlineMs: 120_000,
          },
          input: { kind: 'step-output', stepId: 'implement-parent-change' },
          onSuccess: 'prepare-gate-approval',
          join: null,
          onFailure: failure('block'),
        },
        {
          stepId: 'prepare-gate-approval',
          displayName: 'Prepare the gate approval',
          description: 'The Agent produces a bounded draft without approval credentials.',
          when: [],
          producer: {
            kind: 'approval-prepare',
            executor: 'agent',
            implementationRef: { id: approvalPrepare.id, revision: approvalPrepare.revision },
            approvalType: 'gate-configuration-rollout',
          },
          input: { kind: 'step-output', stepId: 'delegate-gate-change' },
          onSuccess: 'submit-gate-approval',
          join: null,
          onFailure: failure('block'),
        },
        {
          stepId: 'submit-gate-approval',
          displayName: 'Submit the gate approval',
          description: 'A configured program submits the validated draft idempotently.',
          when: [],
          producer: {
            kind: 'approval-submit',
            adapterRef: { id: approvalAdapter.id, revision: approvalAdapter.revision },
          },
          input: { kind: 'step-output', stepId: 'prepare-gate-approval' },
          onSuccess: 'wait-gate-approval',
          join: null,
          onFailure: failure('block'),
        },
        {
          stepId: 'wait-gate-approval',
          displayName: 'Wait for the gate approval',
          description: 'A short program observes authoritative approval state on each wake.',
          when: [],
          producer: {
            kind: 'approval-observe',
            adapterRef: { id: approvalAdapter.id, revision: approvalAdapter.revision },
            pollIntervalMs: 5_000,
            deadlineMs: 120_000,
            webhookSourceKey: 'gate-approval',
          },
          input: { kind: 'step-output', stepId: 'submit-gate-approval' },
          onSuccess: 'reconcile',
          join: null,
          onFailure: failure('block', 'handoff', 'block'),
        },
        {
          stepId: 'repair-review-feedback',
          displayName: 'Repair review feedback',
          description: '',
          when: [{ kind: 'number-compare', fact: 'mr.unhandledFeedbackCount', op: 'gt', value: 0 }],
          producer: {
            kind: 'agent',
            implementationRef: { id: feedback.id, revision: feedback.revision },
          },
          input: { kind: 'mission-requirement' },
          onSuccess: 'reconcile',
          join: null,
          onFailure: failure('block'),
        },
      ],
      problemTypes: [],
      problemProducers: [],
      problemHandlers: [],
      capabilityRoutes: [
        {
          capabilityId: 'change.implement',
          rules: [],
          fallbackTemplateRef: { id: implement.id, revision: implement.revision },
        },
        {
          capabilityId: 'mr.feedback.apply',
          rules: [],
          fallbackTemplateRef: { id: feedback.id, revision: feedback.revision },
        },
        {
          capabilityId: 'approval.prepare',
          rules: [],
          fallbackTemplateRef: {
            id: approvalPrepare.id,
            revision: approvalPrepare.revision,
          },
        },
      ],
      requirementSources: [],
      pipelineProviders: [],
      defaultPolicyRef: { id: policy.id, revision: policy.revision },
    },
  })
  employeeId = parentEmployee.id
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function choose(page: Page, testId: string, option: string | RegExp): Promise<void> {
  await page.getByTestId(testId).click()
  await page.getByRole('option', { name: option }).click()
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await read()
    if (ready(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${label} did not settle; last=${JSON.stringify(last)}`)
}

function branchFile(branch: string, path: string): { content: string; mode: string } {
  const root = mkdtempSync(join(tmpdir(), 'rfc310-browser-branch-'))
  try {
    const checkout = join(root, 'checkout')
    // 一律走 e2e/command.ts 的有界、非交互 runGit（root-test-entrypoint 守卫：
    // spec 里自起子进程会让一个卡住的调用拖死整个 Playwright shard）。
    runGit(['clone', '-q', '--branch', branch, project.repoHttpUrl, checkout])
    const content = readFileSync(join(checkout, path), 'utf8')
    const mode = runGit(['ls-tree', branch, path], checkout).trim().split(/\s+/)[0]!
    return { content, mode }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test.beforeAll(async () => {
  mocks = new SystemMockClient(
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL'),
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN'),
  )
  const retainedHome = process.env.AW_RFC310_E2E_HOME
  daemon = await startDaemon({
    stubMode: 'development',
    ...(retainedHome === undefined ? {} : { home: retainedHome }),
  })
  await requestJson('/api/code-hosts/gitlab', {
    method: 'PUT',
    body: {
      baseUrl: requiredEnv('AW_SYSTEM_MOCK_GITLAB_API_BASE_URL'),
      token: SYSTEM_MOCK_CODE_HOST_TOKEN,
    },
  })
  project = await mocks.seedCodeHost({
    provider: 'gitlab',
    projectPath: PROJECT_PATH,
    title: 'RFC-310 digital employee browser journey',
    defaultBranch: 'main',
    baseFiles: {
      'pom.xml': '<project><modelVersion>4.0.0</modelVersion></project>\n',
      'src/main/java/App.java': 'class App {}\n',
    },
  })
  childProject = await mocks.seedCodeHost({
    provider: 'gitlab',
    projectPath: CHILD_PROJECT_PATH,
    title: 'RFC-310 delegated gate configuration',
    defaultBranch: 'main',
    baseFiles: {
      'pom.xml': '<project><modelVersion>4.0.0</modelVersion></project>\n',
      'gates/parent.yml': 'enabled: false\n',
    },
  })
  await importRepository(project.repoHttpUrl)
  childRepositoryId = await importRepository(childProject.repoHttpUrl)
  await seedDigitalEmployee()
  webhook = await requestJson('/api/webhook-endpoints', {
    method: 'POST',
    body: { name: 'RFC-310 browser MR lifecycle', provider: 'gitlab' },
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('the configured employee delegates another repository, waits for approval, and keeps the parent MR ready until merge', async ({
  page,
}) => {
  const preexistingApprovalKeys = new Set(
    (await mocks.snapshot()).approvals.map((approval) => approval.idempotencyKey),
  )
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/code`)
  // `/code` is the construction home: the build grid is always rendered, so it
  // is the honest "the page came up" anchor (there is no separate container id).
  await expect(page.getByTestId('digital-employee-build-employees')).toBeVisible()

  // Business-level strategy: bind the published employee and policy to this
  // repository through the actual assignment UI. The scope comes from the
  // employee we just published (`?employee=`), exactly like the product's own
  // 员工详情 → 设置范围 链路 —— an unscoped `/code` shortcut would let the
  // server-owned journey pick *any* configured employee (there are two here),
  // which is fine for a first-time user but is not what this journey asserts.
  await page.getByTestId('digital-employee-build-assignments').click()
  await page.goto(`${daemon.baseUrl}/code/assignments?employee=${employeeId}`)
  await page.getByTestId('assignment-create').click()
  await choose(page, 'assignment-scope-ref', /browser-digital-employee/)
  await choose(page, 'assignment-employee', employeeName)
  await choose(page, 'assignment-execution-policy', policyName)
  await page.getByTestId('assignment-save').click()
  await expect(page.getByTestId('assignments-repository')).toContainText(employeeName)

  // First-release input contract: body and uploaded files coexist. The target
  // path and executable bit are explicit and become part of the platform commit.
  // T138: 绑定保存后**同页**就出现「发起任务」——它是这一页的唯一主动作，
  // 且带着刚绑定的那名员工（PR-13：一页一个主动作，服务端给出下一步）。
  await page.getByTestId('journey-next-link').click()
  await choose(page, 'mission-repo-select', /browser-digital-employee/)
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('mission-title').fill('Ship the RFC-310 browser journey result')
  await page
    .getByTestId('mission-body')
    .fill('Implement the requested change and keep the uploaded verification program in git.')
  await page.getByTestId('mission-upload-files').setInputFiles({
    name: 'verify.sh',
    mimeType: 'text/x-shellscript',
    buffer: Buffer.from('#!/bin/sh\nset -eu\ntest -s digital-employee-result.txt\n'),
  })
  await page.getByTestId('mission-upload-target-0').fill('verify.sh')
  await page.getByTestId('mission-upload-executable-0').click()
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('mission-preflight').click()
  await expect(page.getByTestId('mission-preflight-ready')).toBeVisible()
  await page.getByTestId('mission-launch-submit').click()
  await page.waitForURL(/\/code\/missions\/[0-9A-Z]+$/)
  const missionId = page.url().split('/').at(-1)!
  const branch = `aw/mission/${missionId}`

  const delegated = await waitFor(
    'delegated child MR and submitted approval',
    async () => {
      const [snapshot, mission] = await Promise.all([
        mocks.snapshot(),
        requestJson<{
          status: string
          blockCode: string | null
          blockDetail: string | null
          collaboration: {
            children: Array<{
              childMissionId: string | null
              status: string | null
              completionSatisfied: boolean
            }>
            approvals: Array<{ externalRequestRef: string | null; status: string }>
          }
        }>(`/api/code/missions/${missionId}`),
      ])
      if (mission.status === 'blocked') {
        throw new Error(`mission blocked: ${mission.blockCode}: ${mission.blockDetail}`)
      }
      return {
        host: snapshot.codeHosts.find((row) => row.projectPath === CHILD_PROJECT_PATH)!,
        approval: snapshot.approvals.find(
          (row) => !preexistingApprovalKeys.has(row.idempotencyKey),
        ),
        mission,
      }
    },
    (state) =>
      state.host.mergeRequests.length > 0 &&
      state.approval !== undefined &&
      state.mission.collaboration.children.some((child) => child.completionSatisfied) &&
      state.mission.collaboration.approvals.length > 0,
    240_000,
  )
  const childReceipt = delegated.mission.collaboration.children[0]!
  expect(childReceipt.childMissionId).not.toBeNull()
  const childBranch = `aw/mission/${childReceipt.childMissionId}`
  // 子仓里除了平台开的这条，还有 seedCodeHost 自带的 `system-mock-change`：
  // 按分支名找，别按下标——下标断言只是在断言 mock 的种子顺序。
  expect(delegated.host.mergeRequests.map((mr) => mr.sourceBranch)).toContain(childBranch)

  await page.reload()
  await expect(page.getByTestId('mission-collaboration')).toBeVisible()
  await expect(page.getByTestId('mission-collaboration')).toContainText('Called digital employee')
  await expect(page.getByTestId('mission-collaboration')).toContainText('External approval')

  // The approval request identity is platform-derived, so the mock switches
  // the already-created request's future authoritative observations only after
  // discovering that exact key. The request itself is never recreated.
  await mocks.seedDevelopmentApproval({
    idempotencyKey: delegated.approval!.idempotencyKey,
    statuses: ['pending', 'approved'],
  })

  const firstState = await waitFor(
    'platform-created MR',
    async () => {
      const [snapshot, mission] = await Promise.all([
        mocks.snapshot(),
        requestJson<{ status: string; blockCode: string | null; blockDetail: string | null }>(
          `/api/code/missions/${missionId}`,
        ),
      ])
      if (mission.status === 'blocked') {
        throw new Error(`mission blocked: ${mission.blockCode}: ${mission.blockDetail}`)
      }
      return {
        host: snapshot.codeHosts.find((row) => row.projectPath === PROJECT_PATH)!,
        mission,
      }
    },
    (state) => state.host.mergeRequests.some((mr) => mr.sourceBranch === branch),
  )
  const firstHost = firstState.host
  const firstMr = firstHost.mergeRequests.find((mr) => mr.sourceBranch === branch)!
  const approvalAfterResume = (await mocks.snapshot()).approvals.find(
    (row) => row.idempotencyKey === delegated.approval!.idempotencyKey,
  )!
  expect(approvalAfterResume.externalRequestRef).toBe(delegated.approval!.externalRequestRef)
  expect(approvalAfterResume.observationIndex).toBeGreaterThanOrEqual(2)
  // 平台对子仓恰好开一条 MR：重复 observe / 重启不得再开一条（幂等的可见判据）。
  expect(
    (await mocks.snapshot()).codeHosts
      .find((row) => row.projectPath === CHILD_PROJECT_PATH)
      ?.mergeRequests.filter((mr) => mr.sourceBranch === childBranch),
  ).toHaveLength(1)
  await waitFor(
    'initial ready-to-merge state',
    () =>
      requestJson<{ status: string; blockCode: string | null }>(`/api/code/missions/${missionId}`),
    (mission) =>
      ['ready-to-merge', 'waiting-committer', 'watching'].includes(mission.status) &&
      mission.blockCode === null,
  )
  const firstResult = branchFile(branch, 'digital-employee-result.txt')
  expect(firstResult.content).toContain('Implemented by the RFC-310 digital employee system mock')
  expect(branchFile(branch, 'verify.sh').mode).toBe('100755')

  // Runtime belongs to the unified task surface, not to a second inbox or a
  // decorative RFC-304 activity graph under capability construction.
  await page.goto(`${daemon.baseUrl}/tasks?category=digital-employee`)
  await expect(page.getByTestId('digital-employee-task-list')).toBeVisible()
  await expect(page.getByTestId(`digital-employee-task-${missionId}`)).toBeVisible()
  await expect(page.getByTestId('code-panel-activity')).toHaveCount(0)

  // A human review event carries the exact multi-line body into the bounded
  // Agent input. The daemon must repair, push a new head and reply by itself.
  const reviewDelivery = await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${daemon.baseUrl}/webhooks/gitlab/${webhook.urlToken}`,
    secret: webhook.secret,
    projectPath: PROJECT_PATH,
    number: firstMr.number,
    event: 'review_comment_created',
    body: REVIEW_BODY,
    actor: { id: 99, username: 'human-reviewer', name: 'Human Reviewer' },
  })
  expect(reviewDelivery.status).toBe(200)

  const repairedHost = await waitFor(
    'feedback repair and platform reply',
    async () => (await mocks.snapshot()).codeHosts.find((row) => row.projectPath === PROJECT_PATH)!,
    (host) => {
      const mr = host.mergeRequests.find((row) => row.number === firstMr.number)
      return (
        mr !== undefined &&
        mr.headSha !== firstMr.headSha &&
        mr.reviewComments.some((comment) => comment.body.includes(`aw-self:${missionId}`))
      )
    },
    180_000,
  )
  const repairedMr = repairedHost.mergeRequests.find((row) => row.number === firstMr.number)!
  expect(repairedMr.headSha).not.toBe(firstMr.headSha)
  const repairedResult = branchFile(branch, 'digital-employee-result.txt').content
  expect(repairedResult).toContain('Applied review feedback: Please document the public behavior')
  expect(repairedResult).toContain('Keep this exact acceptance wording.')

  // The platform never merges. A committer merge event is authoritative; the
  // mission only tracks it to terminal and leaves the audit trail visible.
  const mergeDelivery = await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${daemon.baseUrl}/webhooks/gitlab/${webhook.urlToken}`,
    secret: webhook.secret,
    projectPath: PROJECT_PATH,
    number: firstMr.number,
    event: 'mr_merged',
    actor: { id: 100, username: 'committer', name: 'Repository Committer' },
  })
  expect(mergeDelivery.status).toBe(200)
  await waitFor(
    'merged mission terminal',
    () => requestJson<{ status: string }>(`/api/code/missions/${missionId}`),
    (mission) => mission.status === 'merged',
  )

  await page.goto(`${daemon.baseUrl}/code/missions/${missionId}`)
  await expect(page.getByTestId('mission-guidance')).toContainText(
    'The mission lifecycle is complete',
  )
  await expect(page.getByText('Merged', { exact: true })).toBeVisible()

  // Terminal history belongs to outcomes, and the retained mission result is
  // visible there after the committer event rather than remaining on /code.
  await page.goto(`${daemon.baseUrl}/outcomes`)
  await expect(page.getByTestId('run-outcomes-page')).toBeVisible()
  const outcomeHistory = page.getByTestId('code-outcome-history')
  await expect(outcomeHistory.getByText(missionId.slice(-8), { exact: true })).toBeVisible()
  await expect(outcomeHistory.getByText('Merged', { exact: true })).toBeVisible()
})
