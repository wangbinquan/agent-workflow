// RFC-626 §4.2 (plan T3): an upgrade that is continued by another binary.
//
// Why this file exists: "the release that was shipped first fails half-way, the fixed release is
// started on the same installation" is the path an upgrade has to get through by itself. Before
// RFC-626 a run that another converter or target contract had begun stopped at an internal
// binding error (`v3-run-binding-mismatch`), and every later start stopped at the same place.
// Now:
//  - before the plan is pinned nothing is bound to a binary: the plan is simply made again;
//  - from the pin until the activation receipt is published the pinned candidate build,
//    converter version, target contract and target structure are compared with the running
//    binary before anything is opened; a difference is recorded as the failure
//    `v3-conversion-material-changed-new-run-required` FIRST, and only then a new run is
//    started, whose first act is to retire the half-built database by its stored identity
//    (this binary may be unable to open it);
//  - the rule set, which needs the open source, is compared where the run is opened and again
//    before the activation receipt is written;
//  - once the activation receipt is published nothing is compared: the receipt is read back.
import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { directRunMismatch } from '@/modules/system-operations/application/epochSwitch/session'
import type { EpochTargetProvisioningPort } from '@/modules/system-operations/application/ports/epochSwitch'
import { classifyAutoUpgradeRun } from '@/modules/system-operations/domain/epochSwitch/autoUpgrade'
import { parseActivationReceipt } from '@/modules/system-operations/domain/epochSwitch/documents'
import { EpochSwitchError } from '@/modules/system-operations/domain/epochSwitch/model'
import { CONVERSION_MATERIAL_CHANGED } from '@/modules/system-operations/domain/epochSwitch/planPin'
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
const NEXT_CONTRACT = valueDigest('target contract of the next release')
const NEXT_RULES = valueDigest('rule set of the next converter')

/** Dies at the point, and comes back as the process of another release would. */
async function interrupt(
  f: DirectSwitchFixture,
  at: Parameters<DirectSwitchFixture['killAt']>[0],
): Promise<{ runId: string; generationId: string; runs: number; opened: number }> {
  f.killAt(at)
  expect((await f.start()).outcome).toBe('error')
  f.disarm()
  const journal = await f.journal()
  return {
    runId: journal.payload.run!.runId,
    generationId: journal.payload.target.generationId!,
    runs: f.seen.runs.length,
    opened: f.seen.opened.length,
  }
}
/** The `run` calls made since the interruption, as what the journal said when each was made. */
const since = (f: DirectSwitchFixture, from: number) =>
  f.seen.runs
    .slice(from)
    .map(({ newRun, ordinal, failure, phase }) => ({ newRun, ordinal, failure, phase }))

describe('RFC-626 —— 这类失败被归为「新建一轮运行」', () => {
  test('代码以 -new-run-required 结尾；记在日志里的失败与抛出的错误同样归类', () => {
    expect(CONVERSION_MATERIAL_CHANGED).toBe('v3-conversion-material-changed-new-run-required')
    expect(
      classifyAutoUpgradeRun(
        new EpochSwitchError(CONVERSION_MATERIAL_CHANGED, { category: 'source-changed' }),
      ),
    ).toBe('new-run')
    // What the journal keeps of it, read back by a process that starts later.
    expect(
      classifyAutoUpgradeRun({
        phase: 'converting',
        category: 'source-changed',
        detailCode: CONVERSION_MATERIAL_CHANGED,
        retryable: false,
        failedAt: 1,
      }),
    ).toBe('new-run')
    expect(classifyAutoUpgradeRun({ detailCode: CONVERSION_MATERIAL_CHANGED })).toBe('new-run')
    // The binding error it replaces was an ordinary error, met again on every start.
    expect(classifyAutoUpgradeRun(new Error('v3-run-binding-mismatch'))).toBe('error')
  })
})

