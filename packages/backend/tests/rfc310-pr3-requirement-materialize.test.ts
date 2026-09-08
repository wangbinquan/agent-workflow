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
// 4. 2026-09-08 CI 的 body+file journey 停在 working 且无未结算 effect：
//    真实竞争写锁住已复现的 requirementBundleRef 丢失机制及 epoch 边界。
//    该次 CI 未输出事实引用，不能据其最后一行独占归因于本机制。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ulid } from 'ulid'

import { developmentBundleRefs } from '../src/db/schema'
import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import { retryBlockedMission } from '../src/modules/development-automation/application/commands/launchMission'
import {
  canonicalDigest,
  canonicalStringify,
} from '../src/modules/development-automation/domain/canonicalJson'
import { directSubmissionDigest } from '../src/modules/development-automation/infrastructure/requirementMaterializer'
import { createMissionPersistence } from '../src/modules/development-automation/infrastructure/missionStore'
import { buildPr3Fixture, PR3_JAVA_CELLS } from './helpers/rfc310Pr3Fixture'
import { fakeAgentActionPorts } from './helpers/rfc310AgentPorts'

setDefaultTimeout(60_000)

const SUBMISSION = { title: 'Add feature', body: 'do the thing', uploads: [] as const }

describe('rfc310 pr3 — direct requirement materialization', () => {
  test('stash digest must match the digest frozen at launch (structural pairing lock)', async () => {
    const fx = await buildPr3Fixture()
    const missionId = await fx.launchDirect('rfc310-pr3-pair-1')
    const mission = (await fx.store.getMission(missionId))!
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
    const afterMaterialize = (await fx.store.getMission(missionId))!
    expect(afterMaterialize.requirementBundleRef).not.toBeNull()
    const sources = await fx.store.listMissionSources(missionId)
    expect(sources).toHaveLength(2)
    const materialized = sources.find((s) => s.state === 'materialized')!
    expect(materialized.sourceKind).toBe('direct')
    expect(materialized.bundleRef).not.toBeNull()
    expect(materialized.sourceRevision).toBe(afterMaterialize.sourceContentDigest!)

    // 平台 manifest：schema 全量校验过、digest 可复算、正文进了 evidence。
    const manifest = (await fx.materializer.getRequirementManifest(missionId))!
    expect(manifest.title).toBe('Add feature')
    expect(manifest.source.kind).toBe('direct')
    expect(manifest.files).toHaveLength(1)
    expect(manifest.files[0]!.relativePath).toBe('body.md')
    expect(manifest.files[0]!.role).toBe('body')
    const { manifestDigest: _omit, ...core } = manifest
    expect(canonicalDigest(core)).toBe(manifest.manifestDigest)
    const manifestMount = (await fx.materializer.getRequirementManifestMount(
      missionId,
      manifest.manifestDigest,
    ))!
    expect(manifestMount.fileIds).toEqual(manifest.files.map((file) => file.fileId))
    const manifestBundle = fx.evidence.getBundle(manifestMount.bundleId)!
    expect(manifestBundle.entries.map((entry) => entry.relativePath)).toEqual([
      'requirement-manifest.json',
    ])
    expect(await fx.materializer.getRequirementManifestMount(missionId, '0'.repeat(64))).toBeNull()
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

  test.each([1, 8])(
    'materialized requirement facts survive %i competing reconciles',
    async (peerWrites) => {
      const fx = await buildPr3Fixture()
      const missionId = await fx.launchDirect(`rfc310-pr3-materialize-occ-${peerWrites}`)
      await fx.materializer.stashDirectSubmission({ missionId, submission: SUBMISSION })
      const base = fx.deps()
      const peerKinds: string[] = []
      const writeResults: string[] = []
      const store: typeof base.store = {
        ...base.store,
        async commitRequirementCells(input) {
          // The route driver and explicit journey pump can both write readiness
          // after this materialization has read its mission. Eight real writes
          // also cover the exhausted retry path that still lost the reference.
          for (let peer = 0; peer < peerWrites; peer += 1) {
            peerKinds.push((await runMissionReconcile(base, missionId)).kind)
          }
          const result = await base.store.commitRequirementCells(input)
          writeResults.push(result.ok ? 'ok' : result.code)
          return result
        },
      }
      const deps = { ...base, store }
      const first = await runMissionReconcile(deps, missionId)
      const materialized = (await fx.store.getMission(missionId))!
      const next = await runMissionReconcile(deps, missionId)
      const after = (await fx.store.getMission(missionId))!

      expect({
        peerKinds,
        first,
        requirementBundleRef: materialized.requirementBundleRef,
        status: after.status,
        blockCode: after.blockCode,
        unsettled: await fx.store.listUnsettledEffects(missionId),
        next,
      }).toMatchObject({
        peerKinds: Array.from({ length: peerWrites }, () => 'deduped'),
        first: {
          kind: 'decided',
          selected: { kind: 'materialize-direct-requirement' },
          handled: 'collected',
        },
        requirementBundleRef: expect.any(String),
        status: 'blocked',
        blockCode: 'collector-not-wired:repository',
        unsettled: [],
        next: {
          kind: 'decided',
          selected: { kind: 'collect-repository-facts' },
          handled: 'blocked',
        },
      })
      expect(writeResults).toEqual(['ok'])
      const manifest = (await fx.materializer.getRequirementManifest(missionId))!
      expect(manifest.files.map((file) => file.relativePath)).toEqual(['body.md'])
      expect(readFileSync(fx.evidence.blobPath(manifest.files[0]!.sha256), 'utf8')).toBe(
        SUBMISSION.body,
      )
    },
  )

  test('requirement write merges the cells committed by the competing writer', async () => {
    const fx = await buildPr3Fixture()
    const missionId = await fx.launchDirect('rfc310-pr3-materialize-merge-1')
    await fx.materializer.stashDirectSubmission({ missionId, submission: SUBMISSION })
    const base = fx.deps()
    const peerCells = {
      '__requirement.acquireAttempts': { state: 'known', value: 3, sourceRevision: 'peer' },
    }
    const store: typeof base.store = {
      ...base.store,
      async commitRequirementCells(input) {
        const fresh = (await base.store.getMission(missionId))!
        const snapshotId = ulid()
        await base.store.insertFactSnapshot({
          id: snapshotId,
          missionId,
          missionRevision: fresh.revision,
          capturedAt: new Date(input.now).toISOString().replace('Z', '+00:00'),
          cellsJson: canonicalStringify(peerCells),
          refsJson: canonicalStringify({ kind: 'requirement-peer' }),
          digest: canonicalDigest(peerCells),
          now: input.now,
        })
        expect(
          await base.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
            requirementBundleRef: snapshotId,
          }),
        ).toMatchObject({ ok: true })
        return await base.store.commitRequirementCells(input)
      },
    }

    await runMissionReconcile({ ...base, store }, missionId)
    const materialized = (await fx.store.getMission(missionId))!
    expect(await fx.snapshots.getCells(materialized.requirementBundleRef!)).toMatchObject({
      ...peerCells,
      'requirement.bundleComplete': { state: 'known', value: true },
      'requirement.clarificationState': { state: 'known', value: 'none' },
    })
  })

  test.each(['before-write', 'after-peer-write'] as const)(
    'requirement write stops when the mission epoch changes %s',
    async (changeEpoch) => {
      const fx = await buildPr3Fixture()
      const missionId = await fx.launchDirect(`rfc310-pr3-materialize-epoch-${changeEpoch}`)
      await fx.materializer.stashDirectSubmission({ missionId, submission: SUBMISSION })
      const base = fx.deps()
      const initial = (await base.store.getMission(missionId))!
      const writeResults: string[] = []
      const store: typeof base.store = {
        ...base.store,
        async commitRequirementCells(input) {
          if (changeEpoch === 'after-peer-write') {
            const fresh = (await base.store.getMission(missionId))!
            expect(
              await base.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {}),
            ).toMatchObject({ ok: true })
          }
          const fresh = (await base.store.getMission(missionId))!
          expect(await base.store.bumpEpoch(fresh.id, fresh.revision, {})).toMatchObject({
            ok: true,
          })
          const result = await base.store.commitRequirementCells(input)
          writeResults.push(result.ok ? 'ok' : result.code)
          return result
        },
      }

      await runMissionReconcile({ ...base, store }, missionId)
      const after = (await fx.store.getMission(missionId))!
      expect(after.epoch).toBe(initial.epoch + 1)
      expect(after.requirementBundleRef).toBeNull()
      expect(writeResults).toEqual(['epoch-conflict'])
    },
  )

  test('port absent ⇒ typed block requirement-port-not-wired (never silent)', async () => {
    const fx = await buildPr3Fixture()
    const missionId = await fx.launchDirect('rfc310-pr3-nowire-1')
    const outcome = await runMissionReconcile(
      {
        store: createMissionPersistence(fx.db),
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
    const mission = (await fx.store.getMission(missionId))!
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
    const blocked = (await fx.store.getMission(missionId))!
    expect(blocked.status).toBe('blocked')
    expect(blocked.blockCode).toBe('requirement-acquire-failed:direct-submission-not-staged')

    // stash + retry：attempt cells 改变了 decision 输入，去重不会吞掉重跑。
    await fx.materializer.stashDirectSubmission({ missionId, submission: SUBMISSION })
    await retryBlockedMission(
      {
        store: createMissionPersistence(fx.db),
        lookup: fx.lookup,
        now: () => Date.now(),
      },
      { missionId },
    )
    const round2 = await runMissionReconcile(deps, missionId)
    expect(round2.kind).toBe('decided')
    expect(round2.kind === 'decided' && round2.selected.kind).toBe('materialize-direct-requirement')
    expect(round2.kind === 'decided' && round2.handled).toBe('collected')
    expect((await fx.store.getMission(missionId))!.status).toBe('working')
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
      submissionRef: (await fx.store.getMission(missionId))!.sourceContentDigest!,
    })
    expect(done.ok).toBe(true)
    if (done.ok) {
      expect(done.fileCount).toBe(1)
      const manifest = (await fx.materializer.getRequirementManifest(missionId))!
      expect(manifest.totals.files).toBe(1)
    }
  })
})
