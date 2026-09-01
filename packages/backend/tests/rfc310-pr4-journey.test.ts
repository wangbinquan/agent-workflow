// RFC-310 PR-4 —— 收口 journey：composition 生产装配下的 attempt 全链。
//
// 除 task-execution runner 外全部真件（EvidenceStore/actionWorkspace/
// protectedSnapshot/workspaceValidator/attemptContext/actionTemplates/真 git
// candidate 派生）；「Agent 行为」由测试直接对真 workspace 落盘模拟——检测的
// 对象是文件系统状态，与进程内/子进程写入不可区分（真子进程攻击面已由
// PR-0 detect-rollback probe 与 fork J 的 execution-host 测试锁定）。
//
// 锁三件事：
//   1. 正向：launch → 真 workspace（baseline clone + evidence mount）→ agent
//      写业务文件 + envelope → 真 validator changed → 真 git candidate
//      （treeOid/changed 对拍）→ 诚实 action-stage-complete 静止态；
//   2. 攻击+回退（T43/T50 接线级）：agent 写 .git 与 evidence → 快照对拍检出
//      boundary → attempt discarded → fresh rerun 的新 workspace 从 exact
//      baseline byte-identical 重建（businessTreeDigest 相等）→ 第二轮干净
//      changed 正常结算；violation 现场绝不产生 candidate；
//   3. no-change 相对 action baseline clean 的合法性。

import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { composeDevelopmentAutomation } from '../src/modules/development-automation/composition'
import type { DevelopmentAutomationModule } from '../src/modules/development-automation/composition'
import type {
  AgentActionLauncherPort,
  AgentExecutionSnapshot,
} from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { bindChangeCandidateParticipant } from '../src/modules/source-control/composition'
import { cachedRepos } from '../src/db/schema'
import { buildPr3Fixture, PR3_JAVA_CELLS, type Pr3Fixture } from './helpers/rfc310Pr3Fixture'

setDefaultTimeout(120_000)

const HOME = mkdtempSync(resolve(tmpdir(), 'rfc310-pr4-journey-'))

let fx: Pr3Fixture
let automation: DevelopmentAutomationModule
const launches: { executionRef: string; workspacePath: string; prompt: string }[] = []
const outcomes = new Map<string, AgentExecutionSnapshot>()

const scripted: AgentActionLauncherPort = {
  async launch(input) {
    const executionRef = `jexec-${launches.length + 1}`
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
  fx = await buildPr3Fixture()
  const repoPath = join(HOME, 'repo-src')
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '-q')
  writeFileSync(join(repoPath, 'README.md'), '# baseline\n')
  git(repoPath, 'add', 'README.md')
  git(repoPath, '-c', 'user.email=j4@test', '-c', 'user.name=j4', 'commit', '-q', '-m', 'base')
  fx.db
    .insert(cachedRepos)
    .values({
      id: 'repo-1',
      urlHash: 'j4deadbe',
      localPath: repoPath,
      lastFetchedAt: Date.now(),
      createdAt: Date.now(),
    })
    .run()
  automation = composeDevelopmentAutomation({
    db: fx.db,
    appHome: HOME,
    agentLauncher: scripted,
    changeCandidate: bindChangeCandidateParticipant(),
  })
})

/** repositoryFacts 未接线（PR-5）：以既有 requirement 快照通道预置 repo cells。 */
async function seedRepositoryCells(missionId: string): Promise<void> {
  const { createSqliteMissionStore } =
    await import('../src/modules/development-automation/infrastructure/sqliteMissionStore')
  const { canonicalStringify, canonicalDigest } =
    await import('../src/modules/development-automation/domain/canonicalJson')
  const store = createSqliteMissionStore(fx.db)
  const mission = store.getMission(missionId)!
  const base =
    mission.requirementBundleRef === null
      ? {}
      : ((await fx.snapshots.getCells(mission.requirementBundleRef)) ?? {})
  const merged = { ...base, ...structuredClone(PR3_JAVA_CELLS) }
  const id = `snap-repo-${missionId.slice(-6)}`
  store.insertFactSnapshot({
    id,
    missionId,
    missionRevision: mission.revision,
    capturedAt: new Date().toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(merged as never),
    refsJson: canonicalStringify({ kind: 'test-repo-facts' }),
    digest: canonicalDigest(merged as never),
    now: Date.now(),
  })
  store.occUpdate(mission.id, mission.revision, mission.epoch, { requirementBundleRef: id })
}

