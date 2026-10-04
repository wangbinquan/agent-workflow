// RFC-310 PR-7b T78 —— conflict repair 的 Agent 执行面（design §8.5 全链）。
//
// 生产装配（composeDevelopmentAutomation）+ 真 git + 真 bare remote，只有
// Agent 进程是桩——「Agent 行为」由测试直接对真 workspace 落盘模拟，检测对象
// 是文件系统状态，与子进程写入不可区分（同 rfc310-pr4-journey 的既定边界）。
//
// 锁 design §8.5 的六步：
//   ①②平台自己 freeze S/T 并跑 merge mechanics，冲突集由 git 说了算；
//   ③交给 Agent 的现场只允许改冲突集——改别的文件必须被判 boundary，且
//     现场整树废弃（绝不带着越界改动继续发布）；
//   ④⑤解完由平台用自己的 index 产**双 parent** merge commit，并对着 S 做
//     exact-head CAS push；
//   ⑥S 变了就是现场过期：CAS 拒绝、不覆盖。
// 另锁两条只在生产才会暴露的接线：merge commit push 后 `__delivery.pushedSha`
// 必须前进（否则后续 fast-forward 发布拿旧 sha 当 CAS 期望值，必推不上去），
// 以及 `__mr.factsCollectedAt` 归零（head 变了，mr.* 全部要重采）。

import { beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { composeDevelopmentAutomation } from '../src/modules/development-automation/composition'
import type { DevelopmentAutomationModule } from '../src/modules/development-automation/composition'
import type {
  AgentActionLauncherPort,
  AgentExecutionSnapshot,
} from '../src/modules/development-automation/application/ports/reconcilerPorts'
import {
  canonicalDigest,
  canonicalStringify,
} from '../src/modules/development-automation/domain/canonicalJson'
import type { FactCellValue } from '../src/modules/development-automation/domain/facts'
import type { FactCell } from '../src/modules/development-automation/domain/factCell'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
  bindConflictMergeParticipant,
} from '../src/modules/source-control/composition'
import { cachedRepos } from '../src/db/schema'
import { buildPr3Fixture, type ProviderPr3Fixture } from './helpers/rfc310Pr3Fixture'
import { describeEachProvider } from './helpers/eachProvider'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { requirementBundlePath } from '@agent-workflow/shared'
import { createRequirementBundleRefPersistence } from '../src/modules/development-automation/infrastructure/requirementBundleRefPersistence'
import {
  heldEffect,
  enteredBeforeOutcome,
  OpaqueActionEffects,
  OpaqueCandidateDelivery,
  OpaqueConflictEffects,
  OpaqueContentFactory,
  OpaqueEvidenceArtifacts,
  WorkspaceReferenceCodec,
  type WorkspaceEffectGate,
} from './helpers/rfc370ConflictWorkspaceEffects'

setDefaultTimeout(120_000)

// RFC-359 AC-6（收尾）：本套件迁到双引擎。**每条泳道要有自己的进程侧世界**（一个 appHome、
// 一套真 git 仓 + bare remote），否则两条泳道会在同一块盘上互相推分支；库侧相反——
// `describeEachProvider` 每个用例前会把 PG 整库快照回滚，所以库夹具必须**每个用例重建**。
let HOME = ''

/**
 * 每个用例一条自己的 source 分支。共用一条会让「远端 head 被推动」那一条把
 * 后跑的用例一起带红——`--randomize` 下就是间歇性的、且红在别人身上。
 */
function branchOf(missionId: string): string {
  return `aw/mission/${missionId}`
}

let fx: ProviderPr3Fixture
let automation: DevelopmentAutomationModule
let repoPath: string
let remotePath: string
let sourceSha: string
let targetSha: string

const launches: { executionRef: string; workspacePath: string; prompt: string }[] = []
const outcomes = new Map<string, AgentExecutionSnapshot>()

