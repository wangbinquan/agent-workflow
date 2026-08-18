// RFC-310 PR-10 T109 —— system mock 全旅程 E2E（/goal 的最终自证面）。
//
// PR-5 的 T62 E2E 停在 watching + collect-mr-facts；本家族把生命周期走到
// **外部 merged 终态**，并覆盖 adopt 起点。除 Agent 进程外全部真件（T62 同款
// harness）：真 git 仓（mock code-host 磁盘 bare 仓）、真 collector、真
// workspace/validator/candidate、真 verification 子进程、真 commit/CAS push、
// 真 mrEnsure/mrFacts/mrReply 打 mock GitLab API。「Agent」由 scripted
// launcher 对真 workspace 落盘。
//
// 旅程 A（create-MR 全生命周期）：
//   requirement → implement → verify → commit → CAS push → MR opened →
//   watching → MR facts（真三读 fence）→ mock 种 human review thread →
//   facts 再采 → 台账 selectable → policy 路由 mr.feedback.apply →「Agent」
//   第二轮修复 → verify → commit → push（MR 分支前进）→ reply-feedback
//   真回帖（self marker）→ mock 侧 MR merged → facts 再采 → guard
//   mark-terminal → mission merged、claim released、effect 台账零悬挂。
// 旅程 B（adopt 起点）：cutover adoptActiveMr 接管 mock 上已存在的外部 MR →
//   watching + active claim → mock 侧 merged → care 链走到 authoritative
//   terminal（与旅程 A 共享 harness，验证第二入口同一生命周期语义）。
//
// staleness 快进：MR facts 的 5min stale 门槛通过 patch
// `__mr.factsCollectedAt` cells 实现（PR-7 集成测试同款手法）——快进时钟，
// 不伪造行为。

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

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
  MrEffectsPort,
} from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { defaultAutomationPolicyContent } from '../src/modules/development-automation/domain/automationPolicy'
import {
  canonicalDigest,
  canonicalStringify,
} from '../src/modules/development-automation/domain/canonicalJson'
import {
  createAutomationPolicy,
  publishAutomationPolicy,
} from '../src/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import {
  createVerificationProfile,
  publishVerificationProfile,
} from '../src/modules/development-automation/application/commands/verificationProfileCommands'
import { createSqliteVerificationProfileStore } from '../src/modules/development-automation/infrastructure/sqliteConfigResourceStore'
import { adoptActiveMr } from '../src/modules/development-automation/application/cutover'
import { createSqliteCutoverStore } from '../src/modules/development-automation/infrastructure/sqliteCutoverStore'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
} from '../src/modules/source-control/composition'
import { composeDevelopmentMrEffects } from '../src/modules/integration/composition/codeHostEffects'
import { collectMergeRequestFacts } from '../src/modules/integration/application/mrFacts'
import { projectMrCells } from '../src/modules/development-automation/domain/mrFacts'
import type { MergeRequestFactsCollectorPort } from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { sha256Hex } from '../src/util/hash'
import { cachedRepos, developmentAgentAttempts, developmentMrClaims } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { buildPr3Fixture, type Pr3Fixture } from './helpers/rfc310Pr3Fixture'

setDefaultTimeout(300_000)