async function launchMissionToAction(key: string): Promise<{
  missionId: string
  actionRunId: string
  workspacePath: string
  prompt: string
}> {
  const missionId = await fx.launchDirect(key)
  const stashed = await automation.materializer.stashDirectSubmission({
    missionId,
    submission: { title: 'Add feature', body: 'do the thing', uploads: [] },
  })
  expect(stashed.ok).toBe(true)
  await automation.reconcile(missionId) // materialize requirement bundle
  await seedRepositoryCells(missionId)
  const launched = await automation.reconcile(missionId)
  expect(launched.kind === 'decided' && launched.handled).toBe('action-launched')
  const mission = fx.store.getMission(missionId)!
  const last = launches[launches.length - 1]!
  return {
    missionId,
    actionRunId: mission.currentActionRunId!,
    workspacePath: last.workspacePath,
    prompt: last.prompt,
  }
}

async function envelopeFor(
  prompt: string,
  missionId: string,
  outcome: 'changed' | 'no-change',
): Promise<string> {
  const nonce = /<agent-result nonce="([^"]+)">/.exec(prompt)![1]!
  const actionRunRef = /"actionRunRef": "([^"]+)"/.exec(prompt)![1]!
  const inputDigest = /"inputDigest": "([^"]+)"/.exec(prompt)![1]!
  const manifest = (await automation.materializer.getRequirementManifest(missionId))!
  const body =
    outcome === 'changed'
      ? {
          capabilityId: 'change.implement',
          summary: 'implemented',
          requirementCoverage: manifest.files.map((f) => ({
            itemRef: f.fileId,
            disposition: 'implemented' as const,
          })),
        }
      : { reason: 'already-satisfied', summary: 'nothing to do' }
  const json = JSON.stringify({
    protocolVersion: 1,
    nonce,
    port: 'agent-result',
    actionRunRef,
    inputDigest,
    capabilityId: 'change.implement',
    outcome,
    result: body,
  })
  return `agent log line\n<agent-result nonce="${nonce}">\n${json}\n</agent-result>\n`
}

function exited(executionRef: string, resultText: string): AgentExecutionSnapshot {
  return {
    kind: 'exited',
    executionRef,
    taskStatus: 'done',
    resultText,
    errorSummary: null,
    errorMessage: null,
  }
}