const scripted: AgentActionLauncherPort = {
  async launch(input) {
    const executionRef = `t78exec-${launches.length + 1}`
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
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't78',
      GIT_AUTHOR_EMAIL: 't78@test',
      GIT_COMMITTER_NAME: 't78',
      GIT_COMMITTER_EMAIL: 't78@test',
    },
  })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
  }
  return proc.stdout.toString()
}

/** 进程侧的一次性世界：真 git 仓（source / target 各改同一行 = 真冲突）+ 真 bare remote。 */
function startLaneWorld(): void {
  HOME = mkdtempSync(resolve(tmpdir(), 'rfc310-t78-home-'))
  // base → source 分支与 target 分支在同一行各改一次 = 真冲突。
  repoPath = join(HOME, 'repo-src')
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '-q', '-b', 'main')
  writeFileSync(join(repoPath, 'X.txt'), 'line1\nline2\n')
  writeFileSync(join(repoPath, 'other.txt'), 'other\n')
  git(repoPath, 'add', '-A')
  git(repoPath, 'commit', '-q', '-m', 'base')

  git(repoPath, 'checkout', '-q', '-b', 'source-work')
  writeFileSync(join(repoPath, 'X.txt'), 'line1-from-source\nline2\n')
  git(repoPath, 'add', '-A')
  git(repoPath, 'commit', '-q', '-m', 'source edit')
  sourceSha = git(repoPath, 'rev-parse', 'HEAD').trim()

  git(repoPath, 'checkout', '-q', 'main')
  writeFileSync(join(repoPath, 'X.txt'), 'line1-from-target\nline2\n')
  git(repoPath, 'add', '-A')
  git(repoPath, 'commit', '-q', '-m', 'target edit')
  targetSha = git(repoPath, 'rev-parse', 'HEAD').trim()

  // 真 bare remote：MR 的 source 分支已经在上面，head 就是 S。
  remotePath = join(HOME, 'remote.git')
  mkdirSync(remotePath, { recursive: true })
  git(remotePath, 'init', '-q', '--bare')
}

/** 库侧夹具：**每个用例**重建（PG 泳道每个用例前会整库快照回滚）。 */
async function seedLaneDatabase(
  db: ProviderNeutralDatabase,
  conflictRetryDefaults?: { readonly sameSession: number; readonly freshSession: number },
): Promise<void> {
  launches.length = 0
  outcomes.clear()
  fx = await buildPr3Fixture({
    db,
    conflictRoute: true,
    conflictPolicy: { mode: 'repair', maxRepairAttempts: 2 },
    ...(conflictRetryDefaults === undefined ? {} : { conflictRetryDefaults }),
    rules: [
      {
        ruleId: 'repair-on-conflict',
        when: [{ kind: 'boolean-is', fact: 'mr.conflict', value: true }],
        capabilityId: 'conflict.repair',
      },
    ],
  })
  await fx.db.insert(cachedRepos).values({
    id: 'repo-1',
    urlHash: 't78dead',
    localPath: repoPath,
    lastFetchedAt: Date.now(),
    createdAt: Date.now(),
  })

  automation = composeDevelopmentAutomation({
    db: fx.db,
    appHome: HOME,
    agentLauncher: scripted,
    changeCandidate: bindChangeCandidateParticipant(),
    conflictMerge: bindConflictMergeParticipant(),
    candidateDelivery: bindCandidateDeliveryParticipant(),
    repoRemote: {
      resolve: () => ({ remoteUrl: remotePath, defaultBranch: 'main' }),
    },
  })
}

function cell(value: FactCellValue): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision: 't78' }
}

