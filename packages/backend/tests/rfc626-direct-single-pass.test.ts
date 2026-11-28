// RFC-626 §4.2 / §4.8 (plan T3): the automatic upgrade does each step once.
//
// Why this file exists: the automatic upgrade used to follow the manual flow — plan and back up
// against the running database, stop writers, then freeze, list the content, back up, rehearse
// and convert again. On the reference data that was 70 minutes in which every expensive step ran
// two or three times, although the automatic session holds the daemon lock from its first step
// and nothing can write the old database in between. With `direct` (set only by the assembly of
// the automatic upgrade) there is one freeze, one inventory, one backup, one conversion written
// straight into the new database, one finalize and one validation, and the plan of the actual
// result is approved where the run stands. This file locks those counts on the port fixture,
// the order of the progress output, and that the manual flow — which never sets `direct` —
// still does exactly what it did.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { estimateDirectUpgradeCapacity } from '@/modules/system-operations/domain/epochSwitch/capacity'
import { fixtureDigest } from './helpers/rfc395V3SwitchFixture'
import { directSwitchFixture, type DirectSwitchFixture } from './helpers/rfc626DirectSwitch'

const fixtures: DirectSwitchFixture[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close()
})
function fixture(options: Parameters<typeof directSwitchFixture>[0] = {}): DirectSwitchFixture {
  const f = directSwitchFixture(options)
  fixtures.push(f)
  return f
}
const text = (bytes: Uint8Array | null) => Buffer.from(bytes!).toString('utf8')