describe('RFC-626 —— 计划钉住之前换二进制：重新计划即可', () => {
  test('计划已保存、尚未钉住：新二进制重新生成计划，仍是同一轮运行', async () => {
    const f = fixture()
    const before = await interrupt(f, { checkpoint: 'phase-planned' })
    f.deps.candidateBuild = 'candidate-2'
    f.deps.targetContractDigest = NEXT_CONTRACT
    expect(await directRunMismatch(f.deps, await f.journal())).toEqual([])
    expect((await f.start()).outcome).toBe('done')
    const journal = await f.journal()
    expect(journal.payload.run!.runId).toBe(before.runId)
    expect(journal.payload.run!.ordinal).toBe(0)
    expect(f.calls.retire).toBe(0)
    expect(f.seen.runs.some((call) => call.newRun)).toBe(false)
    expect(await f.pin()).toMatchObject({
      candidateBuild: 'candidate-2',
      targetContractDigest: NEXT_CONTRACT,
    })
    expect(f.control.run!.conversionPlan.candidateBuild).toBe('candidate-2')
  })

  test('计划已批准、尚未钉住：新二进制的计划是另一份材料，重新评估、批准一次', async () => {
    const f = fixture()
    let dying = true
    f.scenario.beforeRun = () => {
      if (!dying) return
      dying = false
      throw killed()
    }
    expect((await f.start()).outcome).toBe('error')
    f.deps.candidateBuild = 'candidate-2'
    expect((await f.start()).outcome).toBe('done')
    expect((await f.journal()).payload.run!.ordinal).toBe(0)
    const session = await f.session()
    const evaluations = session.records.filter((record) => record.kind === 'plan-evaluated')
    // The plan of the first binary, the plan of the second, and the actual result.
    expect(evaluations.map((record) => record.data.reapproval)).toEqual([false, false, true])
    expect(evaluations[1]!.data.approvalDigest).not.toBe(evaluations[0]!.data.approvalDigest)
    expect((await f.pin())!.approvalDigest).toBe(evaluations[1]!.data.approvalDigest as string)
  })
})