/** conflict 已被采集到、MR 在跑、source 分支已知的 watching Mission。 */
async function seedConflictedMission(missionId: string): Promise<void> {
  const now = Date.now()
  await fx.store.createMission({
    id: missionId,
    revision: 0,
    epoch: 0,
    status: 'watching',
    automationMode: 'active',
    transitionFence: 'none',
    repositoryId: 'repo-1',
    sourceKind: 'direct',
    sourceContentDigest: 'a'.repeat(64),
    requestedSourceKey: null,
    externalId: null,
    resolvedSourceKey: null,
    resolvedAdapterId: null,
    resolvedAdapterRevision: null,
    deliveryKind: 'create-merge-request',
    deliveryTargetRef: null,
    deliverySourceBranch: branchOf(missionId),
    adoptedMrRef: null,
    assignmentId: null,
    employeeId: fx.employeeId,
    employeeRevision: 1,
    policyId: fx.policyId,
    policyRevision: 1,
    requirementBundleRef: null,
    repositoryFactsRef: null,
    uploadPlanRef: null,
    uploadPlacementRef: null,
    uploadPublicationRef: null,
    mrClaimId: `claim-${missionId}`,
    currentActionRunId: null,
    readinessJson: null,
    blockCode: null,
    blockDetail: null,
    terminalKind: null,
    terminalUploadFulfillment: null,
    terminalAt: null,
    launchIdempotencyKey: `idem-${missionId}`,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  })
  const cells = {
    'requirement.bundleComplete': cell(true),
    'mr.exists': cell(true),
    'mr.draft': cell(false),
    'mr.conflict': cell(true),
    'mr.mergeable': cell('no'),
    '__mr.ref': cell('11'),
    '__mr.headSha': cell(sourceSha),
    '__mr.targetSha': cell(targetSha),
    '__mr.factsCollectedAt': cell(String(Date.now())),
  }
  const snapId = `snap-${missionId}`
  await fx.store.insertFactSnapshot({
    id: snapId,
    missionId,
    missionRevision: 0,
    capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(cells),
    refsJson: '{}',
    digest: canonicalDigest(cells),
    now,
  })
  const mission = (await fx.store.getMission(missionId))!
  await fx.store.occUpdate(missionId, mission.revision, mission.epoch, {
    requirementBundleRef: snapId,
  })
  // 远端上这条 MR source 分支的 head 就是 S（本用例私有的 ref）。
  git(repoPath, 'push', '-q', remotePath, `${sourceSha}:refs/heads/${branchOf(missionId)}`)
}

function conflictEnvelope(prompt: string, conflictRefs: readonly string[]): string {
  const nonce = /<agent-result nonce="([^"]+)">/.exec(prompt)![1]!
  const actionRunRef = /"actionRunRef": "([^"]+)"/.exec(prompt)![1]!
  const inputDigest = /"inputDigest": "([^"]+)"/.exec(prompt)![1]!
  const json = JSON.stringify({
    protocolVersion: 1,
    nonce,
    port: 'agent-result',
    actionRunRef,
    inputDigest,
    capabilityId: 'conflict.repair',
    outcome: 'changed',
    result: {
      capabilityId: 'conflict.repair',
      summary: 'resolved the overlapping edit',
      conflictRefs: [...conflictRefs],
    },
  })
  return `agent log\n<agent-result nonce="${nonce}">\n${json}\n</agent-result>\n`
}

function exited(
  executionRef: string,
  resultText: string,
): Extract<AgentExecutionSnapshot, { kind: 'exited' }> {
  return {
    kind: 'exited',
    executionRef,
    taskStatus: 'done',
    resultText,
    errorSummary: null,
    errorMessage: null,
  }
}

/** 派出 conflict.repair 动作，回传现场与 prompt。 */
async function dispatchRepair(
  missionId: string,
): Promise<{ workspacePath: string; prompt: string; executionRef: string }> {
  await seedConflictedMission(missionId)
  const launched = await automation.reconcile(missionId)
  // 失败时把 block code 一起亮出来——「没派出去」有十几种原因，光看
  // action-launch-failed 排查不了。
  expect({
    handled: launched.kind === 'decided' ? launched.handled : launched.kind,
    blockCode: (await fx.store.getMission(missionId))?.blockCode ?? null,
  }).toEqual({ handled: 'action-launched', blockCode: null })
  const last = launches[launches.length - 1]!
  return last
}