describe('RFC-626 —— 自动升级的每一步各做一次', () => {
  test('冻结、盘点、备份、转换、收尾、校验各一次；没有预演，也没有对运行中的库做备份', async () => {
    const f = fixture()
    const result = await f.start()
    expect(result).toMatchObject({ outcome: 'done', exitCode: 0, operationId: f.operationId })
    expect(Object.hasOwn(result, 'artifactRoot')).toBe(false)

    // One freeze: the plan step's. The execution step re-opens that copy (see the next test).
    expect(f.calls.discover).toBe(0)
    expect(f.calls.freeze).toBe(2)
    expect(f.control.quiesceCalls).toBe(1)
    // One inventory, opened by the plan step and by the execution step.
    expect(f.calls.capture).toBe(1)
    expect(f.calls.inventoryOpen).toBe(2)
    // One backup, after the freeze; a backup that was just made is not read back.
    expect(f.calls.backupCreate).toBe(1)
    expect(f.calls.backupMatches).toBe(0)
    // No rehearsal anywhere and no staged conversion: one prepared conversion, run once.
    expect(f.calls.dryRun).toBe(0)
    expect(f.calls.stagedConversion).toBe(0)
    expect(f.calls.prepare).toBe(1)
    expect(f.calls.convert).toBe(1)
    expect(f.calls.prepareClosed).toBe(1)
    // One new database, finalized once and validated once with that result.
    expect(f.calls.targetCreate).toBe(1)
    expect(f.calls.retire).toBe(0)
    expect(f.calls.finalize).toBe(1)
    expect(f.calls.validate).toBe(1)
    // The content was verified by that validation, not a second time on a way back in.
    expect(f.calls.verifyContent).toBe(0)
    // The boot facts: captured for the plan, compared once before the conversion.
    expect(f.seen.boot.map((capture) => capture.stage)).toEqual(['plan', 'freeze'])
    // One plan step and one execution step.
    expect(f.calls.plan).toBe(1)
    expect(f.calls.run).toBe(1)

    const journal = await f.journal()
    expect(journal.payload.phase).toBe('verified')
    expect(journal.payload.run!.ordinal).toBe(0)
    expect(journal.payload.checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      'planned',
      'backed-up',
      'quiescing',
      'frozen',
      'converting',
      'validated',
      'activation-prepared',
      'activated',
      'verified',
    ])
    expect(await f.recordKinds()).toEqual([
      'intent',
      'plan-evaluated',
      'approved',
      'plan-evaluated',
      'approved',
      'completed',
    ])
  })

  test('执行步重开计划步冻结的那一份：带着计划里的旧库身份，不再报告进度', async () => {
    const f = fixture()
    expect((await f.start()).outcome).toBe('done')
    const [planning, executing] = f.seen.freeze
    // The plan step freezes without an identity to match: nothing depends on one yet.
    expect(planning!.expected).toBeUndefined()
    expect(typeof planning!.progress).toBe('function')
    // The execution step holds the pinned plan to the copy it re-opens.
    expect(executing!.expected).toEqual({
      watermark: fixtureDigest,
      preUpgradeWatermark: null,
      sourceGenerationId: 'dbg_source_fixture',
    })
    expect(executing!.progress).toBeUndefined()
    // Both read the way the conversion reads: what the old database can hold is not refused.
    expect(f.seen.freeze.map((request) => request.resolution)).toEqual(['automatic', 'automatic'])
    expect(planning!.operationRoot).toBe(executing!.operationRoot)
    expect(f.seen.contentOpen).toEqual(['automatic', 'automatic'])
    expect(f.seen.backup).toEqual(['automatic'])
    expect(f.seen.boot.map((capture) => capture.resolution)).toEqual(['automatic', 'automatic'])
    expect(f.seen.requests.map((request) => request.resolution)).toEqual(['automatic'])
  })

  test('同一进程里执行步沿用计划步的清单对象；内容端口不交接时才从清单文件读回', async () => {
    // design §4.4: the listing of the reference installation is 170 MB of text. Parsing it in
    // the process that had just written it made a second copy of the largest object of the
    // upgrade (the resident memory of the final measurement jumped 1.5 GB around the backup).
    const handed = fixture()
    handed.scenario.handOver = true
    expect((await handed.start()).outcome).toBe('done')
    expect(handed.calls.capture).toBe(1)
    expect(handed.seen.backupManifests).toHaveLength(1)
    // The very object the plan step listed reaches the backup.
    expect(handed.seen.backupManifests[0]).toBe(handed.seen.captured[0])
    // The frozen manifest is still the listing's bytes.
    const journal = await handed.journal()
    const run = `runs/${journal.payload.run!.runId}`
    const planned = await handed.plan((await handed.pin())!.planDigest)
    expect(text(await handed.artifact(`${run}/frozen/content-manifest.json`))).toBe(
      text(await handed.artifact(planned.payload.contentManifestPath!)),
    )

    // A content port without the hand-over — any other assembly — reads the file back.
    const parsed = fixture()
    expect((await parsed.start()).outcome).toBe('done')
    expect(parsed.calls.capture).toBe(1)
    expect(parsed.seen.backupManifests[0]).toEqual(parsed.seen.captured[0])
    expect(parsed.seen.backupManifests[0]).not.toBe(parsed.seen.captured[0])
  })

  test('三处交界各回收一次：计划步结束之后、备份之后转换之前、转换之后校验之前；人工流程不回收', async () => {
    // design §4.7: what a step leaves behind is collected before the next one allocates, so the
    // conversion fits into memory the process already holds (measured: without it the staging
    // of the first tables added 2 GB to the resident size on the reference database).
    const f = fixture()
    expect((await f.start()).outcome).toBe('done')
    expect(f.seen.reclaimAfter).toEqual([
      // The plan step listed the content; nothing is backed up or converted yet.
      { capture: 1, backup: 0, convert: 0, validated: 0 },
      // The backup exists; the conversion has not started.
      { capture: 1, backup: 1, convert: 0, validated: 0 },
      // The conversion is over; finalizing and validating come next.
      { capture: 1, backup: 1, convert: 1, validated: 0 },
    ])

    const manual = fixture({ direct: false })
    const view = await manual.app.plan({})
    const status = await manual.app.run({
      operationId: manual.operationId,
      approve: view.plan.approvalDigest,
    })
    expect(status.phase).toBe('activated')
    expect(manual.calls.reclaim).toBe(0)
  })

  test('盘点只做一次：计划里的清单原样成为冻结清单，备份也只有冻结之后的那一份', async () => {
    const f = fixture()
    expect((await f.start()).outcome).toBe('done')
    const journal = await f.journal()
    const run = `runs/${journal.payload.run!.runId}`
    const pin = (await f.pin())!
    const planned = await f.plan(pin.planDigest)
    // The listing the plan names, byte for byte.
    expect(planned.payload.contentManifestPath).toStartWith(`${run}/plan-content/`)
    expect(text(await f.artifact(`${run}/frozen/content-manifest.json`))).toBe(
      text(await f.artifact(planned.payload.contentManifestPath!)),
    )
    // Not listed again for the frozen run, and not for a backup of the running database.
    expect(await f.artifact(`${run}/frozen/content-listing.json`)).toBeNull()
    expect(await f.artifact(`${run}/backup-content.json`)).toBeNull()
    expect(await f.artifact(`${run}/backup-live.json`)).toBeNull()
    const backup = JSON.parse(text(await f.artifact(`${run}/backup-final.json`))) as {
      id: string
      sourceWatermark: string
      contentManifestDigest: string
    }
    expect(backup).toMatchObject({
      id: 'backup-fixture',
      sourceWatermark: fixtureDigest,
      contentManifestDigest: planned.payload.contentManifestDigest,
    })
    expect(journal.payload.backup!.id).toBe('backup-fixture')
    expect(journal.payload.frozen!.contentManifestDigest).toBe(
      planned.payload.contentManifestDigest,
    )
  })

  test('转换直接写进新库：运行以钉住的计划登记，收尾带着保留策略，校验用收尾的结果', async () => {
    const f = fixture()
    expect((await f.start()).outcome).toBe('done')
    const pin = (await f.pin())!
    expect(f.seen.openRun).toHaveLength(1)
    const [row, options] = f.seen.openRun[0]!
    // Refused rows go back to the engine instead of becoming load blocks.
    expect(options).toEqual({ resolution: 'automatic' })
    expect(row.migrationPlanDigest).toBe(pin.planDigest)
    expect(row.approvalDigest).toBe(pin.approvalDigest)
    // The run is registered with the plan the prepared conversion fixed.
    expect(row.conversionPlan.resolution).toBe('automatic')
    expect(row.conversionPlan.digest).toBe(f.control.run!.conversionPlan.digest)
    // Finalizing resolves dangling references with the assembled keep policies …
    expect(f.seen.finalize).toHaveLength(1)
    expect(f.seen.finalize[0]!.dangling).toEqual({ policies: f.deps.conversion.references! })
    // … and validating is handed that report, so it does not finalize the target again.
    expect(f.seen.validate).toHaveLength(1)
    expect(f.seen.validate[0]!.finalized).toMatchObject({
      version: 1,
      runId: row.runId,
      catalogAdmitted: true,
      dispositions: [],
    })
  })

  test('没有可以准备的转换时不退回到分段流程，而是以带代码的错误结束', async () => {
    const f = fixture()
    f.deps.conversion = { ...f.deps.conversion, prepare: undefined }
    const result = await f.start()
    expect(result).toMatchObject({
      outcome: 'error',
      exitCode: 1,
      operationId: f.operationId,
      code: 'v3-direct-conversion-prepare-required',
      artifactRoot: f.deps.journal.operationRoot(f.operationId),
    })
    // RFC-626 §3.6: the reason in words, then the code, the operation and where its files are.
    expect(result.guidance[0]).toBe(
      'Automatic database upgrade failed: v3-direct-conversion-prepare-required (internal)',
    )
    expect(result.guidance[1]).toBe(
      `error code v3-direct-conversion-prepare-required; operation ${f.operationId}; ` +
        `artifacts in ${f.deps.journal.operationRoot(f.operationId)}`,
    )
    expect(result.guidance[2]).toContain('db migration auto')
    expect(f.calls.stagedConversion).toBe(0)
    expect(f.calls.dryRun).toBe(0)
    expect(f.calls.targetCreate).toBe(0)
  })
})