describe('rfc310 pr4 journey — real workspace / validator / candidate chain', () => {
  test('positive: workspace materialized with evidence mount; changed outcome derives a real git candidate', async () => {
    const { missionId, actionRunId, workspacePath, prompt } =
      await launchMissionToAction('j4-positive-1')

    // 真 workspace：baseline 内容 + requirement evidence mount 就位。
    expect(readFileSync(join(workspacePath, 'README.md'), 'utf8')).toBe('# baseline\n')
    const manifest = (await automation.materializer.getRequirementManifest(missionId))!
    const mountDir = join(workspacePath, '.agent-workflow', 'inputs', 'requirements')
    expect(manifest.files.length).toBeGreaterThan(0)
    expect(readFileSync(join(mountDir, manifest.bundleId, 'body.md'), 'utf8')).toBe('do the thing')

    // 「agent」写业务文件并交出合法 envelope。
    mkdirSync(join(workspacePath, 'src'), { recursive: true })
    writeFileSync(join(workspacePath, 'src', 'feature.ts'), 'export const feature = 1\n')
    const ref = launches[launches.length - 1]!.executionRef
    outcomes.set(ref, exited(ref, await envelopeFor(prompt, missionId, 'changed')))

    const collected = await automation.reconcile(missionId)
    expect(collected.kind).toBe('action-collect')
    if (collected.kind !== 'action-collect') return
    expect(collected.result).toMatchObject({
      kind: 'action-collected',
      disposition: 'validated-changed',
    })

    const attempt = fx.store.listAttempts(actionRunId)[0]!
    expect(attempt.status).toBe('validated')
    expect(attempt.outcomeRef).toMatch(/^[0-9a-f]{64}$/)
    // PR-5 起 changed 不再打 stage block：candidateState='derived' 落 cells，
    // mission 保持 working，发布链（missionDeliveryChain）下轮接管。
    const mission = fx.store.getMission(missionId)!
    expect(mission.status).toBe('working')
    const cells = (await fx.snapshots.getCells(mission.requirementBundleRef!))!
    expect(cells['__action.candidateRef']).toMatchObject({ state: 'known' })
    expect(cells['__action.candidateState']).toMatchObject({ state: 'known', value: 'derived' })
    expect(cells['__action.candidateTreeOid']).toMatchObject({ state: 'known' })
    expect(cells['__action.runId']).toMatchObject({ state: 'known', value: actionRunId })
  })

  test('attack + rollback: .git/evidence writes are detected, attempt discarded, fresh workspace byte-identical', async () => {
    const first = await launchMissionToAction('j4-attack-1')

    // 攻击面：写 Git metadata + 篡改 evidence mount + 顺手写业务文件。
    writeFileSync(join(first.workspacePath, '.git', 'attack-marker'), 'evil\n')
    const manifest = (await automation.materializer.getRequirementManifest(first.missionId))!
    writeFileSync(
      join(
        first.workspacePath,
        '.agent-workflow',
        'inputs',
        'requirements',
        manifest.bundleId,
        'body.md',
      ),
      'tampered requirement\n',
    )
    writeFileSync(join(first.workspacePath, 'innocent.ts'), 'export const x = 1\n')
    const ref1 = launches[launches.length - 1]!.executionRef
    outcomes.set(ref1, exited(ref1, await envelopeFor(first.prompt, first.missionId, 'changed')))

    const collected = await automation.reconcile(first.missionId)
    expect(collected.kind).toBe('action-collect')
    if (collected.kind !== 'action-collect') return
    // boundary 检出 → 整树废弃 + fresh rerun（same-session 禁止）。
    expect(collected.result).toMatchObject({ kind: 'action-retry', rerunSeq: 1 })

    const attempts = fx.store.listAttempts(first.actionRunId)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.status).toBe('discarded')
    const rejection = JSON.parse(attempts[0]!.rejectionJson!) as { code: string }
    expect(['protected-root-write']).toContain(rejection.code)
    // violation 现场绝不产生 candidate。
    expect(attempts[0]!.outcomeRef).toBeNull()

    // fresh workspace 是新目录、从 exact baseline byte-identical 重建
    // （pre-state blob 里冻结的 businessTreeDigest 两轮相等）。
    const second = launches[launches.length - 1]!
    expect(second.workspacePath).not.toBe(first.workspacePath)
    const preOf = (ref: string | null): { businessTreeDigest?: string } =>
      JSON.parse((ref !== null && automationContextLoad(ref)) || '{}') as {
        businessTreeDigest?: string
      }
    const pre1 = preOf(attempts[0]!.preSnapshotRef)
    const pre2 = preOf(attempts[1]!.preSnapshotRef)
    expect(pre1.businessTreeDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(pre2.businessTreeDigest).toBe(pre1.businessTreeDigest)
    // 新 nonce、同 inputDigest（fresh 合同）。
    expect(attempts[1]!.nonceDigest).not.toBe(attempts[0]!.nonceDigest)
    expect(attempts[1]!.inputDigest).toBe(attempts[0]!.inputDigest)

    // 第二轮干净实现 → 正常结算。
    writeFileSync(join(second.workspacePath, 'clean.ts'), 'export const ok = 1\n')
    outcomes.set(
      second.executionRef,
      exited(second.executionRef, await envelopeFor(second.prompt, first.missionId, 'changed')),
    )
    const settled = await automation.reconcile(first.missionId)
    expect(settled.kind).toBe('action-collect')
    if (settled.kind !== 'action-collect') return
    expect(settled.result).toMatchObject({
      kind: 'action-collected',
      disposition: 'validated-changed',
    })
    expect(fx.store.listAttempts(first.actionRunId)[1]!.status).toBe('validated')
  })

  test('no-change against the action baseline is legal and settles honestly', async () => {
    const { missionId, actionRunId, prompt } = await launchMissionToAction('j4-nochange-1')
    const ref = launches[launches.length - 1]!.executionRef
    outcomes.set(ref, exited(ref, await envelopeFor(prompt, missionId, 'no-change')))
    const collected = await automation.reconcile(missionId)
    expect(collected.kind).toBe('action-collect')
    if (collected.kind !== 'action-collect') return
    expect(collected.result).toMatchObject({
      kind: 'action-collected',
      disposition: 'validated-no-change',
    })
    expect(fx.store.listAttempts(actionRunId)[0]!.status).toBe('validated')
    expect(fx.store.listAttempts(actionRunId)[0]!.outcomeRef).toBeNull()
    expect(fx.store.getMission(missionId)!.blockCode).toBe('action-stage-complete:no-change')
  })
})

/** attemptContext 的读侧（journey 断言 pre-state blob 用；与生产同一 evidence 池）。 */
function automationContextLoad(ref: string): string | null {
  const path = join(HOME, 'evidence', 'blobs', ref.slice(0, 2), ref)
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