describeEachProvider(
  'rfc310 pr7b T78 — conflict repair agent surface (real git + real remote)',
  (harness) => {
    beforeAll(() => {
      startLaneWorld()
    })
    // 注册顺序即执行顺序：harness 自己的 `beforeEach`（PG 整库回滚）在 body 之前就登记了。
    beforeEach(async () => {
      await seedLaneDatabase(harness.db)
    }, 120_000)

    test('resolved conflict set becomes a two-parent merge commit pushed with exact-head CAS', async () => {
      const missionId = 'm-t78-happy'
      const { workspacePath, prompt, executionRef } = await dispatchRepair(missionId)

      // ①②现场是真的冲突态：markers 在、两侧内容都在、MERGE_HEAD 在。
      const conflicted = readFileSync(join(workspacePath, 'X.txt'), 'utf8')
      expect(conflicted).toContain('<<<<<<<')
      expect(conflicted).toContain('line1-from-source')
      expect(conflicted).toContain('line1-from-target')
      // ③prompt 明确告诉 Agent 边界（不碰 Git、只解冲突集）。
      expect(prompt).toContain('Resolve only the pinned conflict work set')

      // 「Agent」解冲突。
      writeFileSync(join(workspacePath, 'X.txt'), 'line1-merged\nline2\n')
      outcomes.set(executionRef, exited(executionRef, conflictEnvelope(prompt, ['X.txt'])))

      const collected = await automation.reconcile(missionId)
      expect(collected.kind).toBe('action-collect')
      if (collected.kind !== 'action-collect') return
      expect(collected.result).toMatchObject({
        kind: 'action-collected',
        disposition: 'validated-changed',
      })

      // ④⑤远端 source 分支已经前进到平台产出的 merge commit，两 parent = S/T。
      const remoteHead = git(repoPath, 'ls-remote', remotePath, `refs/heads/${branchOf(missionId)}`)
        .split('\t')[0]!
        .trim()
      expect(remoteHead).not.toBe(sourceSha)
      git(repoPath, 'fetch', '-q', remotePath, remoteHead)
      const body = git(repoPath, 'cat-file', '-p', remoteHead)
      const parents = [...body.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1])
      expect(parents).toEqual([sourceSha, targetSha])
      expect(git(repoPath, 'show', `${remoteHead}:X.txt`)).toBe('line1-merged\nline2\n')

      // candidate 那条路没被误用：merge 不是 baseline 上的 overlay diff。
      const mission = (await fx.store.getMission(missionId))!
      const cells = (await fx.snapshots.getCells(mission.requirementBundleRef!))!
      expect(cells['__action.candidateRef']).toBeUndefined()
      expect(cells['__conflict.mergedSha']).toMatchObject({ state: 'known', value: remoteHead })
      // 后续 fast-forward 发布的 CAS 期望值必须已经前进到 merge commit。
      expect(cells['__delivery.pushedSha']).toMatchObject({ state: 'known', value: remoteHead })
      expect(cells['__delivery.sourceBranch']).toMatchObject({
        state: 'known',
        value: branchOf(missionId),
      })
      // head 变了 ⇒ MR facts 显式判过期，下轮必须重采（§8.5 步骤 6 同款纪律）。
      expect(cells['__mr.factsCollectedAt']).toMatchObject({ state: 'known', value: '0' })
      expect(mission.blockCode).toBeNull()
    })

    test('an edit outside the pinned conflict set is a boundary violation and never publishes', async () => {
      const missionId = 'm-t78-boundary'
      const { workspacePath, prompt, executionRef } = await dispatchRepair(missionId)
      const beforeHead = git(repoPath, 'ls-remote', remotePath, `refs/heads/${branchOf(missionId)}`)
        .split('\t')[0]!
        .trim()

      // 解了冲突，但顺手改了冲突集之外的文件。
      writeFileSync(join(workspacePath, 'X.txt'), 'line1-merged\nline2\n')
      writeFileSync(join(workspacePath, 'other.txt'), 'sneaky\n')
      outcomes.set(executionRef, exited(executionRef, conflictEnvelope(prompt, ['X.txt'])))

      const collected = await automation.reconcile(missionId)
      expect(collected.kind).toBe('action-collect')
      if (collected.kind !== 'action-collect') return
      expect((collected.result as { kind: string }).kind).toBe('action-failed')

      // 拦截点必须是**平台自己的 workspace 对拍**（writablePrefixes = 冲突集），
      // 而不是等到 source-control 的 finish 才发现：前者是「Agent 越界」的诚实
      // 分级（boundary ⇒ 整树废弃），后者只是合并收不了口。
      const failedRun = (collected.result as { actionRunId: string }).actionRunId
      const attempts = await fx.store.listAttempts(failedRun)
      const last = attempts[attempts.length - 1]!
      expect(last.status).toBe('discarded')
      expect(JSON.parse(last.rejectionJson ?? '{}')).toMatchObject({
        code: 'write-outside-allowlist',
        paths: ['other.txt'],
      })
      // 远端纹丝不动：越界现场绝不产生发布。
      const afterHead = git(repoPath, 'ls-remote', remotePath, `refs/heads/${branchOf(missionId)}`)
        .split('\t')[0]!
        .trim()
      expect(afterHead).toBe(beforeHead)
    })

    test('a source head that moved under us is refused by CAS instead of overwritten', async () => {
      const missionId = 'm-t78-race'
      const { workspacePath, prompt, executionRef } = await dispatchRepair(missionId)

      // ⑥Agent 干活期间有人往 MR 的 source 分支推了东西：S 已经不是远端 head。
      const sideRepo = join(HOME, `side-${missionId}`)
      mkdirSync(sideRepo, { recursive: true })
      git(sideRepo, 'clone', '-q', remotePath, '.')
      git(sideRepo, 'checkout', '-q', branchOf(missionId))
      writeFileSync(join(sideRepo, 'human.txt'), 'human push\n')
      git(sideRepo, 'add', '-A')
      git(sideRepo, 'commit', '-q', '-m', 'human push')
      git(sideRepo, 'push', '-q', 'origin', branchOf(missionId))
      const humanHead = git(sideRepo, 'rev-parse', 'HEAD').trim()

      writeFileSync(join(workspacePath, 'X.txt'), 'line1-merged\nline2\n')
      outcomes.set(executionRef, exited(executionRef, conflictEnvelope(prompt, ['X.txt'])))

      const collected = await automation.reconcile(missionId)
      expect(collected.kind).toBe('action-collect')
      if (collected.kind !== 'action-collect') return
      expect(collected.result).toMatchObject({
        kind: 'action-failed',
        blockCode: 'conflict-head-changed',
      })
      // 别人的提交还在——平台没有覆盖它。
      const afterHead = git(repoPath, 'ls-remote', remotePath, `refs/heads/${branchOf(missionId)}`)
        .split('\t')[0]!
        .trim()
      expect(afterHead).toBe(humanHead)
    })
  },
)