describe('RFC-626 —— 执行之前的计划是静态的', () => {
  test('不预演、不数未完成任务、不拿整份需求再比一次磁盘', async () => {
    const f = fixture()
    f.deps.measureCapacity = async () => ({
      sourceBytes: 1000,
      availableBytes: 10,
      operationBytes: 5,
    })
    const view = await f.app.plan({})
    expect(f.calls.dryRun).toBe(0)
    expect(f.calls.prepare).toBe(0)
    expect(f.calls.freeze).toBe(1)
    expect(f.calls.discover).toBe(0)
    const p = view.plan.payload
    // Which rule converts which table, for which no row was read.
    expect(p.conversionPlan.resolution).toBe('automatic')
    expect(p.conversionPlan.settlements).toEqual([])
    expect(p.restrictions).toEqual([])
    expect(p.unfinishedTasks).toEqual([])
    expect(p.resolutions).toBeUndefined()
    expect(p.validation).toBeNull()
    // The space was judged before the session was recorded; here the copies already exist.
    expect(p.blocks.map((item) => item.block.code)).toEqual([])
    const capacity = estimateDirectUpgradeCapacity({
      liveBytes: 1000,
      contentFiles: 0,
      targetOnOperationFilesystem: true,
      artifactHardLinks: true,
    })
    expect(p.estimates).toEqual({
      sourceBytes: 1000,
      targetBytes: capacity.targetBytes,
      backupBytes: 1000,
      stagingBytes: 3000,
      requiredBytes: capacity.requiredBytes,
      availableBytes: 10,
      rehearsalMs: null,
      maintenanceMs: null,
      components: {
        operationBytes: 5,
        runBackupBytes: 0,
        switchBackupBytes: 1000,
        artifactMirrorBytes: 0,
        targetFilesystemBytes: capacity.targetBytes,
      },
    })
    expect(view.requiresApproval).toBe(true)
  })

  test('人工流程的计划照旧预演，空间不足照旧是阻塞项', async () => {
    const f = fixture({ direct: false })
    f.deps.measureCapacity = async () => ({
      sourceBytes: 1000,
      availableBytes: 10,
      operationBytes: 5,
    })
    f.scenario.stagingPeakBytes = 100
    const view = await f.app.plan({})
    expect(f.calls.dryRun).toBe(1)
    expect(f.calls.discover).toBe(1)
    expect(f.calls.freeze).toBe(0)
    const p = view.plan.payload
    expect(p.blocks.map((item) => item.block.code)).toEqual(['v3-capacity'])
    expect(p.estimates.stagingBytes).toBe(100)
    expect(typeof p.estimates.rehearsalMs).toBe('number')
    expect(p.conversionPlan.resolution).toBeUndefined()
    expect(Object.hasOwn(p.conversionPlan, 'settlements')).toBe(false)
  })
})

