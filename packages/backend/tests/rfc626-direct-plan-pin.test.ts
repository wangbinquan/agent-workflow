// RFC-626 §4.2 (plan T3): the plan step can be repeated, the execution step pins its plan, and
// an upgrade that was killed anywhere continues where it stopped.
//
// Why this file exists: the automatic loop re-planned whenever the phase was not later than
// `planned`. Once the execution step has begun it writes artifacts that are written once from
// the plan's inventory (the frozen preflight, the frozen content manifest, the backup); a
// process killed there and re-planned with a new inventory could never write them again. So the
// first act of the execution step is to pin the approved plan in `runs/<runId>/plan-pinned.json`
// (written once); from then on the loop reads that plan back instead of planning. Before the
// pin every start still plans afresh — which is what re-checks a target that was refused.
//
// The table below is the "killed at each window" table of design §4.2, row by row as far as the
// port fixture can express it (the windows inside the freeze itself belong to the source
// access and are tested there). A killed process is simulated the way the fixture helper
// describes: nothing after the point is written and no failure is recorded.
import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { CONVERTER_VERSION } from '@/platform/persistence/migration/conversion/plan'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { readPlanPin } from '@/modules/system-operations/application/epochSwitch/session'
import {
  PLAN_PIN_ARTIFACT,
  parsePlanPin,
  pinnedMaterialDifferences,
  type PlanPin,
} from '@/modules/system-operations/domain/epochSwitch/planPin'
import { fixtureDigest } from './helpers/rfc395V3SwitchFixture'
import { directSwitchFixture, killed, type DirectSwitchFixture } from './helpers/rfc626DirectSwitch'

const fixtures: DirectSwitchFixture[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close()
})
function fixture(): DirectSwitchFixture {
  const f = directSwitchFixture()
  fixtures.push(f)
  return f
}
const COMPLETE = ['intent', 'plan-evaluated', 'approved', 'plan-evaluated', 'approved', 'completed']

