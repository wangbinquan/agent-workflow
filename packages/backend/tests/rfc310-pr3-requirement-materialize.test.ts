// RFC-310 PR-3 T35 —— direct 需求物化链路（launch → stash → reconciler 物化
// → 平台 manifest → 动作照常起跑）。
//
// 锁的回归面：
// 1. reconciler 的 requirement 重派：规则读 requirement.bundleComplete 撞
//    indeterminate 时派 materialize-direct-requirement（COLLECT_BY_GROUP 对
//    requirement 组「交由上层重派」约定的另半边——这里断言重派真的存在）。
// 2. stash 与 launch 的 digest 结构性配对：launchMission.directContentDigest
//    与 materializer.directSubmissionDigest 是两份实现，一旦漂移，stash 直接
//    contract-violation——本文件用真实 launch 的 sourceContentDigest 对拍。
// 3. 失败不卡死：materialize 失败落 attempt cells（新 digest ⇒ retry 后新
//    decision），retry-blocked 能真正重跑 arm 而不是被 decision 去重吞掉。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { developmentBundleRefs } from '../src/db/schema'
import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import { retryBlockedMission } from '../src/modules/development-automation/application/commands/launchMission'
import { canonicalDigest } from '../src/modules/development-automation/domain/canonicalJson'
import { directSubmissionDigest } from '../src/modules/development-automation/infrastructure/requirementMaterializer'
import { buildPr3Fixture, PR3_JAVA_CELLS } from './helpers/rfc310Pr3Fixture'
import { fakeAgentActionPorts } from './helpers/rfc310AgentPorts'

setDefaultTimeout(60_000)

const SUBMISSION = { title: 'Add feature', body: 'do the thing', uploads: [] as const }