describe('RFC-626 —— 实际结果的计划当场批准', () => {
  test('会话在场时执行步只进入一次：不重开旧库、不重采启动事实、不重验内容', async () => {
    const f = fixture()
    expect((await f.start()).outcome).toBe('done')
    expect(f.seen.runs).toEqual([
      {
        approve: (await f.pin())!.approvalDigest,
        newRun: false,
        phase: 'planned',
        ordinal: 0,
        failure: null,
      },
    ])
    expect(f.calls.freeze).toBe(2)
    expect(f.calls.bootCapture).toBe(2)
    expect(f.calls.verifyContent).toBe(0)
    // The session never had to ask for the pending plan.
    expect(f.calls.status).toBe(0)
    // Two plans, each evaluated and approved once: the one before the run and the actual one.
    const session = await f.session()
    const evaluations = session.records.filter((record) => record.kind === 'plan-evaluated')
    expect(evaluations.map((record) => record.data.reapproval)).toEqual([false, true])
    const actual = await f.plan()
    expect(evaluations[1]!.data.approvalDigest).toBe(actual.approvalDigest)
    expect(evaluations[0]!.data.approvalDigest).not.toBe(actual.approvalDigest)
    const journal = await f.journal()
    expect(journal.payload.plan!.approvedDigest).toBe(actual.approvalDigest)
    expect(journal.payload.approvals!.map((approval) => approval.payload.approvalDigest)).toEqual([
      evaluations[0]!.data.approvalDigest as string,
      actual.approvalDigest,
    ])
    // The callback is the session's and lasts as long as its loop.
    expect(f.deps.approveActualPlan).toBeUndefined()
  })

  test('没有会话的回调时执行步照旧停在待批准，批准后再进入要把这三件事重做一遍', async () => {
    const f = fixture()
    const view = await f.app.plan({})
    const stopped = await f.app.run({
      operationId: f.operationId,
      approve: view.plan.approvalDigest,
    })
    expect(stopped.phase).toBe('validated')
    expect(stopped.status).toBe('awaiting-approval')
    expect(stopped.approval!.approvalDigest).toBe((await f.plan()).approvalDigest)
    expect(f.calls.freeze).toBe(2)
    expect(f.calls.bootCapture).toBe(2)
    expect(f.calls.verifyContent).toBe(0)
    const activated = await f.app.run({
      operationId: f.operationId,
      approve: stopped.approval!.approvalDigest,
    })
    expect(activated.phase).toBe('activated')
    expect(f.calls.freeze).toBe(3)
    expect(f.calls.bootCapture).toBe(3)
    expect(f.calls.verifyContent).toBe(1)
    // The conversion itself was not repeated.
    expect(f.calls.prepare).toBe(1)
    expect(f.calls.finalize).toBe(1)
    expect(f.calls.validate).toBe(1)
  })

  test('回调没有给出批准时执行步停在待批准；会话在循环里遇到同一份计划，复用已有的评估与批准记录', async () => {
    const f = fixture()
    const approved: string[] = []
    const result = await f.start({
      application: {
        ...f.app,
        async run(input) {
          // The session's own callback records its decision; its answer is withheld here, as
          // if the run had not been told.
          const callback = f.deps.approveActualPlan!
          f.deps.approveActualPlan = async (request) => {
            approved.push(request.plan.approvalDigest)
            await callback(request)
            return null
          }
          try {
            return await f.app.run(input)
          } finally {
            f.deps.approveActualPlan = callback
          }
        },
      },
    })
    // The run returned awaiting approval; the session then met the same plan in its loop,
    // found it evaluated and approved, and gave the approval the ordinary way.
    expect(result.outcome).toBe('done')
    expect(approved).toHaveLength(1)
    expect(f.calls.run).toBe(2)
    expect(f.seen.runs[1]).toMatchObject({ phase: 'validated', approve: approved[0] })
    const session = await f.session()
    expect(
      session.records.filter(
        (record) => record.kind === 'plan-evaluated' && record.data.reapproval === true,
      ),
    ).toHaveLength(1)
  })
})