describe('RFC-626 —— 钉住之后、激活回执发布之前换二进制：先落失败，再新建一轮运行', () => {
  test('已钉住、新库还没建：没有可退役的东西，新一轮从计划步重做', async () => {
    const f = fixture()
    const before = await interrupt(f, { checkpoint: 'plan-pinned' })
    f.deps.candidateBuild = 'candidate-2'
    expect(await directRunMismatch(f.deps, await f.journal())).toEqual(['candidateBuild'])
    expect((await f.start()).outcome).toBe('done')

    expect(since(f, before.runs)).toEqual([
      // The comparison is an ordinary step that fails, so its failure is in the journal …
      { newRun: false, ordinal: 0, failure: null, phase: 'planned' },
      // … before the new run is started.
      { newRun: true, ordinal: 0, failure: CONVERSION_MATERIAL_CHANGED, phase: 'planned' },
      { newRun: false, ordinal: 1, failure: null, phase: 'planned' },
    ])
    expect(f.checkpoints.lastIndexOf('failure-source-changed')).toBeGreaterThan(-1)
    expect(f.checkpoints.lastIndexOf('failure-source-changed')).toBeLessThan(
      f.checkpoints.lastIndexOf('plan'),
    )
    const journal = await f.journal()
    expect(journal.payload.run!.ordinal).toBe(1)
    expect(journal.payload.run!.runId).not.toBe(before.runId)
    expect(journal.payload.failure).toBeNull()
    expect(f.calls.retire).toBe(0)
    expect(f.seen.created).toEqual([journal.payload.target.generationId!])
    // Each run has its own pin; the one of the run that was given up is still what it was.
    expect(await f.pin()).toMatchObject({
      runId: journal.payload.run!.runId,
      candidateBuild: 'candidate-2',
    })
    expect(
      JSON.parse(
        Buffer.from((await f.artifact(`runs/${before.runId}/plan-pinned.json`))!).toString('utf8'),
      ),
    ).toMatchObject({ runId: before.runId, candidateBuild: 'candidate' })
    // The new run was planned once: by starting it.
    expect(f.calls.capture).toBe(2)
  })

  test('转换中换了目标契约：旧的新库凭代际身份退役，不按当前契约打开它', async () => {
    const f = fixture()
    const before = await interrupt(f, { fault: 'after-rows' })
    expect(f.seen.created).toEqual([before.generationId])
    f.deps.candidateBuild = 'candidate-2'
    f.deps.targetContractDigest = NEXT_CONTRACT
    expect(await directRunMismatch(f.deps, await f.journal())).toEqual([
      'candidateBuild',
      'targetContractDigest',
    ])
    expect((await f.start()).outcome).toBe('done')

    expect(since(f, before.runs)).toEqual([
      { newRun: false, ordinal: 0, failure: null, phase: 'converting' },
      { newRun: true, ordinal: 0, failure: CONVERSION_MATERIAL_CHANGED, phase: 'converting' },
      { newRun: false, ordinal: 1, failure: null, phase: 'planned' },
    ])
    // Retired by the identity the journal stored …
    expect(f.calls.retire).toBe(1)
    expect(f.seen.retire).toEqual([before.generationId])
    // … and never opened by the binary whose contract it was not built with.
    expect(
      f.seen.opened
        .slice(before.opened)
        .filter((open) => open.generationId === before.generationId),
    ).toEqual([])
    const journal = await f.journal()
    expect(journal.payload.run!.ordinal).toBe(1)
    expect(journal.payload.target.generationId).not.toBe(before.generationId)
    expect(f.seen.created).toEqual([before.generationId, journal.payload.target.generationId!])
    // The new database is the new binary's.
    expect(f.control.run!.conversionPlan).toMatchObject({
      candidateBuild: 'candidate-2',
      targetContractDigest: NEXT_CONTRACT,
    })
    expect(f.control.state).toBe('active')
    expect((await f.plan()).payload.target.contractDigest).toBe(NEXT_CONTRACT)
  })

  test('目标库的结构摘要变了同样算换了二进制', async () => {
    const f = fixture()
    const before = await interrupt(f, { checkpoint: 'conversion-finished' })
    f.deps.targetPlanDigest = () => NEXT_CONTRACT
    expect(await directRunMismatch(f.deps, await f.journal())).toEqual(['targetPlanDigest'])
    expect((await f.start()).outcome).toBe('done')
    expect(f.seen.retire).toEqual([before.generationId])
    expect((await f.journal()).payload.run!.ordinal).toBe(1)
    expect((await f.pin())!.targetPlanDigest).toBe(NEXT_CONTRACT)
  })

  test('钉住文件里的转换器版本与当前的不同', async () => {
    const f = fixture()
    const before = await interrupt(f, { fault: 'after-rows' })
    const path = f.artifactPath(`runs/${before.runId}/plan-pinned.json`)
    const pin = (await f.pin())!
    // What the pin of the previous converter release holds.
    rmSync(path)
    writeFileSync(path, JSON.stringify({ ...pin, converterVersion: 'rfc395-v2@1' }))
    expect(await directRunMismatch(f.deps, await f.journal())).toEqual(['converterVersion'])
    expect((await f.start()).outcome).toBe('done')
    expect(f.seen.retire).toEqual([before.generationId])
    expect((await f.journal()).payload.run!.ordinal).toBe(1)
    expect((await f.pin())!.converterVersion).toBe(pin.converterVersion)
  })

  test('读不出的钉住文件按四项都不同处理', async () => {
    const f = fixture()
    const before = await interrupt(f, { checkpoint: 'plan-pinned' })
    const path = f.artifactPath(`runs/${before.runId}/plan-pinned.json`)
    rmSync(path)
    writeFileSync(
      path,
      JSON.stringify({ version: 2, format: 'of a release this one does not know' }),
    )
    expect(await directRunMismatch(f.deps, await f.journal())).toEqual([
      'candidateBuild',
      'converterVersion',
      'targetContractDigest',
      'targetPlanDigest',
    ])
    expect((await f.start()).outcome).toBe('done')
    expect((await f.journal()).payload.run!.ordinal).toBe(1)
  })

  test('执行已经开始却没有钉住的计划（不是单遍流程开始的运行）同样放弃这一轮', async () => {
    const f = fixture()
    const before = await interrupt(f, { checkpoint: 'phase-backed-up' })
    rmSync(f.artifactPath(`runs/${before.runId}/plan-pinned.json`))
    expect(await directRunMismatch(f.deps, await f.journal())).toEqual(['plan-not-pinned'])
    expect((await f.start()).outcome).toBe('done')
    expect(since(f, before.runs)[1]).toEqual({
      newRun: true,
      ordinal: 0,
      failure: CONVERSION_MATERIAL_CHANGED,
      phase: 'backed-up',
    })
    expect((await f.journal()).payload.run!.ordinal).toBe(1)
    // No new database had been built for the run that was given up.
    expect(f.calls.retire).toBe(0)
  })

  test('实际结果的计划待批准时换了目标契约：在读取待批准计划之前就比较出来', async () => {
    const f = fixture()
    const before = await interrupt(f, { checkpoint: 'awaiting-approval' })
    expect((await f.journal()).payload).toMatchObject({
      phase: 'validated',
      status: 'awaiting-approval',
    })
    f.deps.targetContractDigest = NEXT_CONTRACT
    // Asking for the status of this run opens its new database under the current contract,
    // which fails and leaves no failure the session could act on.
    await expect(f.app.status({ operationId: f.operationId })).rejects.toThrow(
      'v3-target-generation-mismatch',
    )
    const asked = f.calls.status
    expect((await f.start()).outcome).toBe('done')
    expect(f.calls.status).toBe(asked)
    expect(since(f, before.runs).slice(0, 2)).toEqual([
      { newRun: false, ordinal: 0, failure: null, phase: 'validated' },
      { newRun: true, ordinal: 0, failure: CONVERSION_MATERIAL_CHANGED, phase: 'validated' },
    ])
    expect(f.seen.retire).toEqual([before.generationId])
    expect((await f.journal()).payload.run!.ordinal).toBe(1)
  })
})