describe('RFC-626 —— 执行步一开始就钉住计划', () => {
  test('钉住的是已批准的那份计划，连同生成它的二进制的四项材料；只写一次', async () => {
    const f = fixture()
    expect((await f.start()).outcome).toBe('done')
    const journal = await f.journal()
    const session = await f.session()
    const first = session.records.find((record) => record.kind === 'plan-evaluated')!
    expect(await f.pin()).toEqual({
      version: 1,
      runId: journal.payload.run!.runId,
      planDigest: first.data.planDigest as string,
      approvalDigest: first.data.approvalDigest as string,
      candidateBuild: 'candidate',
      converterVersion: CONVERTER_VERSION,
      targetContractDigest: fixtureDigest,
      targetPlanDigest: fixtureDigest,
    })
    expect(PLAN_PIN_ARTIFACT).toBe('plan-pinned.json')
    expect(await f.artifact(`runs/${journal.payload.run!.runId}/plan-pinned.json`)).not.toBeNull()
    // Pinned once, before anything of the execution step was written …
    expect(f.checkpoints.filter((point) => point === 'plan-pinned')).toHaveLength(1)
    expect(f.checkpoints.indexOf('plan-pinned')).toBeLessThan(
      f.checkpoints.indexOf('phase-backed-up'),
    )
    expect(f.checkpoints.indexOf('plan-pinned')).toBeGreaterThan(
      f.checkpoints.indexOf('phase-planned'),
    )
    // … and it stays the plan before the run although the journal now names the actual one.
    expect(journal.payload.plan!.digest).not.toBe(first.data.planDigest)
    expect((await f.plan(first.data.planDigest as string)).payload.resolutions).toBeUndefined()
  })

  test('钉住之后不再重新计划：计划步自己拒绝，自动循环读回钉住的那份', async () => {
    const f = fixture()
    f.killAt({ checkpoint: 'plan-pinned' })
    expect((await f.start()).outcome).toBe('error')
    f.disarm()
    const pinned = (await f.pin())!
    const freezes = f.calls.freeze
    await expect(f.app.plan({ operationId: f.operationId })).rejects.toMatchObject({
      code: 'v3-replan-requires-new-run',
    })
    // Refused before the old database is touched.
    expect(f.calls.freeze).toBe(freezes)
    expect(f.calls.capture).toBe(1)
    expect((await f.journal()).payload.phase).toBe('planned')

    const plans = f.calls.plan
    expect((await f.start()).outcome).toBe('done')
    expect(f.calls.plan).toBe(plans)
    expect(f.calls.capture).toBe(1)
    expect(await f.pin()).toEqual(pinned)
    expect(f.seen.openRun[0]![0].migrationPlanDigest).toBe(pinned.planDigest)
  })

  test('只有已批准、没有阻塞项的计划会被钉住：目标库条件修复后再启动，重新计划即可继续', async () => {
    const f = fixture()
    let occupied = true
    let checks = 0
    const preflight = f.deps.target.preflight
    f.deps.target = {
      ...f.deps.target,
      async preflight(input) {
        const checked = await preflight(input)
        // The check at discovery passes; the one the plan step makes finds the target in use.
        return occupied && ++checks > 1 ? { ...checked, empty: false } : checked
      },
    }
    const refused = await f.start()
    expect(refused).toMatchObject({
      outcome: 'refused',
      exitCode: 3,
      operationId: f.operationId,
      code: 'plan-blocked',
      artifactRoot: f.deps.journal.operationRoot(f.operationId),
    })
    // The condition in words first; an automatic plan blocks on its environment only.
    expect(refused.guidance[0]).toStartWith('v3-target-not-empty: ')
    expect(refused.guidance.at(-1)).toContain('Correct the reported condition, then start again')
    expect(refused.guidance.join('\n')).not.toContain('db migration acknowledge')
    expect(await f.pin()).toBeNull()
    expect(f.calls.run).toBe(0)
    expect(await f.recordKinds()).toEqual(['intent', 'plan-evaluated', 'refused'])

    occupied = false
    const done = await f.start()
    expect(done.outcome).toBe('done')
    // Planned again by this start, and that plan is the one that was pinned.
    expect(f.calls.plan).toBe(2)
    const session = await f.session()
    const evaluations = session.records.filter((record) => record.kind === 'plan-evaluated')
    expect(evaluations).toHaveLength(3)
    expect(evaluations[0]!.data.blocks).toBe(1)
    expect(evaluations[1]!.data.blocks).toBe(0)
    expect((await f.pin())!.planDigest).toBe(evaluations[1]!.data.planDigest as string)
    expect((await f.journal()).payload.run!.ordinal).toBe(0)
  })
})

describe('RFC-626 —— 钉住文件的读法', () => {
  const pin: PlanPin = {
    version: 1,
    runId: 'emr_fixture',
    planDigest: fixtureDigest,
    approvalDigest: fixtureDigest,
    candidateBuild: 'candidate',
    converterVersion: CONVERTER_VERSION,
    targetContractDigest: fixtureDigest,
    targetPlanDigest: fixtureDigest,
  }
  const current = {
    candidateBuild: 'candidate',
    converterVersion: CONVERTER_VERSION,
    targetContractDigest: fixtureDigest,
    targetPlanDigest: fixtureDigest,
  }
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))

  test('认得的键读出来；多出来的键不妨碍比较；读不出的一律算不认得', () => {
    expect(parsePlanPin(bytes(pin))).toEqual(pin)
    // Not strict: a later binary may add a key without making its pin unreadable here.
    expect(parsePlanPin(bytes({ ...pin, ruleSetDigest: fixtureDigest }))).toMatchObject(pin)
    expect(parsePlanPin(Buffer.from('{"version":1'))).toBeNull()
    expect(parsePlanPin(bytes({ ...pin, version: 2 }))).toBeNull()
    expect(parsePlanPin(bytes({ ...pin, targetContractDigest: 'not-a-digest' }))).toBeNull()
    const { converterVersion: _dropped, ...partial } = pin
    expect(parsePlanPin(bytes(partial))).toBeNull()
    expect(parsePlanPin(bytes(null))).toBeNull()
  })

  test('四项材料逐项比较；读不出的钉住文件按四项都不同处理', () => {
    expect(pinnedMaterialDifferences(pin, current)).toEqual([])
    expect(pinnedMaterialDifferences(pin, { ...current, candidateBuild: 'next' })).toEqual([
      'candidateBuild',
    ])
    expect(
      pinnedMaterialDifferences(pin, {
        ...current,
        converterVersion: 'other',
        targetPlanDigest: valueDigest('other structure'),
      }),
    ).toEqual(['converterVersion', 'targetPlanDigest'])
    expect(
      pinnedMaterialDifferences(pin, {
        ...current,
        targetContractDigest: valueDigest('other contract'),
      }),
    ).toEqual(['targetContractDigest'])
    expect(pinnedMaterialDifferences(null, current)).toEqual([
      'candidateBuild',
      'converterVersion',
      'targetContractDigest',
      'targetPlanDigest',
    ])
  })

  test('没有钉住、钉住了、钉住的是别的运行或读不出：三种结果分得开', async () => {
    const f = fixture()
    f.killAt({ checkpoint: 'phase-planned' })
    expect((await f.start()).outcome).toBe('error')
    expect(await readPlanPin(f.deps, await f.journal())).toBeNull()
    f.killAt({ checkpoint: 'plan-pinned' })
    expect((await f.start()).outcome).toBe('error')
    f.disarm()
    const journal = await f.journal()
    const written = (await readPlanPin(f.deps, journal)) as PlanPin
    expect(written.runId).toBe(journal.payload.run!.runId)
    const path = f.artifactPath(`runs/${journal.payload.run!.runId}/plan-pinned.json`)
    writeFileSync(path, JSON.stringify({ ...written, runId: 'emr_another_run' }))
    expect(await readPlanPin(f.deps, journal)).toBe('unreadable')
    writeFileSync(path, 'not json')
    expect(await readPlanPin(f.deps, journal)).toBe('unreadable')
  })
})

