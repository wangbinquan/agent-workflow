// RFC-310 PR-5 T62 —— Java mission 全链 E2E（system mock 自证）。
//
// 除 Agent 进程外全部真件：真 git 仓（从 system mock 的 code-host 项目 HTTP
// clone）、真 repositoryFacts collector（Java/maven 启发式）、真 workspace 物化
// 与 validator、真 git candidate 派生、真 verification 子进程（repo:verify.sh）、
// 真 durable commit + exact-head CAS push（push 回 mock 的 smart HTTP remote，
// GIT_HTTP_RECEIVE_PACK=1）、真 mrEnsure（先查后建）打到 mock GitLab API。
// 「Agent 行为」由 scripted launcher 对真 workspace 落盘（journey 同款：检测
// 对象是文件系统状态）。
//
// 锁全链顺序与外部可见结果：implement → verification passed → commit →
// push（新分支 CAS null）→ MR opened（source_branch=aw/mission/<id>、title=
// requirement title）→ watching + mr-care wait。mock 侧断言 MR 与分支真实
// 存在——平台从不 force push、从不 merge。

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  startSystemMockSuite,
  type StartedSystemMockSuite,
} from '@agent-workflow/system-mocks'

import { composeDevelopmentAutomation } from '../src/modules/development-automation/composition'
import type { DevelopmentAutomationModule } from '../src/modules/development-automation/composition'
import type {
  AgentActionLauncherPort,
  AgentExecutionSnapshot,
} from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { defaultAutomationPolicyContent } from '../src/modules/development-automation/domain/automationPolicy'
import {
  createAutomationPolicy,
  publishAutomationPolicy,
} from '../src/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import {
  createVerificationProfile,
  publishVerificationProfile,
} from '../src/modules/development-automation/application/commands/verificationProfileCommands'
import { createSqliteVerificationProfileStore } from '../src/modules/development-automation/infrastructure/sqliteConfigResourceStore'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
} from '../src/modules/source-control/composition'
import { composeDevelopmentMrEffects } from '../src/modules/integration/composition/codeHostEffects'
import { cachedRepos } from '../src/db/schema'
import { buildPr3Fixture, type Pr3Fixture } from './helpers/rfc310Pr3Fixture'

setDefaultTimeout(240_000)

// git 面（clone/push/CAS）用 mock 服务端的磁盘 bare 仓路径（repoHttpUrl 的
// /git/ 段相对 tmpdir 解析）而非 smart HTTP：部分开发机的安全策略会拦「子进程
// →回环 HTTP」（git/curl 超时 0 字节，同进程 Bun fetch 正常，CI 无此问题——
// 见 docs/dev-gotchas.md）。MR API 面保持真 HTTP（mrEnsure → mock GitLab）。
function mockRepoDiskPath(repoHttpUrl: string): string {
  const pathname = decodeURIComponent(new URL(repoHttpUrl).pathname)
  return join(realpathSync(tmpdir()), pathname.replace(/^\/git\//, ''))
}

const HOME = mkdtempSync(resolve(tmpdir(), 'rfc310-e2e-java-'))
const PROJECT_PATH = 'rfc310/java-mission'

let suite: StartedSystemMockSuite
let fx: Pr3Fixture
let automation: DevelopmentAutomationModule
let repoHttpUrl = ''

const launches: { executionRef: string; workspacePath: string; prompt: string }[] = []
const outcomes = new Map<string, AgentExecutionSnapshot>()
const scripted: AgentActionLauncherPort = {
  async launch(input) {
    const executionRef = `e2e-exec-${launches.length + 1}`
    launches.push({ executionRef, workspacePath: input.workspacePath, prompt: input.prompt })
    return { ok: true, executionRef }
  },
  async fetchOutcome(executionRef) {
    return outcomes.get(executionRef) ?? { kind: 'pending', executionRef, taskStatus: 'running' }
  },
  async cancel() {
    return { settled: 'already-terminal' }
  },
}

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync({ cmd: ['git', ...args], cwd })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
  }
  return proc.stdout.toString()
}