// 子进程→回环 HTTP 在部分开发机被拦（docs/dev-gotchas.md）：git 面走 mock
// 磁盘 bare 仓；MR API 面保持真 HTTP。
function mockRepoDiskPath(repoHttpUrl: string): string {
  const pathname = decodeURIComponent(new URL(repoHttpUrl).pathname)
  return join(realpathSync(tmpdir()), pathname.replace(/^\/git\//, ''))
}

const HOME = mkdtempSync(resolve(tmpdir(), 'rfc310-t109-'))
const PROJECT_PATH = 'rfc310/t109-journey'

let suite: StartedSystemMockSuite
let fx: Pr3Fixture
let automation: DevelopmentAutomationModule
let repoUrl = ''
let mrEffects: MrEffectsPort

const launches: {
  executionRef: string
  workspacePath: string
  prompt: string
  capabilityId: string
}[] = []
const outcomes = new Map<string, AgentExecutionSnapshot>()
const scripted: AgentActionLauncherPort = {
  async launch(input) {
    const executionRef = `t109-exec-${launches.length + 1}`
    const capabilityId = /"capabilityId": "([^"]+)"/.exec(input.prompt)?.[1] ?? 'unknown'
    launches.push({
      executionRef,
      workspacePath: input.workspacePath,
      prompt: input.prompt,
      capabilityId,
    })
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

function hostBinding() {
  return {
    provider: 'gitlab' as const,
    project: encodeURIComponent(PROJECT_PATH),
    call: {
      connection: {
        provider: 'gitlab' as const,
        baseUrl: suite.endpoints.gitlabApiBaseUrl,
        repositoryUrlPrefixes: [],
        token: SYSTEM_MOCK_CODE_HOST_TOKEN,
        rejectUnauthorized: true,
      },
      ctx: { ports: {} },
    },
  }
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
  repoUrl = mockRepoDiskPath(project.repoHttpUrl)

  fx = await buildPr3Fixture({ feedbackRoute: true })
  const repoPath = join(HOME, 'repo-cache')
  git(HOME, 'clone', '-q', repoUrl, repoPath)
  git(repoPath, 'checkout', '-q', 'main')
  fx.db
    .insert(cachedRepos)
    .values({
      id: 'repo-1',
      urlHash: 't109j1',
      localPath: repoPath,
      defaultBranch: 'main',
      lastFetchedAt: Date.now(),
      createdAt: Date.now(),
    })
    .run()

  const vStore = createSqliteVerificationProfileStore(fx.db)
  const profile = createVerificationProfile(
    { store: vStore, now: () => Date.now() },
    {
      actorUserId: 'admin',
      name: 't109-verify',
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

  const base = defaultAutomationPolicyContent()
  const policy = await createAutomationPolicy(fx.db, {
    name: 'pol-t109',
    ownerUserId: 'admin',
    draft: {
      ...base,
      actionPriority: {
        rules: [
          {
            ruleId: 'feedback-apply',
            when: [
              { kind: 'number-compare', fact: 'mr.unhandledFeedbackCount', op: 'gt', value: 0 },
            ],
            capabilityId: 'mr.feedback.apply',
          },
          {
            ruleId: 'impl-once',
            when: [
              { kind: 'boolean-is', fact: 'requirement.bundleComplete', value: true },
              { kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] },
              { kind: 'enum-equals', fact: 'action.lastOutcome', value: 'none' },
            ],
            capabilityId: 'change.implement',
          },
        ],
      },
      verification: { requiredProfileRefs: [`${profile.id}@1`], stopPolicy: 'first-failure' },
    },
  })
  await publishAutomationPolicy(fx.db, { id: policy.id, publishedBy: 'admin' })
  ;(fx as unknown as Record<string, unknown>).t109PolicyId = policy.id

  mrEffects = composeDevelopmentMrEffects({ binding: () => hostBinding() })
  // 与 buildDevelopmentMrFactsDeps 的生产投影同形（binding 直给以绕开
  // secret-keyfile connection 配置）：claim 行 → 真三读 fence 采集打 mock →
  // projectMrCells + threads bodyDigest。生产投影若改形，本测试会红——对拍锁。
  const mergeRequestFacts: MergeRequestFactsCollectorPort = {
    async collect(input) {
      if (input.mrClaimId === null) {
        throw new Error(`no MR claim (mission=${input.missionId})`)
      }
      const claim = fx.db
        .select({ mrIid: developmentMrClaims.mrIid })
        .from(developmentMrClaims)
        .where(eq(developmentMrClaims.id, input.mrClaimId))
        .get()
      if (claim === undefined) throw new Error('claim row missing')
      const out = await collectMergeRequestFacts(hostBinding(), claim.mrIid, {
        selfMarker: input.missionId,
      })
      if (!out.ok) throw new Error(`mr facts collect failed: ${out.code}: ${out.detail}`)
      const snapshot = out.snapshot
      const snapshotRef = canonicalDigest(snapshot)
      const now = Date.now()
      return {
        cells:
          snapshot.headSha === null
            ? {}
            : projectMrCells({ ...snapshot, headSha: snapshot.headSha }, 0, snapshotRef, now),
        snapshotRef,
        headSha: snapshot.headSha,
        targetSha: snapshot.targetSha,
        threads: snapshot.threads.map((thread) => ({
          threadRef: thread.threadRef,
          revision: thread.revision,
          authorClass: thread.authorClass,
          resolved: thread.resolved,
          bodyDigest: sha256Hex(thread.lastBody),
        })),
      }
    },
  }
  automation = composeDevelopmentAutomation({
    db: fx.db,
    appHome: HOME,
    agentLauncher: scripted,
    changeCandidate: bindChangeCandidateParticipant(),
    candidateDelivery: bindCandidateDeliveryParticipant(),
    repoRemote: {
      resolve: (repositoryId) =>
        repositoryId === 'repo-1' ? { remoteUrl: repoUrl, defaultBranch: 'main' } : null,
    },
    mrEffects,
    mergeRequestFacts,
  })
})

afterAll(async () => {
  await suite.close()
})

function envelopeFor(prompt: string, missionId: string): string {
  const nonce = /<agent-result nonce="([^"]+)">/.exec(prompt)![1]!
  const actionRunRef = /"actionRunRef": "([^"]+)"/.exec(prompt)![1]!
  const inputDigest = /"inputDigest": "([^"]+)"/.exec(prompt)![1]!
  const capabilityId = /"capabilityId": "([^"]+)"/.exec(prompt)![1]!
  const result =
    capabilityId === 'change.implement'
      ? {
          capabilityId,
          summary: 'implemented the feature',
          requirementCoverage: automation.materializer
            .getRequirementManifest(missionId)!
            .files.map((f) => ({ itemRef: f.fileId, disposition: 'implemented' as const })),
        }
      : {
          capabilityId,
          summary: 'applied the review feedback',
          feedback: [
            {
              threadRef: lastSeededThreadRef,
              revision: lastSeededRevision,
              disposition: 'addressed' as const,
            },
          ],
        }
  const json = JSON.stringify({
    protocolVersion: 1,
    nonce,
    port: 'agent-result',
    actionRunRef,
    inputDigest,
    capabilityId,
    outcome: 'changed',
    result,
  })
  return `log noise\n<agent-result nonce="${nonce}">\n${json}\n</agent-result>\n`
}