describe('RFC-626 —— 计划里的清单读不回来时', () => {
  test('重新盘点一次，与钉住的计划所列的是同一份清单就继续', async () => {
    const f = fixture()
    // The listing is the one file of the plan step that is not flushed: after a power loss
    // the plan can name a listing that is not there.
    f.scenario.writeListing = false
    f.scenario.atCheckpoint = (point) => {
      if (point === 'plan-pinned') f.scenario.writeListing = true
    }
    expect((await f.start()).outcome).toBe('done')
    expect(f.calls.capture).toBe(2)
    expect(f.calls.plan).toBe(1)
    const journal = await f.journal()
    expect(journal.payload.run!.ordinal).toBe(0)
    const run = `runs/${journal.payload.run!.runId}`
    expect(await f.artifact(`${run}/frozen/content-listing.json`)).not.toBeNull()
    expect(
      (
        JSON.parse(
          Buffer.from((await f.artifact(`${run}/frozen/content-manifest.json`))!).toString('utf8'),
        ) as { digest: string }
      ).digest,
    ).toBe(fixtureDigest)
  })

  test('内容与钉住的计划所列的不同：这一轮结束，新一轮运行从计划步重做', async () => {
    const f = fixture()
    const changed = valueDigest('content listed again, and different')
    f.scenario.writeListing = false
    f.scenario.atCheckpoint = (point) => {
      if (point !== 'plan-pinned') return
      f.scenario.writeListing = true
      f.scenario.manifestDigest = changed
    }
    expect((await f.start()).outcome).toBe('done')
    // Plan step, the listing again for the pinned run, the plan step of the new run.
    expect(f.calls.capture).toBe(3)
    const journal = await f.journal()
    expect(journal.payload.run!.ordinal).toBe(1)
    expect(journal.payload.frozen!.contentManifestDigest).toBe(changed)
    // The first run ended with the failure that starts a new one; nothing had been built.
    expect(
      f.seen.runs.map(({ newRun, ordinal, failure }) => ({ newRun, ordinal, failure })),
    ).toEqual([
      { newRun: false, ordinal: 0, failure: null },
      {
        newRun: true,
        ordinal: 0,
        failure: 'v3-content-changed-since-plan-new-run-required',
      },
      { newRun: false, ordinal: 1, failure: null },
    ])
    expect(f.calls.retire).toBe(0)
    expect(f.calls.targetCreate).toBe(1)
    // Starting the new run planned it; it was not planned a second time on the way to its
    // execution step.
    expect(f.calls.plan).toBe(1)
  })
})