describe('RFC-626 —— 规则集在源打开之后比较（第二道）', () => {
  test('转换中：准备出的转换计划与新库里登记的运行不是同一套规则', async () => {
    const f = fixture()
    const before = await interrupt(f, { fault: 'after-rows' })
    f.scenario.ruleSetDigest = NEXT_RULES
    // The four pinned values are the same: only the open source shows the difference.
    expect(await directRunMismatch(f.deps, await f.journal())).toEqual([])
    expect((await f.start()).outcome).toBe('done')
    expect(since(f, before.runs)).toEqual([
      { newRun: false, ordinal: 0, failure: null, phase: 'converting' },
      { newRun: true, ordinal: 0, failure: CONVERSION_MATERIAL_CHANGED, phase: 'converting' },
      { newRun: false, ordinal: 1, failure: null, phase: 'planned' },
    ])
    expect(f.seen.retire).toEqual([before.generationId])
    expect(f.control.run!.conversionPlan.ruleSetDigest).toBe(NEXT_RULES)
    // The conversion prepared for the comparison was closed again.
    expect(f.calls.prepareClosed).toBe(f.calls.prepare)
    // Nothing of the old run was converted further before the difference was found.
    expect(f.calls.finalize).toBe(1)
  })

  test('validated 之后：比较先于写激活回执，所以还能新建运行', async () => {
    const f = fixture()
    const before = await interrupt(f, { checkpoint: 'awaiting-approval' })
    f.scenario.ruleSetDigest = NEXT_RULES
    expect(await f.artifact('activation-receipt.json')).toBeNull()
    expect((await f.start()).outcome).toBe('done')
    const journal = await f.journal()
    expect(journal.payload.run!.ordinal).toBe(1)
    expect(f.seen.retire).toEqual([before.generationId])
    // The receipt is written once per operation. Had the old run published one, the new run
    // could not have written its own.
    const receipt = parseActivationReceipt(
      Buffer.from((await f.artifact('activation-receipt.json'))!).toString('utf8'),
    )
    expect(receipt.payload.runId).toBe(journal.payload.run!.runId)
    expect(receipt.payload.runId).not.toBe(before.runId)
  })

  test('规则集没有变时续做不受这道比较影响', async () => {
    const f = fixture()
    await interrupt(f, { checkpoint: 'awaiting-approval' })
    expect((await f.start()).outcome).toBe('done')
    expect((await f.journal()).payload.run!.ordinal).toBe(0)
    expect(f.calls.retire).toBe(0)
  })
})