describe('RFC-626 —— 进度输出：各阶段各出现一次、按顺序', () => {
  test('freeze → content-capture → backup → conversion / load → validation → activation', async () => {
    const f = fixture()
    expect((await f.start()).outcome).toBe('done')
    expect(f.boundaries()).toEqual([
      'freeze:source frozen',
      'content-capture:inventory',
      'backup:final backup',
      'backup:final backup complete',
      'conversion:0 unfinished task(s) ended by the upgrade',
      'load:start',
      'conversion:0 row(s) set aside, 0 content reference(s) recorded as missing',
      'load:complete',
      'validation:constraints and content',
      'validation:complete',
      'activation:prepare',
      'activation:activated',
      // The check after the switch belongs to the activation, not to a second validation.
      'activation:verify target',
      'activation:verified',
    ])
    // Conversion and load are one stage: the conversion writes straight into the new database.
    const stages = f
      .boundaries()
      .map((line) => line.split(':')[0]!)
      .map((phase) => (phase === 'load' ? 'conversion' : phase))
      .filter((phase, index, all) => phase !== all[index - 1])
    expect(stages).toEqual([
      'freeze',
      'content-capture',
      'backup',
      'conversion',
      'validation',
      'activation',
    ])
    // Writers were stopped before the session began: nothing announces stopping them.
    expect(f.boundaries()).not.toContain('freeze:quiesce writers')
  })

  test('两条新增的消息带着条数：被结束的任务、封存的行与缺失的内容', async () => {
    const f = fixture()
    f.scenario.settlements = [
      {
        taskId: 'task_b',
        cause: 'unprovable-records',
        originalStatus: 'running',
        blockCodes: ['v2-run-unprovable'],
        parentTaskId: null,
      },
      {
        taskId: 'task_c',
        cause: 'parent-cascade',
        originalStatus: 'pending',
        blockCodes: [],
        parentTaskId: 'task_b',
      },
    ]
    f.scenario.resolutions = {
      settledTasks: f.scenario.settlements,
      setAside: { total: 7, rows: [] },
      missingContent: { total: 3, rows: [] },
      kept: { total: 0, byCode: {}, rows: [] },
      acknowledged: { total: 0, byCode: {} },
    }
    expect((await f.start()).outcome).toBe('done')
    expect(f.boundaries()).toContain('conversion:2 unfinished task(s) ended by the upgrade')
    expect(f.boundaries()).toContain(
      'conversion:7 row(s) set aside, 3 content reference(s) recorded as missing',
    )
  })
})