beforeAll(async () => {
  suite = await startSystemMockSuite()
  const project = await suite.client.seedCodeHost({
    provider: 'gitlab',
    projectPath: PROJECT_PATH,
    title: 'seeded baseline',
    defaultBranch: 'main',
    baseFiles: {
      'pom.xml': '<project><modules><module>core</module></modules></project>\n',
      'core/pom.xml': '<project/>\n',
      'core/src/main/java/App.java': 'class App {}\n',
    },
  })
  repoHttpUrl = mockRepoDiskPath(project.repoHttpUrl)

  fx = await buildPr3Fixture()
  // 平台 repo cache = 从 mock remote 的真 clone（collector/baseline/push 的共同锚）。
  const repoPath = join(HOME, 'repo-cache')
  git(HOME, 'clone', '-q', repoHttpUrl, repoPath)
  git(repoPath, 'checkout', '-q', 'main')
  fx.db
    .insert(cachedRepos)
    .values({
      id: 'repo-1',
      urlHash: 'e2ejava1',
      localPath: repoPath,
      defaultBranch: 'main',
      lastFetchedAt: Date.now(),
      createdAt: Date.now(),
    })
    .run()

  // verification profile：仓内 verify.sh（由 Agent 随改动写入）。
  const vStore = createSqliteVerificationProfileStore(fx.db)
  const profile = createVerificationProfile(
    { store: vStore, now: () => Date.now() },
    {
      actorUserId: 'admin',
      name: 'java-verify',
      draft: {
        schemaVersion: 1,
        steps: [
          {
            stepId: 'unit',
            programRef: 'repo:verify.sh',
            argsRef: null,
            timeoutMs: 30_000,
            networkProfileRef: 'none@1',
            successExitCodes: [0],
            evidenceSelectors: [{ kind: 'file-glob', value: 'reports/**/*.txt' }],
          },
        ],
        stopPolicy: 'first-failure',
        maxParallel: 1,
      },
    },
  )
  publishVerificationProfile(
    { store: vStore, now: () => Date.now() },
    { id: profile.id, actorUserId: 'admin' },
  )
  // 带 verification 要求的 policy（fixture 默认 policy 之外另发一版，mission 落地后指过去）。
  const base = defaultAutomationPolicyContent()
  const vPolicy = await createAutomationPolicy(fx.db, {
    name: 'pol-e2e-java',
    ownerUserId: 'admin',
    draft: {
      ...base,
      actionPriority: {
        rules: [
          {
            ruleId: 'impl-once',
            when: [
              { kind: 'boolean-is', fact: 'requirement.bundleComplete', value: true },
              { kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] },
              // 只发射一次：collect 后 lastOutcome='changed'，本规则失配 →
              // 发布链（redispatchDelivery）接管 verification/publish/MR。
              { kind: 'enum-equals', fact: 'action.lastOutcome', value: 'none' },
            ],
            capabilityId: 'change.implement',
          },
        ],
      },
      verification: { requiredProfileRefs: [`${profile.id}@1`], stopPolicy: 'first-failure' },
    },
  })
  await publishAutomationPolicy(fx.db, { id: vPolicy.id, publishedBy: 'admin' })
  ;(fx as { e2ePolicyId?: string } as Record<string, unknown>).e2ePolicyId = vPolicy.id

  automation = composeDevelopmentAutomation({
    db: fx.db,
    appHome: HOME,
    agentLauncher: scripted,
    changeCandidate: bindChangeCandidateParticipant(),
    candidateDelivery: bindCandidateDeliveryParticipant(),
    repoRemote: {
      resolve: (repositoryId) =>
        repositoryId === 'repo-1' ? { remoteUrl: repoHttpUrl, defaultBranch: 'main' } : null,
    },
    mrEffects: composeDevelopmentMrEffects({
      binding: () => ({
        provider: 'gitlab',
        project: encodeURIComponent(PROJECT_PATH),
        call: {
          connection: {
            provider: 'gitlab',
            baseUrl: suite.endpoints.gitlabApiBaseUrl,
            repositoryUrlPrefixes: [],
            token: SYSTEM_MOCK_CODE_HOST_TOKEN,
            rejectUnauthorized: true,
          },
          ctx: { ports: {} },
        },
      }),
    }),
  })
})