// Implementation gate G4-4: the stored identity used to be taken only when the failure in the
// journal was the binary change itself. A run given up for another reason first (the source
// changed during the conversion) and then continued by a binary with another target contract
// opened the old new database under the current contract (`v3-target-generation-mismatch`),
// and that start failed. Every new run now compares the pin before it is allocated.
describe('RFC-626 —— 别的「新建运行」类失败已在日志里，随后换了二进制', () => {
  /** The conversion finds the source changed; the process dies before the new run starts. */
  async function sourceChangedThenKilled(f: DirectSwitchFixture) {
    let changed = true
    f.control.inject = (reached) => {
      if (reached !== 'after-rows' || !changed) return
      changed = false
      throw new EpochSwitchError('v3-source-changed', { category: 'source-changed' })
    }
    f.scenario.beforeRun = (input) => {
      if (input.newRun) throw killed()
    }
    expect((await f.start()).outcome).toBe('error')
    f.disarm()
    const journal = await f.journal()
    expect(journal.payload.failure).toMatchObject({ detailCode: 'v3-source-changed' })
    expect(classifyAutoUpgradeRun(journal.payload.failure)).toBe('new-run')
    return {
      runId: journal.payload.run!.runId,
      generationId: journal.payload.target.generationId!,
      phase: journal.payload.phase,
      runs: f.seen.runs.length,
      opened: f.seen.opened.length,
    }
  }

  test('目标契约变了：旧的新库凭代际身份退役，不按当前契约打开它', async () => {
    const f = fixture()
    const before = await sourceChangedThenKilled(f)
    expect(f.seen.created).toEqual([before.generationId])
    f.deps.candidateBuild = 'candidate-2'
    f.deps.targetContractDigest = NEXT_CONTRACT
    expect(await directRunMismatch(f.deps, await f.journal())).toEqual([
      'candidateBuild',
      'targetContractDigest',
    ])
    expect((await f.start()).outcome).toBe('done')
    // Straight to the new run: the failure in the journal already says "new run".
    expect(since(f, before.runs)).toEqual([
      { newRun: true, ordinal: 0, failure: 'v3-source-changed', phase: before.phase },
      { newRun: false, ordinal: 1, failure: null, phase: 'planned' },
    ])
    expect(f.seen.retire).toEqual([before.generationId])
    expect(
      f.seen.opened
        .slice(before.opened)
        .filter((open) => open.generationId === before.generationId),
    ).toEqual([])
    const journal = await f.journal()
    expect(journal.payload.run!.ordinal).toBe(1)
    expect(journal.payload.target.generationId).not.toBe(before.generationId)
    expect(f.control.state).toBe('active')
    expect((await f.plan()).payload.target.contractDigest).toBe(NEXT_CONTRACT)
  })

  test('二进制没有换：照旧打开旧的新库、确认没写过再退役，不走代际身份', async () => {
    const f = fixture()
    const before = await sourceChangedThenKilled(f)
    expect(await directRunMismatch(f.deps, await f.journal())).toEqual([])
    expect((await f.start()).outcome).toBe('done')
    expect(f.calls.retire).toBe(0)
    expect(
      f.seen.opened
        .slice(before.opened)
        .filter((open) => open.generationId === before.generationId),
    ).toEqual([{ generationId: before.generationId, admitted: true }])
    expect((await f.journal()).payload.run!.ordinal).toBe(1)
  })
})