/** Where the process is killed, and how often each step has run once the next start is done. */
const WINDOWS: readonly {
  readonly row: string
  readonly at: Parameters<DirectSwitchFixture['killAt']>[0]
  readonly plan?: number
  readonly capture?: number
  readonly prepare?: number
  readonly convert?: number
  readonly finalize?: number
  /** The receipt of a backup that already existed is checked once against the frozen source. */
  readonly backupVerified?: boolean
}[] = [
  { row: '意图已登记、尚未发现', at: { checkpoint: 'intent' } },
  { row: '已发现、尚未计划', at: { checkpoint: 'discovered' }, plan: 2 },
  { row: '冻结之后、盘点之前', at: { checkpoint: 'plan' }, plan: 2 },
  { row: '计划已保存、尚未钉住', at: { checkpoint: 'phase-planned' }, plan: 2, capture: 2 },
  { row: '计划已钉住、固定工件一个都没写', at: { checkpoint: 'plan-pinned' } },
  { row: '计划已钉住、冻结凭据已写', at: { fault: 'after-frozen-preflight' } },
  { row: '计划已钉住、冻结清单已写', at: { fault: 'after-content-manifest' } },
  {
    row: '计划已钉住、备份已写、backed-up 未保存',
    at: { fault: 'after-final-backup' },
    backupVerified: true,
  },
  { row: 'backed-up 已保存', at: { checkpoint: 'phase-backed-up' }, backupVerified: true },
  { row: 'quiescing 已保存', at: { checkpoint: 'phase-quiescing' }, backupVerified: true },
  { row: 'frozen 已保存', at: { checkpoint: 'phase-frozen' }, backupVerified: true },
  {
    row: 'converting 已保存、转换未准备',
    at: { checkpoint: 'phase-converting' },
    backupVerified: true,
  },
  {
    row: '新库已建、运行未登记',
    at: { fault: 'after-target-install' },
    prepare: 2,
    backupVerified: true,
  },
  {
    row: '转换中：运行已登记',
    at: { fault: 'after-run-open' },
    prepare: 2,
    convert: 2,
    backupVerified: true,
  },
  {
    row: '转换中：行已写、回执未写',
    at: { fault: 'after-rows' },
    prepare: 2,
    convert: 2,
    backupVerified: true,
  },
  {
    row: '转换中：单元未确认',
    at: { fault: 'before-ack' },
    prepare: 2,
    convert: 2,
    backupVerified: true,
  },
  { row: '转换已结束、摘要已写', at: { fault: 'after-finish' }, backupVerified: true },
  { row: '转换已结束、尚未收尾', at: { checkpoint: 'conversion-finished' }, backupVerified: true },
  {
    row: '收尾处置做到一半',
    at: { fault: 'after-deferred-constraints' },
    finalize: 2,
    backupVerified: true,
  },
  {
    row: '收尾做完、尚未校验',
    at: { fault: 'after-catalog-admission' },
    finalize: 2,
    backupVerified: true,
  },
  { row: '校验已记录', at: { fault: 'after-validation' }, finalize: 2, backupVerified: true },
  { row: '回执已导出', at: { fault: 'after-receipt-export' }, finalize: 2, backupVerified: true },
  { row: '实际结果的计划已保存、尚未评估', at: { checkpoint: 'phase-validated' } },
  { row: '实际结果的计划待批准', at: { checkpoint: 'awaiting-approval' } },
  { row: '激活回执已发布', at: { fault: 'after-activation-receipt-file' } },
  { row: '新库已记下激活', at: { fault: 'after-meta-receipt' } },
  { row: '切换前的健康检查已过', at: { fault: 'after-health-check' } },
  { row: 'activation-prepared 已保存', at: { checkpoint: 'phase-activation-prepared' } },
  { row: '已切换、执行步未返回', at: { fault: 'after-activated-journal' } },
  { row: '已切换、尚未自检', at: { checkpoint: 'run-returned' } },
  { row: '自检已过、回执已发布、完成记录未写', at: { checkpoint: 'receipt' } },
]