// RFC-370: extend the original real Mission fixture, keeping every native T78 case above.
// New cases persist actual pre-state, reconstruct composition, and await creating-owner cleanup.
describeEachProvider(
  'RFC-370 opaque conflict scene — actual Mission and durable recovery',
  (harness) => {
    beforeAll(startLaneWorld)
    beforeEach(async () => {
      await seedLaneDatabase(harness.db, { sameSession: 0, freshSession: 1 })
    }, 120_000)

    function selectedWorld(conflictGate?: WorkspaceEffectGate, contentGate?: WorkspaceEffectGate) {
      const codec = new WorkspaceReferenceCodec()
      const contents = new OpaqueContentFactory(codec, contentGate)
      const action = new OpaqueActionEffects(codec, contents)
      const conflict = new OpaqueConflictEffects(codec, conflictGate)
      const evidence = new OpaqueEvidenceArtifacts(codec, join(HOME, 'selected-evidence'))
      const compose = () =>
        composeDevelopmentAutomation({
          db: fx.db,
          appHome: codec.reference(HOME),
          evidenceArtifacts: evidence,
          evidenceDocumentCommands: evidence.documentCommands,
          automationWorkspaceEffects: contents,
          actionWorkspaceEffects: action,
          agentLauncher: scripted,
          changeCandidate: bindChangeCandidateParticipant(),
          conflictMerge: bindConflictMergeParticipant({ effects: conflict }),
          candidateDelivery: new OpaqueCandidateDelivery(codec),
          repoRemote: { resolve: () => ({ remoteUrl: remotePath, defaultBranch: 'main' }) },
        })
      automation = compose()
      return { codec, contents, action, conflict, evidence, compose }
    }

    async function addActualRequirement(missionId: string, evidence: OpaqueEvidenceArtifacts) {
      const bodyRoot = join(HOME, `body-${missionId}`)
      mkdirSync(bodyRoot)
      const bytes = new Uint8Array([0, 255, 65, 10])
      writeFileSync(join(bodyRoot, 'body.bin'), bytes)
      const budget = { maxFiles: 10, maxFileBytes: 4096, maxTotalBytes: 8192 }
      const body = await evidence.importStagedTree(bodyRoot, budget)
      const core = {
        schemaVersion: 1,
        bundleId: body.bundleId,
        source: { kind: 'direct', submissionId: `submission-${missionId}` },
        title: 'actual binary requirement',
        fetchedAt: new Date().toISOString(),
        complete: true,
        files: [
          {
            fileId: 'body',
            ordinal: 0,
            relativePath: 'body.bin',
            role: 'requirement',
            mediaType: 'application/octet-stream',
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            redaction: 'none',
            repositoryPlacement: null,
          },
        ],
        totals: { files: 1, bytes: bytes.length },
        writebackRef: null,
      }
      const manifestDigest = canonicalDigest(core)
      const manifestRoot = join(HOME, `manifest-${missionId}`)
      mkdirSync(manifestRoot)
      writeFileSync(
        join(manifestRoot, 'requirement-manifest.json'),
        canonicalStringify({ ...core, manifestDigest }),
      )
      const manifest = await evidence.importStagedTree(manifestRoot, budget)
      await createRequirementBundleRefPersistence(fx.db).insert({
        id: `manifest-ref-${missionId}`,
        missionId,
        purpose: 'requirement-manifest',
        evidenceRef: manifest.bundleId,
        manifestDigest,
        fileCount: 1,
        totalBytes: manifest.totalBytes,
        retentionState: 'active',
        createdAt: Date.now(),
      })
      await fx.store.insertMissionSource({
        id: `source-${missionId}`,
        missionId,
        generation: 1,
        sourceKind: 'direct',
        externalId: null,
        adapterId: null,
        adapterRevision: null,
        sourceRevision: manifestDigest,
        bundleRef: body.bundleId,
        manifestDigest,
        fileCount: 1,
        totalBytes: bytes.length,
        state: 'materialized',
        createdAt: Date.now(),
      })
      return { bytes, mountPath: requirementBundlePath(body.bundleId), manifestDigest }
    }

    async function launchedAttempt(
      missionId: string,
      world: ReturnType<typeof selectedWorld>,
      withRequirement = false,
    ) {
      await seedConflictedMission(missionId)
      const requirement = withRequirement
        ? await addActualRequirement(missionId, world.evidence)
        : null
      const reconciled = await automation.reconcile(missionId)
      expect(reconciled).toMatchObject({ kind: 'decided', handled: 'action-launched' })
      const launch = launches[launches.length - 1]!
      const mission = (await fx.store.getMission(missionId))!
      expect(mission.blockCode).toBeNull()
      const attempts = await fx.store.listAttempts(mission.currentActionRunId!)
      expect(attempts).toHaveLength(1)
      const pre = JSON.parse(
        (await world.evidence.contexts.load(attempts[0]!.preSnapshotRef!))!,
      ) as Record<string, unknown>
      expect(pre).toMatchObject({
        capabilityId: 'conflict.repair',
        workspacePath: launch.workspacePath,
        conflict: { sourceSha, targetSha },
      })
      expect(launch.workspacePath).toBe(world.conflict.allocations[0]!)
      expect(launch.workspacePath).toStartWith('aw-fixture-workspace:')
      expect(world.action.allocations).toEqual([])
      expect(world.contents.calls).toContain('readBytes')
      return { launch, requirement, pre }
    }

    test.each([false, true])(
      'prepare/adopt/validation/launch persist the exact reference with nonempty evidence=%s',
      async (withRequirement) => {
        const world = selectedWorld()
        const { launch, requirement, pre } = await launchedAttempt(
          `m-selected-${withRequirement}`,
          world,
          withRequirement,
        )
        const physical = world.codec.physical(launch.workspacePath)
        try {
          expect(readFileSync(join(physical, 'X.txt'), 'utf8')).toContain('<<<<<<<')
          expect(existsSync(join(physical, '.git', 'MERGE_HEAD'))).toBe(true)
          if (requirement !== null) {
            expect(
              new Uint8Array(readFileSync(join(physical, requirement.mountPath, 'body.bin'))),
            ).toEqual(requirement.bytes)
            expect(
              JSON.parse(
                readFileSync(
                  join(physical, requirement.mountPath, 'requirement-manifest.json'),
                  'utf8',
                ),
              ),
            ).toMatchObject({ manifestDigest: requirement.manifestDigest })
            expect(pre.bundles).toHaveLength(2)
          } else expect(pre.bundles).toEqual([])
        } finally {
          await world.conflict.discard(launch.workspacePath)
        }
      },
      120_000,
    )

    test('adopt rejection awaits exactly one SC cleanup, propagating the original rejection', async () => {
      const cleanup = heldEffect()
      const failure = new Error('actual-adopt-content-failure')
      const world = selectedWorld(
        async (effect) => {
          if (effect === 'discard') await cleanup.wait()
        },
        async (effect) => {
          if (effect === 'listNames') throw failure
        },
      )
      const missionId = 'm-selected-adopt-failure'
      await seedConflictedMission(missionId)
      let returned = false
      const pending = automation.reconcile(missionId).then(
        (value) => {
          returned = true
          return value
        },
        (error: unknown) => {
          returned = true
          return error
        },
      )
      await enteredBeforeOutcome(cleanup, pending)
      const reference = world.conflict.allocations[0]!
      try {
        expect(returned).toBe(false)
        expect(launches).toEqual([])
        expect(world.conflict.discards).toEqual([reference])
        expect(world.action.discards).toEqual([])
        expect(existsSync(world.codec.physical(reference))).toBe(true)
      } finally {
        cleanup.release()
      }
      expect<unknown>(await pending).toBe(failure)
      expect(world.conflict.discards).toEqual([reference])
      expect(existsSync(world.codec.physical(reference))).toBe(false)
    }, 120_000)

    test.each(['fresh', 'canceled', 'head-changed'] as const)(
      'restored %s branch awaits the durable SC owner before retry/block/return',
      async (mode) => {
        const cleanup = heldEffect()
        const world = selectedWorld(async (effect) => {
          if (effect === 'discard') await cleanup.wait()
        })
        const missionId = `m-selected-restored-${mode}`
        const { launch } = await launchedAttempt(missionId, world, mode === 'fresh')
        if (mode === 'canceled') {
          outcomes.set(launch.executionRef, {
            ...exited(launch.executionRef, ''),
            taskStatus: 'canceled',
            resultText: null,
          })
        } else if (mode === 'fresh') {
          outcomes.set(launch.executionRef, {
            ...exited(launch.executionRef, ''),
            taskStatus: 'interrupted',
            resultText: null,
          })
        } else {
          const side = join(HOME, `side-${missionId}`)
          mkdirSync(side)
          git(side, 'clone', '-q', remotePath, '.')
          git(side, 'checkout', '-q', branchOf(missionId))
          writeFileSync(join(side, 'human.txt'), 'human push\n')
          git(side, 'add', '-A')
          git(side, 'commit', '-q', '-m', 'human push')
          git(side, 'push', '-q', 'origin', branchOf(missionId))
          writeFileSync(
            join(world.codec.physical(launch.workspacePath), 'X.txt'),
            'line1-merged\nline2\n',
          )
          outcomes.set(
            launch.executionRef,
            exited(launch.executionRef, conflictEnvelope(launch.prompt, ['X.txt'])),
          )
        }
        // The durable context, not a prepare closure or an in-process owner map, drives cleanup.
        automation = world.compose()
        let returned = false
        const pending = automation.reconcile(missionId).then((value) => {
          returned = true
          return value
        })
        await enteredBeforeOutcome(cleanup, pending)
        try {
          expect(returned).toBe(false)
          expect(world.conflict.discards).toEqual([launch.workspacePath])
          expect(world.action.discards).toEqual([])
          expect(world.conflict.allocations).toHaveLength(1)
          expect(launches).toHaveLength(1)
          expect((await fx.store.getMission(missionId))!.blockCode).toBeNull()
          expect(existsSync(world.codec.physical(launch.workspacePath))).toBe(true)
        } finally {
          cleanup.release()
        }
        const collected = await pending
        expect(collected.kind).toBe('action-collect')
        if (collected.kind !== 'action-collect') throw new Error(collected.kind)
        expect(existsSync(world.codec.physical(launch.workspacePath))).toBe(false)
        expect(world.action.discards).toEqual([])
        if (mode === 'fresh') {
          expect(collected.result).toMatchObject({ kind: 'action-retry', rerunSeq: 1 })
          expect(world.conflict.allocations).toHaveLength(2)
          expect(launches).toHaveLength(2)
          expect(launches[1]!.workspacePath).toBe(world.conflict.allocations[1]!)
          const mission = (await fx.store.getMission(missionId))!
          const attempts = await fx.store.listAttempts(mission.currentActionRunId!)
          expect(
            attempts.map((attempt) => ({
              rerunSeq: attempt.rerunSeq,
              attemptSeq: attempt.attemptSeq,
            })),
          ).toEqual([
            { rerunSeq: 0, attemptSeq: 0 },
            { rerunSeq: 1, attemptSeq: 0 },
          ])
          expect((await world.evidence.contexts.load(attempts[1]!.preSnapshotRef!))!).toContain(
            launches[1]!.workspacePath,
          )
          await world.conflict.discard(launches[1]!.workspacePath)
        } else {
          const code = mode === 'canceled' ? 'agent-execution-canceled' : 'conflict-head-changed'
          expect(collected.result).toMatchObject({ kind: 'action-failed', blockCode: code })
          expect((await fx.store.getMission(missionId))!.blockCode).toBe(code)
          expect(world.conflict.allocations).toHaveLength(1)
          if (mode === 'head-changed') {
            expect(
              git(repoPath, 'ls-remote', remotePath, `refs/heads/${branchOf(missionId)}`)
                .split('\t')[0]!
                .trim(),
            ).not.toBe(sourceSha)
            const mission = (await fx.store.getMission(missionId))!
            expect(
              (await fx.snapshots.getCells(mission.requirementBundleRef!))![
                '__mr.factsCollectedAt'
              ],
            ).toMatchObject({ state: 'known', value: '0' })
          }
        }
      },
      120_000,
    )
  },
)