let lastSeededThreadRef = ''
let lastSeededRevision = ''

/** staleness 快进：把 repositoryFactsRef cells 的 factsCollectedAt patch 回过去。 */
function expireMrFacts(missionId: string): void {
  const m = fx.store.getMission(missionId)!
  const ref = m.repositoryFactsRef
  if (ref === null) return
  const cells = fx.snapshots.getCells(ref)
  if (cells === null || cells['__mr.factsCollectedAt'] === undefined) return
  const merged = {
    ...cells,
    '__mr.factsCollectedAt': { state: 'known', value: '0', origin: 'test-expire' },
  }
  const id = ulid()
  fx.store.insertFactSnapshot({
    id,
    missionId,
    missionRevision: m.revision,
    capturedAt: new Date().toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(merged),
    refsJson: '{}',
    digest: canonicalDigest(merged),
    now: Date.now(),
  })
  fx.store.occUpdate(m.id, m.revision, m.epoch, { repositoryFactsRef: id })
}

interface Milestone {
  round: number
  kind: string
  selected: string
  status: string
}

/** 有界驱动：reconcile 直到谓词满足；记录里程碑序列供整体断言。 */
async function reconcileUntil(
  missionId: string,
  trail: Milestone[],
  pred: () => boolean,
  { max = 12, label = '' }: { max?: number; label?: string } = {},
): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (pred()) return
    const outcome = (await automation.reconcile(missionId)) as {
      kind: string
      selected?: { kind: string }
    }
    trail.push({
      round: trail.length + 1,
      kind: outcome.kind,
      selected: outcome.selected?.kind ?? '',
      status: fx.store.getMission(missionId)!.status,
    })
    // scripted Agent：发射后立即由测试落盘并结算 outcome（下一轮 collect）。
    const last = launches[launches.length - 1]
    if (last !== undefined && !outcomes.has(last.executionRef)) {
      actOnLaunch(last)
    }
  }
  if (!pred()) {
    const m = fx.store.getMission(missionId)
    const rejections = fx.db
      .select({
        s: developmentAgentAttempts.status,
        r: developmentAgentAttempts.rejectionJson,
      })
      .from(developmentAgentAttempts)
      .all()
      .map((row) => `${row.s}:${row.r ?? ''}`)
    throw new Error(
      `reconcileUntil(${label}) exhausted ${max} rounds; block=${m?.blockCode ?? ''}:${m?.blockDetail ?? ''}; rejections=${JSON.stringify(rejections)}; trail=${JSON.stringify(trail)}`,
    )
  }
}