describe('RFC-626 —— 中途被杀后再启动，从停下的地方继续', () => {
  for (const window of WINDOWS)
    test(`${window.row}`, async () => {
      const f = fixture()
      f.killAt(window.at)
      const first = await f.start()
      expect(first).toMatchObject({ outcome: 'error', exitCode: 1, code: 'test-process-killed' })
      // Killed, not failed: the journal holds what the last write left and no failure.
      const interrupted = await f.deps.journal.read(f.operationId)
      expect(interrupted?.payload.failure ?? null).toBeNull()
      const pinnedAtKill = interrupted ? await f.pinBytes() : null
      expect(await f.recordKinds()).not.toContain('completed')

      f.disarm()
      const second = await f.start()
      expect(second).toMatchObject({ outcome: 'done', exitCode: 0 })
      const journal = await f.journal()
      expect(journal.payload.phase).toBe('verified')
      expect(journal.payload.failure).toBeNull()
      // The same run all the way: nothing was given up and nothing was built twice.
      expect(journal.payload.run!.ordinal).toBe(0)
      expect(f.calls.retire).toBe(0)
      expect(f.calls.targetCreate).toBe(1)
      expect(f.calls.backupCreate).toBe(1)
      expect(f.calls.backupMatches).toBe(window.backupVerified ? 1 : 0)
      expect(f.calls.dryRun).toBe(0)
      expect(f.calls.stagedConversion).toBe(0)
      expect(f.calls.plan).toBe(window.plan ?? 1)
      expect(f.calls.capture).toBe(window.capture ?? 1)
      expect(f.calls.prepare).toBe(window.prepare ?? 1)
      expect(f.calls.convert).toBe(window.convert ?? 1)
      expect(f.calls.finalize).toBe(window.finalize ?? 1)
      // Validation is recorded in the new database: it is never made a second time.
      expect(f.calls.validate).toBe(1)
      // A plan that was pinned when the process died is the plan that was executed.
      expect(f.checkpoints.filter((point) => point === 'plan-pinned')).toHaveLength(1)
      if (pinnedAtKill)
        expect(Buffer.from((await f.pinBytes())!).equals(Buffer.from(pinnedAtKill))).toBe(true)
      // Each of the two plans was evaluated once and approved once, whatever was repeated.
      expect(await f.recordKinds()).toEqual(COMPLETE)
      expect(journal.payload.approvals).toHaveLength(2)
    })

  test('盘点做到一半被杀：冻结沿用，重新盘点后继续', async () => {
    const f = fixture()
    const capture = f.deps.content.capture
    let dying = true
    f.deps.content = {
      ...f.deps.content,
      async capture(input) {
        const manifest = await capture(input)
        if (!dying) return manifest
        dying = false
        throw killed()
      },
    }
    expect((await f.start()).outcome).toBe('error')
    expect((await f.journal()).payload.phase).toBe('discovered')
    expect((await f.start()).outcome).toBe('done')
    expect(f.calls.capture).toBe(2)
    expect(f.calls.plan).toBe(2)
    // The plan step froze again through the same request: same operation directory, no
    // identity to match, so the source access is free to reuse the copy it already has.
    expect(f.seen.freeze[1]!.operationRoot).toBe(f.seen.freeze[0]!.operationRoot)
    expect(f.seen.freeze[1]!.expected).toBeUndefined()
    expect(await f.recordKinds()).toEqual(COMPLETE)
  })

  test('批准已记录、执行步还没进入就被杀：重新计划得到同一个批准摘要，不再评估一次', async () => {
    const f = fixture()
    let dying = true
    f.scenario.beforeRun = () => {
      if (!dying) return
      dying = false
      throw killed()
    }
    expect((await f.start()).outcome).toBe('error')
    expect(await f.recordKinds()).toEqual(['intent', 'plan-evaluated', 'approved'])
    expect(await f.pin()).toBeNull()
    // Planned at another moment: another plan document, the same material.
    f.control.clock += 60_000
    expect((await f.start()).outcome).toBe('done')
    expect(f.calls.plan).toBe(2)
    expect(await f.recordKinds()).toEqual(COMPLETE)
    const session = await f.session()
    const first = session.records.find((record) => record.kind === 'plan-evaluated')!
    const pin = (await f.pin())!
    expect(pin.approvalDigest).toBe(first.data.approvalDigest as string)
    expect(pin.planDigest).not.toBe(first.data.planDigest as string)
  })
})