afterAll(async () => {
  await suite.close()
})

function envelopeFor(prompt: string, missionId: string): string {
  const nonce = /<agent-result nonce="([^"]+)">/.exec(prompt)![1]!
  const actionRunRef = /"actionRunRef": "([^"]+)"/.exec(prompt)![1]!
  const inputDigest = /"inputDigest": "([^"]+)"/.exec(prompt)![1]!
  const manifest = automation.materializer.getRequirementManifest(missionId)!
  const json = JSON.stringify({
    protocolVersion: 1,
    nonce,
    port: 'agent-result',
    actionRunRef,
    inputDigest,
    capabilityId: 'change.implement',
    outcome: 'changed',
    result: {
      capabilityId: 'change.implement',
      summary: 'implemented the feature',
      requirementCoverage: manifest.files.map((f) => ({
        itemRef: f.fileId,
        disposition: 'implemented' as const,
      })),
    },
  })
  return `log noise\n<agent-result nonce="${nonce}">\n${json}\n</agent-result>\n`
}

describe('rfc310 pr5 T62 — java mission end-to-end on the system mock', () => {
  test('implement → verify → commit → CAS push → MR opened on the mock host → watching', async () => {
    // launch 冻结 digest（title/body 参与）：stash 必须与 launch 提交逐字一致。
    const missionId = await fx.launchDirect('e2e-java-1', 'Implement a greeting API in core.')
    const stashed = await automation.materializer.stashDirectSubmission({
      missionId,
      submission: {
        title: 'Add feature',
        body: 'Implement a greeting API in core.',
        uploads: [],
      },
    })
    expect(stashed.ok).toBe(true)
    // mission 指到带 verification 要求的 policy。
    {
      const mission = fx.store.getMission(missionId)!
      fx.store.occUpdate(mission.id, mission.revision, mission.epoch, {
        policyId: (fx as unknown as Record<string, unknown>).e2ePolicyId as string,
        policyRevision: 1,
      })
    }

    // 轮 1：materialize requirement bundle。
    await automation.reconcile(missionId)
    // 轮 2：规则读 repository.languages 撞 indeterminate → 真 collector 跑 Java 启发式。
    const collected = await automation.reconcile(missionId)
    expect(collected).toMatchObject({ kind: 'decided', handled: 'collected' })
    // 轮 3：implement 规则命中 → 真 workspace 物化 + scripted agent 发射。
    const launched = await automation.reconcile(missionId)
    expect(launched).toMatchObject({ kind: 'decided', handled: 'action-launched' })
    const last = launches[launches.length - 1]!

    // 「Agent」对真 workspace 落盘：业务改动 + 可执行 verify.sh + 报告产物。
    writeFileSync(
      join(last.workspacePath, 'core', 'src', 'main', 'java', 'Greeting.java'),
      'class Greeting { String hello() { return "hi"; } }\n',
    )
    const verifySh = join(last.workspacePath, 'verify.sh')
    writeFileSync(verifySh, '#!/bin/sh\nmkdir -p reports\necho ok > reports/unit.txt\nexit 0\n')
    chmodSync(verifySh, 0o755)
    outcomes.set(last.executionRef, {
      kind: 'exited',
      executionRef: last.executionRef,
      taskStatus: 'done',
      resultText: envelopeFor(last.prompt, missionId),
      errorSummary: null,
      errorMessage: null,
    })

    // 轮 4：collect → 真 validator → 真 git candidate 派生（treeOid 身份）。
    const collectedAction = await automation.reconcile(missionId)
    expect(collectedAction).toMatchObject({ kind: 'action-collect' })
    expect((collectedAction as { result: { disposition?: string } }).result).toMatchObject({
      disposition: 'validated-changed',
    })
    expect(fx.store.getMission(missionId)!.status).toBe('working')

    // 轮 5：发布链接管 → run-verification（stage 重放 + 真子进程跑 verify.sh）。
    const verified = await automation.reconcile(missionId)
    expect(verified).toMatchObject({ kind: 'decided', handled: 'collected' })
    expect((verified as { selected: { kind: string } }).selected.kind).toBe('run-verification')
    {
      const cells = fx.snapshots.getCells(fx.store.getMission(missionId)!.requirementBundleRef!)!
      expect(cells['__delivery.verifiedProfiles']).toMatchObject({ state: 'known' })
      expect(String((cells['__delivery.verifiedProfiles'] as { value: unknown }).value)).toContain(
        '"passed"',
      )
    }

    // 轮 6：commit（durable 内部 ref；working→publishing）。
    const committed = await automation.reconcile(missionId)
    expect(committed).toMatchObject({ kind: 'decided', handled: 'collected' })
    expect((committed as { selected: { kind: string } }).selected.kind).toBe(
      'commit-and-publish-candidate',
    )
    expect(fx.store.getMission(missionId)!.status).toBe('publishing')

    // 轮 7：push（新分支 exact-head CAS：expectedRemoteSha=null）→ 真推回 mock remote。
    const pushed = await automation.reconcile(missionId)
    expect(pushed).toMatchObject({ kind: 'decided', handled: 'collected' })
    const missionAfterPush = fx.store.getMission(missionId)!
    expect(missionAfterPush.deliverySourceBranch).toBe(`aw/mission/${missionId}`)

    // 轮 8：ensure-MR（真 mrEnsure 先查后建，打到 mock GitLab API）→ claim → watching。
    const ensured = await automation.reconcile(missionId)
    expect(ensured).toMatchObject({ kind: 'decided', handled: 'collected' })
    const missionAfterMr = fx.store.getMission(missionId)!
    expect(missionAfterMr.status).toBe('watching')
    expect(missionAfterMr.mrClaimId).not.toBeNull()

    // 轮 9：链完成 → 诚实 wait（MR care 属 PR-7）。
    const waiting = await automation.reconcile(missionId)
    expect((waiting as { selected: { kind: string; reason?: string } }).selected).toMatchObject({
      kind: 'wait',
      reason: 'mr-care-not-wired',
    })

    // 外部真相：mock 侧新 MR 存在、锚定 mission 分支与 requirement 标题；
    // effect 台账全部结算。
    const snapshot = await suite.client.snapshot()
    const host = snapshot.codeHosts.find((h) => h.projectPath === PROJECT_PATH)!
    const missionMr = host.mergeRequests.find(
      (mr) => mr.sourceBranch === `aw/mission/${missionId}`,
    )!
    expect(missionMr).toBeDefined()
    expect(missionMr.title).toBe('Add feature')
    expect(missionMr.targetBranch).toBe('main')
    expect(missionMr.state).toBe('opened')
    expect(fx.store.listUnsettledEffects(missionId)).toEqual([])

    // 推上去的分支确实带着 Agent 的业务文件（clone 下来对拍——不信 API，只信 git）。
    const checkout = mkdtempSync(join(tmpdir(), 'rfc310-e2e-verify-'))
    git(checkout, 'clone', '-q', '--branch', `aw/mission/${missionId}`, repoHttpUrl, 'pushed')
    const pushedFile = join(checkout, 'pushed', 'core', 'src', 'main', 'java', 'Greeting.java')
    expect(Bun.file(pushedFile).size).toBeGreaterThan(0)
  })
})