describe('RFC-626 —— 人工流程不受影响（没有 direct 时每一步照旧）', () => {
  test('计划时预演与在线备份、停写、冻结后再盘点再预演，分段转换；没有钉住的计划', async () => {
    const f = fixture({ direct: false })
    const view = await f.app.plan({})
    const status = await f.app.run({
      operationId: f.operationId,
      approve: view.plan.approvalDigest,
    })
    expect(status.phase).toBe('activated')
    await f.app.verify({ operationId: f.operationId })

    // Plan on the running database, back it up, then do it again once writers have stopped.
    expect(f.calls.discover).toBe(2)
    expect(f.calls.freeze).toBe(1)
    expect(f.calls.capture).toBe(3)
    expect(f.calls.dryRun).toBe(2)
    expect(f.calls.backupCreate).toBe(1)
    expect(f.calls.backupMatches).toBe(2)
    expect(f.calls.stagedConversion).toBe(1)
    expect(f.seen.boot.map((capture) => capture.stage)).toEqual(['plan', 'freeze', 'run'])
    // Nothing of the single-pass flow.
    expect(f.calls.prepare).toBe(0)
    expect(f.calls.convert).toBe(0)
    expect(f.calls.retire).toBe(0)
    expect(await f.pin()).toBeNull()
    // No request carries the automatic resolution.
    expect(f.seen.freeze.map((request) => request.resolution)).toEqual([undefined])
    expect(f.seen.freeze[0]!.expected).toBeUndefined()
    expect(f.seen.contentOpen).toEqual([undefined, undefined])
    expect(f.seen.backup).toEqual([undefined])
    expect(f.seen.boot.map((capture) => capture.resolution)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect(f.seen.openRun).toHaveLength(1)
    expect(f.seen.openRun[0]![1]).toBeUndefined()
    expect(f.seen.finalize.map((input) => input.dangling)).toEqual([undefined])
    expect(f.seen.validate.map((input) => input.finalized)).toEqual([undefined])
    const journal = await f.journal()
    const run = `runs/${journal.payload.run!.runId}`
    expect(await f.artifact(`${run}/backup-live.json`)).not.toBeNull()
    expect(await f.artifact(`${run}/backup-final.json`)).toBeNull()
    expect((await f.plan()).payload.resolutions).toBeUndefined()

    // The runner's own progress lines, as before RFC-626 (rfc395-t19-migration-prep).
    const own = f
      .boundaries()
      .filter((line) => line !== 'freeze:source frozen' && line !== 'content-capture:inventory')
    expect(own).toEqual([
      'backup:live backup',
      'backup:live backup complete',
      'freeze:quiesce writers',
      'load:start',
      'load:complete',
      'validation:constraints and content',
      'validation:complete',
      'activation:prepare',
      'activation:activated',
      'validation:verify target',
      'validation:verified',
    ])
  })

  test('人工流程在 planned 阶段照旧可以重新计划', async () => {
    const f = fixture({ direct: false })
    const first = await f.app.plan({})
    const again = await f.app.plan({ operationId: f.operationId })
    expect(again.plan.approvalDigest).toBe(first.plan.approvalDigest)
    expect((await f.journal()).payload.phase).toBe('planned')
    expect(f.calls.discover).toBe(2)
  })
})

describe('RFC-626 —— 源码层兜底：单遍路径里没有预演，新行为都以 direct 为条件', () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, '../src', path), 'utf8')
  const runner = read('modules/system-operations/application/epochSwitch/runner.ts')
  const planner = read('modules/system-operations/application/epochSwitch/planner.ts')

  test('执行步的单遍分支不预演、不做在线发现、不走分段转换', () => {
    const start = runner.indexOf('async function convertDirectly(')
    const end = runner.indexOf('export function activationPointer(')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const direct = runner.slice(start, end)
    expect(direct).not.toContain('dryRun(')
    expect(direct).not.toContain('.discover(')
    expect(direct).not.toContain('conversion.run(')
    expect(direct).toContain('conversion.prepare(')
    // One finalize and one validate call in the whole branch.
    expect(direct.match(/target\.finalize\(/g)).toHaveLength(1)
    expect(direct.match(/target\.validate\(/g)).toHaveLength(1)
    expect(direct.match(/createBackup\(/g)).toHaveLength(1)
  })

  test('计划步只在非 direct 时预演；direct 只由自动升级的装配设置', () => {
    expect(planner).toContain(
      'const rehearsal = session.deps.direct ? null : await session.deps.conversion.dryRun(request)',
    )
    expect(planner).toContain('? await sourcePort(session).freeze(sourceInput)')
    expect(runner).toContain("if (!deps.direct && session.journal.payload.phase === 'planned')")
    const assembly = read('bootstrap/epochMigration.ts')
    expect(assembly).toContain('...(options.autoUpgrade === true ? { direct: true } : {})')
    expect(assembly.match(/direct: true/g)).toHaveLength(1)
    const automatic = read('bootstrap/epochMigrationAuto.ts')
    expect(automatic).toContain('autoUpgrade: true')
    expect(automatic).toContain('environment: createAutoUpgradeEnvironment()')
    // The entry of the manual command and of the hosted Job never asks for it.
    expect(read('bootstrap/epochMigrationEntry.ts')).not.toContain('direct: true')
  })
})