let journeyMissionId = ''

function actOnLaunch(last: (typeof launches)[number]): void {
  if (last.capabilityId === 'change.implement') {
    writeFileSync(
      join(last.workspacePath, 'core', 'src', 'main', 'java', 'Greeting.java'),
      'class Greeting { String hello() { return "hi"; } }\n',
    )
  } else {
    // feedback 修复轮：按 review 意见改实现。
    writeFileSync(
      join(last.workspacePath, 'core', 'src', 'main', 'java', 'Greeting.java'),
      'class Greeting { String hello() { return "hello, reviewer"; } }\n',
    )
  }
  const verifySh = join(last.workspacePath, 'verify.sh')
  writeFileSync(verifySh, '#!/bin/sh\nmkdir -p reports\necho ok > reports/unit.txt\nexit 0\n')
  chmodSync(verifySh, 0o755)
  outcomes.set(last.executionRef, {
    kind: 'exited',
    executionRef: last.executionRef,
    taskStatus: 'done',
    resultText: envelopeFor(last.prompt, journeyMissionId),
    errorSummary: null,
    errorMessage: null,
  })
}

describe('rfc310 T109 — full mission journey on the system mock', () => {
  test('journey A: requirement → MR → feedback repair → reply → external merge → terminal', async () => {
    const missionId = await fx.launchDirect('t109-journey-a', 'Implement a greeting API in core.')
    journeyMissionId = missionId
    const stashed = await automation.materializer.stashDirectSubmission({
      missionId,
      submission: { title: 'Add feature', body: 'Implement a greeting API in core.', uploads: [] },
    })
    expect(stashed.ok).toBe(true)
    {
      const mission = fx.store.getMission(missionId)!
      fx.store.occUpdate(mission.id, mission.revision, mission.epoch, {
        policyId: (fx as unknown as Record<string, unknown>).t109PolicyId as string,
        policyRevision: 1,
      })
    }

    const trail: Milestone[] = []
    // 第一里程碑：走到 watching + MR opened（implement→verify→commit→push→MR）。
    await reconcileUntil(
      missionId,
      trail,
      () => fx.store.getMission(missionId)!.status === 'watching',
      { max: 12, label: 'to-watching' },
    )
    const branch = `aw/mission/${missionId}`
    {
      const snapshot = await suite.client.snapshot()
      const host = snapshot.codeHosts.find((h) => h.projectPath === PROJECT_PATH)!
      const mr = host.mergeRequests.find((m) => m.sourceBranch === branch)!
      expect(mr).toBeDefined()
      expect(mr.state).toBe('opened')
      expect(mr.title).toBe('Add feature')
    }
    // 里程碑序守卫：发射→verify→commit→push→MR 的顺序不可乱。
    const kinds = trail.map((t) => t.selected).filter((s) => s !== '')
    const firstIdx = (k: string) => kinds.findIndex((x) => x === k)
    expect(firstIdx('run-agent-action')).toBeGreaterThanOrEqual(0)
    expect(firstIdx('run-verification')).toBeGreaterThan(firstIdx('run-agent-action'))
    expect(firstIdx('commit-and-publish-candidate')).toBeGreaterThan(firstIdx('run-verification'))
    expect(firstIdx('ensure-merge-request')).toBeGreaterThan(
      firstIdx('commit-and-publish-candidate'),
    )

    // watching 后第一件事：真三读 fence 采 MR facts。
    await reconcileUntil(
      missionId,
      trail,
      () => {
        const ref = fx.store.getMission(missionId)!.repositoryFactsRef
        return ref !== null && fx.snapshots.getCells(ref)?.['__mr.factsCollectedAt'] !== undefined
      },
      { max: 4, label: 'first-facts' },
    )

    // mock 侧人类 reviewer 在 mission 的 MR 上留 unresolved thread（mock 的
    // 缺省 number 指向 seed 初始 MR，必须显式锚定 mission MR）。
    const missionMrNumber = await (async () => {
      const snapshot = await suite.client.snapshot()
      const host = snapshot.codeHosts.find((h) => h.projectPath === PROJECT_PATH)!
      return host.mergeRequests.find((m) => m.sourceBranch === branch)!.number
    })()
    await suite.client.mutateCodeHost({
      kind: 'add-review-comment',
      provider: 'gitlab',
      projectPath: PROJECT_PATH,
      number: missionMrNumber,
      body: 'Please greet the reviewer properly.',
      actor: { username: 'human-reviewer' },
    })

    // facts 过期 → 再采 → 台账 selectable → policy 路由 feedback.apply →
    // 「Agent」修复 → verify/commit/push 第二轮 → reply 真回帖。
    expireMrFacts(missionId)
    await reconcileUntil(missionId, trail, () => fx.store.listFeedback(missionId).length > 0, {
      max: 4,
      label: 'ledger-populated',
    })
    // ledger 的 threadRef/revision 是平台侧真采集的产物——以它为准喂 envelope。
    {
      const row = fx.store.listFeedback(missionId)[0]!
      lastSeededThreadRef = row.threadRef
      lastSeededRevision = row.revision
    }
    await reconcileUntil(
      missionId,
      trail,
      () => fx.store.listFeedback(missionId).some((r) => r.state === 'addressed'),
      { max: 14, label: 'feedback-applied-and-replied' },
    )

    // 真回帖落在 mock：review comments 里出现平台回复（self marker 可辨识）。
    {
      const snapshot = await suite.client.snapshot()
      const host = snapshot.codeHosts.find((h) => h.projectPath === PROJECT_PATH)!
      const mr = host.mergeRequests.find((m) => m.sourceBranch === branch)!
      const allComments = mr.reviewComments.map((c) => c.body)
      expect(allComments.some((b) => b.includes(`aw-self:${missionId}`))).toBe(true)
    }

    // 外部 merge（人类行为）→ facts 过期再采 → guard mark-terminal。
    await suite.client.mutateCodeHost({
      kind: 'set-mr-state',
      provider: 'gitlab',
      projectPath: PROJECT_PATH,
      number: missionMrNumber,
      state: 'merged',
    })
    expireMrFacts(missionId)
    await reconcileUntil(
      missionId,
      trail,
      () => fx.store.getMission(missionId)!.status === 'merged',
      { max: 6, label: 'to-terminal' },
    )

    const final = fx.store.getMission(missionId)!
    expect(final.status).toBe('merged')
    expect(final.terminalKind).toBe('merged')
    expect(final.currentActionRunId).toBeNull()
    // active claim 已释放（terminal 结算的一部分）。
    const claim = fx.store.findMrClaim({
      codeHostEndpointRef: 'gitlab',
      stableProjectRef: PROJECT_PATH,
      mrIid: final.adoptedMrRef ?? '',
    })
    if (claim !== null) expect(claim.state).not.toBe('active')
    // effect 台账零悬挂：commit/push/mr-ensure/mr-reply 全部结算。
    expect(fx.store.listUnsettledEffects(missionId)).toEqual([])

    // MR 分支上第二轮修复真实到达 remote（reply 前必须先 push 修复）。
    const checkout = mkdtempSync(join(tmpdir(), 'rfc310-t109-verify-'))
    git(checkout, 'clone', '-q', '--branch', branch, repoUrl, 'pushed')
    const content = await Bun.file(
      join(checkout, 'pushed', 'core', 'src', 'main', 'java', 'Greeting.java'),
    ).text()
    expect(content).toContain('hello, reviewer')
  })

  test('journey B: adopt an externally-opened MR, then external merge settles it', async () => {
    // 外部作者：真 git 建分支推到 mock remote，再经 code-host API 开 MR。
    const externalBranch = 'external/feature-x'
    {
      const authorClone = mkdtempSync(join(tmpdir(), 'rfc310-t109-external-'))
      git(authorClone, 'clone', '-q', repoUrl, 'work')
      const work = join(authorClone, 'work')
      git(work, 'checkout', '-q', '-b', externalBranch)
      writeFileSync(join(work, 'external.md'), 'external work\n')
      git(work, 'add', 'external.md')
      git(
        work,
        '-c',
        'user.email=ext@example.com',
        '-c',
        'user.name=Ext',
        'commit',
        '-q',
        '-m',
        'external: feature-x',
      )
      git(work, 'push', '-q', 'origin', externalBranch)
    }
    const seeded = await mrEffects.ensure('repo-1', {
      missionId: 'external-author',
      sourceBranch: externalBranch,
      targetBranch: 'main',
      title: 'External feature X',
    })
    if (!seeded.ok) throw new Error(`seed external MR failed: ${seeded.detail}`)
    const mrIid = seeded.mr.mrRef

    const adopted = await adoptActiveMr(
      {
        store: fx.store,
        cutoverStore: createSqliteCutoverStore(fx.db),
        ports: { mrEffects },
        now: () => Date.now(),
        mintId: () => ulid(),
      },
      {
        repositoryId: 'repo-1',
        mrIid,
        codeHostEndpointRef: 'gitlab',
        stableProjectRef: PROJECT_PATH,
        employee: { id: fx.employeeId, revision: 1 },
        policy: { id: fx.policyId, revision: 1 },
        legacyWorkItemId: 'legacy-wi-1',
        legacyRoundId: null,
        actorUserId: null,
      },
    )
    expect(adopted.ok).toBe(true)
    if (!adopted.ok) return
    expect(adopted.terminal).toBeNull()
    const missionId = adopted.missionId
    expect(fx.store.getMission(missionId)!.status).toBe('watching')

    // 外部 merged → adopt mission 也以 authoritative terminal 收场。
    await suite.client.mutateCodeHost({
      kind: 'set-mr-state',
      provider: 'gitlab',
      projectPath: PROJECT_PATH,
      number: Number(mrIid),
      state: 'merged',
    })
    const trail: Milestone[] = []
    journeyMissionId = missionId
    await reconcileUntil(
      missionId,
      trail,
      () => fx.store.getMission(missionId)!.status === 'merged',
      { max: 6, label: 'adopt-to-terminal' },
    )
    const final = fx.store.getMission(missionId)!
    expect(final.terminalKind).toBe('merged')
    expect(fx.store.listUnsettledEffects(missionId)).toEqual([])
  })
})