describe('RFC-626 —— 新建运行做到一半被杀', () => {
  test('旧的新库已退役、日志还没改写：重启后不再去准备已退役的代际，把新建运行做完', async () => {
    const f = fixture()
    const before = await interrupt(f, { fault: 'after-rows' })
    f.deps.candidateBuild = 'candidate-2'
    f.deps.targetContractDigest = NEXT_CONTRACT
    let dying = true
    f.scenario.afterRetire = () => {
      if (!dying) return
      dying = false
      throw killed()
    }
    expect((await f.start()).outcome).toBe('error')
    // The old run is still the journal's run, with the failure that was recorded first.
    const half = await f.journal()
    expect(half.payload.run!.runId).toBe(before.runId)
    expect(half.payload.failure).toMatchObject({
      category: 'source-changed',
      detailCode: CONVERSION_MATERIAL_CHANGED,
    })
    expect(f.control.state).toBe('retired')
    const restarted = f.seen.runs.length

    // On PostgreSQL the session prepares the databases of its run before it enters the loop,
    // and preparing a retired generation is refused every time. With the failure in the
    // journal that step is skipped. The probe reports that provider for this start only, so
    // that the condition is the one a PostgreSQL installation meets.
    let prepares = 0
    const provisioning: EpochTargetProvisioningPort = {
      async prepare() {
        prepares++
        throw new Error('the retired generation must not be prepared again')
      },
      retained: async () => [],
      async nextTargetLocation() {
        throw new Error('not asked: the fixture run keeps its location')
      },
    }
    const installation = f.deps.installation
    f.deps.installation = async () => {
      const observed = await installation()
      return { ...observed, facts: { ...observed.facts, provider: 'postgresql' } }
    }
    expect((await f.start({ provisioning })).outcome).toBe('done')
    expect(prepares).toBe(0)
    // Straight to the new run: the comparison is not made a second time.
    expect(since(f, restarted)).toEqual([
      { newRun: true, ordinal: 0, failure: CONVERSION_MATERIAL_CHANGED, phase: 'converting' },
      { newRun: false, ordinal: 1, failure: null, phase: 'planned' },
    ])
    // Retiring what is already retired is a no-op.
    expect(f.seen.retire).toEqual([before.generationId, before.generationId])
    expect((await f.journal()).payload.run!.ordinal).toBe(1)
  })
})

describe('RFC-626 —— 激活回执发布之后不再比较', () => {
  test('目标契约相同：沿用已发布的回执完成切换与自检，不新建运行', async () => {
    const f = fixture()
    const before = await interrupt(f, { fault: 'after-activation-receipt-file' })
    f.deps.candidateBuild = 'candidate-2'
    expect(await directRunMismatch(f.deps, await f.journal())).toEqual([])
    expect((await f.start()).outcome).toBe('done')
    const journal = await f.journal()
    expect(journal.payload.run!.runId).toBe(before.runId)
    expect(journal.payload.run!.ordinal).toBe(0)
    expect(f.calls.retire).toBe(0)
    expect(f.seen.runs.some((call) => call.newRun)).toBe(false)
    // The receipt is the one the first binary published.
    const receipt = parseActivationReceipt(
      Buffer.from((await f.artifact('activation-receipt.json'))!).toString('utf8'),
    )
    expect(receipt.payload.candidateBuild).toBe('candidate')
    expect(journal.payload.activation!.receiptDigest).toBe(receipt.digest)
  })

  test('目标契约不同：与以前一样以错误结束，不新建运行；用建新库时的版本再启动即可完成', async () => {
    const f = fixture()
    const before = await interrupt(f, { fault: 'after-activation-receipt-file' })
    f.deps.targetContractDigest = NEXT_CONTRACT
    const stuck = await f.start()
    expect(stuck).toMatchObject({
      outcome: 'error',
      exitCode: 1,
      operationId: f.operationId,
      artifactRoot: f.deps.journal.operationRoot(f.operationId),
    })
    expect(stuck.guidance[0]).toBe(
      'Automatic database upgrade failed: v3-target-generation-mismatch',
    )
    expect(stuck.guidance[1]).toBe(
      `operation ${f.operationId}; artifacts in ${f.deps.journal.operationRoot(f.operationId)}`,
    )
    expect(f.calls.retire).toBe(0)
    expect(f.seen.runs.some((call) => call.newRun)).toBe(false)
    expect((await f.journal()).payload.run!.runId).toBe(before.runId)

    f.deps.targetContractDigest = fixtureDigest
    expect((await f.start()).outcome).toBe('done')
    expect((await f.journal()).payload.run!.ordinal).toBe(0)
  })

  test('已经切换之后同样不比较', async () => {
    const f = fixture()
    await interrupt(f, { fault: 'after-activated-journal' })
    f.deps.candidateBuild = 'candidate-2'
    expect(await directRunMismatch(f.deps, await f.journal())).toEqual([])
    expect((await f.start()).outcome).toBe('done')
    expect((await f.journal()).payload.run!.ordinal).toBe(0)
  })
})