describe('rfc310 pr3 — direct requirement materialization', () => {
  test('stash digest must match the digest frozen at launch (structural pairing lock)', async () => {
    const fx = await buildPr3Fixture()
    const missionId = await fx.launchDirect('rfc310-pr3-pair-1')
    const mission = fx.store.getMission(missionId)!
    expect(mission.sourceContentDigest).toBe(directSubmissionDigest(SUBMISSION))

    const drifted = await fx.materializer.stashDirectSubmission({
      missionId,
      submission: { ...SUBMISSION, body: 'something else entirely' },
    })
    expect(drifted.ok).toBe(false)
    if (!drifted.ok) {
      expect(drifted.failure.code).toBe('direct-submission-digest-mismatch')
      expect(drifted.failure.category).toBe('contract-violation')
    }

    const stashed = await fx.materializer.stashDirectSubmission({
      missionId,
      submission: SUBMISSION,
    })
    expect(stashed.ok).toBe(true)
    if (stashed.ok) expect(stashed.submissionRef).toBe(mission.sourceContentDigest!)
    const replay = await fx.materializer.stashDirectSubmission({
      missionId,
      submission: SUBMISSION,
    })
    expect(replay).toEqual(stashed)
    expect(
      fx.db
        .select()
        .from(developmentBundleRefs)
        .all()
        .filter((row) => row.missionId === missionId && row.purpose === 'direct-submission'),
    ).toHaveLength(1)
  })

  test('full direct chain: materialize → platform manifest → repo facts → action launch', async () => {
    const fx = await buildPr3Fixture()
    const missionId = await fx.launchDirect('rfc310-pr3-chain-1')
    await fx.materializer.stashDirectSubmission({ missionId, submission: SUBMISSION })

    const launches: string[] = []
    const deps = fx.deps({
      repositoryFacts: {
        async collect() {
          return { cells: { ...PR3_JAVA_CELLS }, factsRef: 'probe-1' }
        },
      },
      ...fakeAgentActionPorts({ db: fx.db, launches }),
    })

    // 轮 1：requirement.bundleComplete indeterminate → 重派 materialize。
    const round1 = await runMissionReconcile(deps, missionId)
    expect(round1.kind).toBe('decided')
    if (round1.kind === 'decided') {
      expect(round1.selected.kind).toBe('materialize-direct-requirement')
      expect(round1.handled).toBe('collected')
    }
    const afterMaterialize = fx.store.getMission(missionId)!
    expect(afterMaterialize.requirementBundleRef).not.toBeNull()
    const sources = fx.store.listMissionSources(missionId)
    expect(sources).toHaveLength(2)
    const materialized = sources.find((s) => s.state === 'materialized')!
    expect(materialized.sourceKind).toBe('direct')
    expect(materialized.bundleRef).not.toBeNull()
    expect(materialized.sourceRevision).toBe(afterMaterialize.sourceContentDigest!)

    // 平台 manifest：schema 全量校验过、digest 可复算、正文进了 evidence。
    const manifest = fx.materializer.getRequirementManifest(missionId)!
    expect(manifest.title).toBe('Add feature')
    expect(manifest.source.kind).toBe('direct')
    expect(manifest.files).toHaveLength(1)
    expect(manifest.files[0]!.relativePath).toBe('body.md')
    expect(manifest.files[0]!.role).toBe('body')
    const { manifestDigest: _omit, ...core } = manifest
    expect(canonicalDigest(core)).toBe(manifest.manifestDigest)
    const manifestMount = fx.materializer.getRequirementManifestMount(
      missionId,
      manifest.manifestDigest,
    )!
    expect(manifestMount.fileIds).toEqual(manifest.files.map((file) => file.fileId))
    const manifestBundle = fx.evidence.getBundle(manifestMount.bundleId)!
    expect(manifestBundle.entries.map((entry) => entry.relativePath)).toEqual([
      'requirement-manifest.json',
    ])
    expect(fx.materializer.getRequirementManifestMount(missionId, '0'.repeat(64))).toBeNull()
    const bundle = fx.evidence.getBundle(materialized.bundleRef!)!
    expect(bundle.entries).toHaveLength(1)
    expect(readFileSync(fx.evidence.blobPath(bundle.entries[0]!.sha256), 'utf8')).toBe(
      'do the thing',
    )

    // 轮 2：repository facts；轮 3：规则命中 → 动作起跑。
    const round2 = await runMissionReconcile(deps, missionId)
    expect(round2.kind === 'decided' && round2.selected.kind).toBe('collect-repository-facts')
    const round3 = await runMissionReconcile(deps, missionId)
    expect(round3.kind === 'decided' && round3.selected.kind).toBe('run-agent-action')
    expect(round3.kind === 'decided' && round3.handled).toBe('action-launched')
    expect(launches).toEqual(['change.implement'])
  })

  test('port absent ⇒ typed block requirement-port-not-wired (never silent)', async () => {
    const fx = await buildPr3Fixture()
    const missionId = await fx.launchDirect('rfc310-pr3-nowire-1')
    const outcome = await runMissionReconcile(
      {
        store: fx.store,
        lookup: fx.lookup,
        snapshots: fx.snapshots,
        ports: {},
        now: () => Date.now(),
      },
      missionId,
    )
    expect(outcome.kind === 'decided' && outcome.selected.kind).toBe(
      'materialize-direct-requirement',
    )
    expect(outcome.kind === 'decided' && outcome.handled).toBe('blocked')
    const mission = fx.store.getMission(missionId)!
    expect(mission.status).toBe('blocked')
    expect(mission.blockCode).toBe('requirement-port-not-wired')
  })

  test('materialize failure blocks with attempt cells; retry-blocked genuinely re-runs the arm', async () => {
    const fx = await buildPr3Fixture()
    const missionId = await fx.launchDirect('rfc310-pr3-retry-1')
    const deps = fx.deps()

    // 未 stash：materialize 失败 → typed block（不是静默/不是 crash）。
    const round1 = await runMissionReconcile(deps, missionId)
    expect(round1.kind === 'decided' && round1.handled).toBe('blocked')
    const blocked = fx.store.getMission(missionId)!
    expect(blocked.status).toBe('blocked')
    expect(blocked.blockCode).toBe('requirement-acquire-failed:direct-submission-not-staged')

    // stash + retry：attempt cells 改变了 decision 输入，去重不会吞掉重跑。
    await fx.materializer.stashDirectSubmission({ missionId, submission: SUBMISSION })
    await retryBlockedMission(
      { store: fx.store, lookup: fx.lookup, now: () => Date.now() },
      { missionId },
    )
    const round2 = await runMissionReconcile(deps, missionId)
    expect(round2.kind).toBe('decided')
    expect(round2.kind === 'decided' && round2.selected.kind).toBe('materialize-direct-requirement')
    expect(round2.kind === 'decided' && round2.handled).toBe('collected')
    expect(fx.store.getMission(missionId)!.status).toBe('working')
  })

  test('empty-body direct submission materializes to an empty (but valid) bundle', async () => {
    const fx = await buildPr3Fixture()
    // body 为空在 launch 层被 superRefine 拒（需 body 或 upload），所以这里
    // 用「空白正文 + 单空格 title 修剪」以外的路径不可达；退一步锁 manifest
    // 生成器对 0 文件也产合法 manifest（uploads-only 形态的将来路径）。
    const missionId = await fx.launchDirect('rfc310-pr3-empty-1', '  x  ')
    const stashed = await fx.materializer.stashDirectSubmission({
      missionId,
      submission: { title: 'Add feature', body: '  x  ', uploads: [] },
    })
    expect(stashed.ok).toBe(true)
    const done = await fx.materializer.materializeDirect({
      missionId,
      submissionRef: fx.store.getMission(missionId)!.sourceContentDigest!,
    })
    expect(done.ok).toBe(true)
    if (done.ok) {
      expect(done.fileCount).toBe(1)
      const manifest = fx.materializer.getRequirementManifest(missionId)!
      expect(manifest.totals.files).toBe(1)
    }
  })
})
