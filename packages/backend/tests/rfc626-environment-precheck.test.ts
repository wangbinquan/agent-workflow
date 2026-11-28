// RFC-626 §3.5 (plan T1): the environment check of the automatic upgrade.
//
// Why this file exists: disk space, the structure of the old database, the right to create a
// PostgreSQL database and an unfinished provider move used to be found out after the session had
// recorded its intent — disk space after a full rehearsal (20 minutes on the reference data),
// the missing right after the allocation files were written. They are judged now after the
// session lock is taken and before anything is recorded. This file locks, for each check:
// the refusal (exit code 3, a message with the numbers, objects or statements), and that it
// leaves nothing behind — no session record, no operation directory, no allocation, no
// database — plus the estimate itself, which is computed from the data in use and not from the
// size of the file.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AutoUpgradeEnvironmentPort,
  EpochTargetProvisioningPort,
  SourcePrecheck,
  SourceSnapshotRequest,
} from '@/modules/system-operations/application/ports/epochSwitch'
import {
  CONTENT_MANIFEST_BYTES_PER_FILE,
  estimateDirectUpgradeCapacity,
  estimateEpochCapacity,
} from '@/modules/system-operations/domain/epochSwitch/capacity'
import {
  capacityRefusal,
  formatByteCount,
  lockOutOfSpaceRefusal,
  sourceOutOfSpace,
  sourceOutOfSpaceRefusal,
  sourceRefusal,
} from '@/modules/system-operations/domain/epochSwitch/environmentPrecheck'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import { writeGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import {
  createAutoUpgradeEnvironment,
  estimateContentFiles,
} from '@/modules/system-operations/infrastructure/local/autoUpgradeEnvironment'
import { runAutomaticEpochUpgrade } from '@/bootstrap/epochMigrationAuto'
import { directSwitchFixture, type DirectSwitchFixture } from './helpers/rfc626DirectSwitch'

const GIB = 1024 ** 3
const fixtures: DirectSwitchFixture[] = []
const homes: string[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function fixture(): DirectSwitchFixture {
  const f = directSwitchFixture()
  fixtures.push(f)
  return f
}
function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'rfc626-precheck-'))
  homes.push(path)
  return path
}

/** A source port whose check answers `result`, on top of the fixture's source. */
function withPrecheck(f: DirectSwitchFixture, result: SourcePrecheck | (() => never)) {
  const requests: SourceSnapshotRequest[] = []
  f.deps.source = {
    ...f.deps.source,
    async precheck(request) {
      requests.push(request)
      return typeof result === 'function' ? result() : result
    },
  }
  return requests
}
const environment = (
  availableBytes: number | null,
  contentFiles = 0,
): AutoUpgradeEnvironmentPort & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    async availableBytes(root) {
      calls.push(`available:${root}`)
      return availableBytes
    },
    async contentFiles() {
      calls.push('content')
      return contentFiles
    },
  }
}

/** The four things a refused check must not leave behind, plus the lock binding. */
async function expectNothingRecorded(f: DirectSwitchFixture) {
  expect(await f.records.list()).toEqual([])
  expect(existsSync(join(f.root, 'database-migrations', 'auto-upgrade', 'sessions'))).toBe(false)
  expect(await f.deps.journal.list()).toEqual([])
  expect(existsSync(f.deps.journal.operationRoot(f.operationId))).toBe(false)
  expect(existsSync(join(f.root, 'database-migrations', 'auto-upgrade', 'allocations'))).toBe(false)
  expect(f.lock.bound).toEqual([])
  expect(f.calls.plan).toBe(0)
  expect(f.calls.freeze + f.calls.discover + f.calls.capture + f.calls.targetCreate).toBe(0)
  // The session lock is taken for the check and given back whatever the outcome.
  expect(f.lock.acquired).toBe(1)
  expect(f.lock.released).toBe(1)
}

describe('RFC-626 —— 所需空间按有效数据量估算', () => {
  test('公式逐项：冻结副本兼备份 1×L、工作副本 1×L、暂存 3×L、新库 1.5×L、清单每文件 750 字节（三份）、10% 余量', () => {
    const capacity = estimateDirectUpgradeCapacity({
      liveBytes: 1_000_000,
      contentFiles: 4_000,
      targetOnOperationFilesystem: true,
      artifactHardLinks: true,
    })
    expect(capacity).toEqual({
      liveBytes: 1_000_000,
      frozenCopyBytes: 1_000_000,
      workingCopyBytes: 1_000_000,
      stagingBytes: 3_000_000,
      targetBytes: 1_500_000,
      targetFilesystemBytes: 1_500_000,
      contentManifestBytes: 4_000 * CONTENT_MANIFEST_BYTES_PER_FILE,
      artifactMirrorBytes: 0,
      marginBytes: 950_000,
      requiredBytes: 10_450_000,
    })
    // Three copies of a listing entry of about 215 bytes.
    expect(CONTENT_MANIFEST_BYTES_PER_FILE).toBe(750)
  })

  test('估算不低于实测：参考实例实际新增占用的峰值在估算值之内', () => {
    // Measured on the reference installation (final binary, three runs): live data
    // 1,142,865,920 bytes, 827,743 content files, peak of the added disk usage 6.71 to 6.85 GiB.
    // The first formula (staging 2 x live, one copy of the listing) asked for 6.65 GiB.
    const capacity = estimateDirectUpgradeCapacity({
      liveBytes: 1_142_865_920,
      contentFiles: 827_743,
      targetOnOperationFilesystem: true,
      artifactHardLinks: true,
    })
    const measuredPeak = 6.85 * GIB
    expect(capacity.requiredBytes).toBeGreaterThan(measuredPeak)
    // …and still below the 10 GB the proposal allows the check to ask for (§6 item 6).
    expect(capacity.requiredBytes).toBeLessThan(10_000_000_000)
  })

  test('新库不在操作目录的文件系统上时不计它；工件库不能硬链接时另加 2×L', () => {
    const remote = estimateDirectUpgradeCapacity({
      liveBytes: 1_000_000,
      contentFiles: 0,
      targetOnOperationFilesystem: false,
      artifactHardLinks: true,
    })
    expect(remote.targetFilesystemBytes).toBe(0)
    expect(remote.targetBytes).toBe(1_500_000)
    // 5 M of parts (two copies and the staging store) and a margin of 500 000.
    expect(remote.requiredBytes).toBe(5_500_000)
    const copied = estimateDirectUpgradeCapacity({
      liveBytes: 1_000_000,
      contentFiles: 0,
      targetOnOperationFilesystem: true,
      artifactHardLinks: false,
    })
    expect(copied.artifactMirrorBytes).toBe(2_000_000)
    // 8.5 M of parts and a margin of 850 000.
    expect(copied.marginBytes).toBe(850_000)
    expect(copied.requiredBytes).toBe(9_350_000)
  })

  test('参考数据：文件 24.7 GB、有效数据 1.07 GB、82.8 万个内容文件，所需不超过 10 GB（原估算 151.8 GB）', () => {
    const capacity = estimateDirectUpgradeCapacity({
      liveBytes: Math.round(1.07 * GIB),
      contentFiles: 827_742,
      targetOnOperationFilesystem: true,
      artifactHardLinks: true,
    })
    expect(capacity.requiredBytes).toBeLessThan(10 * GIB)
    expect(capacity.requiredBytes).toBeGreaterThan(6 * GIB)
    // What the estimate by file size asked for with the same database (proposal §1.2 R5).
    const byFileSize = estimateEpochCapacity({
      sourceBytes: Math.round(24.7 * GIB),
      operationBytes: Math.round(24.7 * GIB),
      stagingPeakBytes: Math.round(9 * 1.07 * GIB),
      availableBytes: null,
      targetOnOperationFilesystem: true,
      localArtifactMirrors: true,
    })
    expect(byFileSize.requiredBytes!).toBeGreaterThan(15 * capacity.requiredBytes)
  })

  test('数值都是非负整数；非法输入按 0 处理', () => {
    const capacity = estimateDirectUpgradeCapacity({
      liveBytes: 1_234_567.25,
      contentFiles: 3.2,
      targetOnOperationFilesystem: true,
      artifactHardLinks: true,
    })
    for (const value of Object.values(capacity)) {
      expect(Number.isSafeInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
    expect(
      estimateDirectUpgradeCapacity({
        liveBytes: Number.NaN,
        contentFiles: -5,
        targetOnOperationFilesystem: true,
        artifactHardLinks: true,
      }).requiredBytes,
    ).toBe(0)
  })

  test('够用时不拒绝；不够时文案写明需要多少、可用多少、在哪个目录、还差多少', () => {
    const capacity = estimateDirectUpgradeCapacity({
      liveBytes: 2 * GIB,
      contentFiles: 0,
      targetOnOperationFilesystem: true,
      artifactHardLinks: true,
    })
    const directory = '/srv/agent-workflow/database-migrations/dbm_e2_x'
    expect(
      capacityRefusal({ capacity, availableBytes: capacity.requiredBytes, directory }),
    ).toBeNull()
    const refusal = capacityRefusal({ capacity, availableBytes: GIB, directory })!
    expect(refusal.reason).toBe('capacity')
    const said = refusal.guidance.join('\n')
    expect(said).toContain(directory)
    expect(said).toContain(`${capacity.requiredBytes} bytes`)
    expect(said).toContain(`${GIB} bytes (1.0 GiB)`)
    expect(said).toContain(`${capacity.requiredBytes - GIB} bytes`)
    expect(said).toContain('nothing was recorded for this upgrade')
    expect(formatByteCount(512)).toBe('512 bytes')
    expect(formatByteCount(1536)).toBe('1536 bytes (1.5 KiB)')
  })
})

describe('RFC-626 —— 内容文件数的估计不遍历全部文件', () => {
  test('每个任务目录文件数相同时估计是准确的，且只读了抽样的目录', () => {
    const root = home()
    for (let task = 0; task < 64; task++) {
      const directory = join(root, 'runs', `task-${String(task).padStart(3, '0')}`, 'node')
      mkdirSync(directory, { recursive: true })
      for (let file = 0; file < 5; file++) writeFileSync(join(directory, `out-${file}.md`), 'x')
    }
    mkdirSync(join(root, 'skills', 'one'), { recursive: true })
    writeFileSync(join(root, 'skills', 'one', 'SKILL.md'), 'x')
    writeFileSync(join(root, 'logs.txt'), 'not a content directory')
    const before = readdirSync(root).sort()
    // 64 task directories of 5 files and one skill file.
    expect(
      estimateContentFiles({ kind: 'app-home', root, runsSupplied: true, objects: 'none' }),
    ).toBe(64 * 5 + 1)
    expect(readdirSync(root).sort()).toEqual(before)
  })

  test('运行内容在另一个根目录时到那里去数；目录都不存在时为 0', () => {
    const root = home()
    const runs = home()
    mkdirSync(join(runs, 'runs', 'task'), { recursive: true })
    writeFileSync(join(runs, 'runs', 'task', 'a'), 'x')
    writeFileSync(join(runs, 'runs', 'task', 'b'), 'x')
    expect(
      estimateContentFiles({
        kind: 'app-home',
        root,
        runContentRoot: runs,
        runsSupplied: true,
        objects: 'none',
      }),
    ).toBe(2)
    expect(
      estimateContentFiles({ kind: 'app-home', root, runsSupplied: true, objects: 'none' }),
    ).toBe(0)
  })

  test('可用空间量的是最近的已存在目录，不创建操作目录', async () => {
    const root = home()
    const operationRoot = join(root, 'database-migrations', 'dbm_e2_not_created_yet')
    const available = await createAutoUpgradeEnvironment().availableBytes(operationRoot)
    expect(available).toBeGreaterThan(0)
    expect(existsSync(join(root, 'database-migrations'))).toBe(false)
  })
})

describe('RFC-626 —— 前置检查不通过即拒绝，且不留下任何东西', () => {
  test('旧库打不开：拒绝并给出原因', async () => {
    const f = fixture()
    const requests = withPrecheck(f, {
      ok: false,
      reason: 'unreadable',
      message:
        'The database file /data/db.sqlite cannot be read as a SQLite database: file is not a database',
      detail: {},
    })
    const result = await f.start()
    expect(result).toMatchObject({
      outcome: 'refused',
      exitCode: 3,
      operationId: null,
      code: 'source-unreadable',
    })
    expect(result.guidance.join('\n')).toContain('file is not a database')
    expect(Object.hasOwn(result, 'artifactRoot')).toBe(false)
    // The check is asked with the automatic resolution and a place it must not write to.
    expect(requests).toHaveLength(1)
    expect(requests[0]!.resolution).toBe('automatic')
    expect(requests[0]!.location).toMatchObject({ kind: 'sqlite-file', path: f.sourcePath })
    expect(requests[0]!.operationRoot.startsWith(f.deps.journal.operationRoot(f.operationId))).toBe(
      true,
    )
    await expectNothingRecorded(f)
  })

  test('结构含非发布版对象：拒绝并逐条列出', async () => {
    const f = fixture()
    withPrecheck(f, {
      ok: false,
      reason: 'structure',
      message:
        'unexpected: table audit_shadow (holds rows), index idx_tasks_custom on tasks; missing: column tasks.branch',
      detail: { unexpected: ['table audit_shadow (holds rows)'] },
    })
    const result = await f.start()
    expect(result).toMatchObject({ outcome: 'refused', exitCode: 3, code: 'source-structure' })
    const said = result.guidance.join('\n')
    expect(said).toContain('table audit_shadow (holds rows)')
    expect(said).toContain('index idx_tasks_custom on tasks')
    expect(said).toContain('column tasks.branch')
    expect(said).toContain('released version')
    await expectNothingRecorded(f)
  })

  test('检查本身抛错也按打不开处理，原因取可读的文字', async () => {
    const f = fixture()
    // A database client throws values that are not errors.
    withPrecheck(f, () => {
      throw { message: 'connection refused (ECONNREFUSED 127.0.0.1:5432)', code: 'ECONNREFUSED' }
    })
    const result = await f.start()
    expect(result).toMatchObject({ outcome: 'refused', exitCode: 3, code: 'source-unreadable' })
    expect(result.guidance.join('\n')).toContain('connection refused (ECONNREFUSED 127.0.0.1:5432)')
    expect(result.guidance.join('\n')).not.toContain('[object Object]')
    await expectNothingRecorded(f)
  })

  test('磁盘不足：拒绝，文案含需要与可用的具体数值和目录', async () => {
    const f = fixture()
    withPrecheck(f, { ok: true, liveBytes: 2 * GIB })
    const measured = environment(GIB, 1000)
    const result = await f.start({ environment: measured })
    expect(result).toMatchObject({ outcome: 'refused', exitCode: 3, code: 'capacity' })
    const required = estimateDirectUpgradeCapacity({
      liveBytes: 2 * GIB,
      contentFiles: 1000,
      targetOnOperationFilesystem: true,
      artifactHardLinks: true,
    }).requiredBytes
    const said = result.guidance.join('\n')
    expect(said).toContain(`${required} bytes`)
    expect(said).toContain(`${GIB} bytes`)
    expect(said).toContain(f.deps.journal.operationRoot(f.operationId))
    // Measured where the operation directory will be, which does not exist yet.
    expect(measured.calls).toEqual([
      `available:${f.deps.journal.operationRoot(f.operationId)}`,
      'content',
    ])
    await expectNothingRecorded(f)
  })

  test('空间按有效数据量判断：文件很大而数据很少的库不被拒绝', async () => {
    const f = fixture()
    // 24.7 GB of file, 1.07 GB in use; 12 GB free would have been refused by file size.
    withPrecheck(f, { ok: true, liveBytes: Math.round(1.07 * GIB) })
    const result = await f.start({ environment: environment(12 * GIB, 827_742) })
    expect(result.outcome).toBe('done')
    expect(result.exitCode).toBe(0)
  })

  test('PostgreSQL 无建库权限且未给出库：拒绝，文案是要执行的建库语句', async () => {
    const f = fixture()
    let prepares = 0
    const statements = [
      'CREATE DATABASE "app_epoch2" TEMPLATE template0 ENCODING \'UTF8\' OWNER "app";',
      'CREATE DATABASE "app_epoch2_scratch" TEMPLATE template0 ENCODING \'UTF8\' OWNER "app";',
    ]
    const provisioning: EpochTargetProvisioningPort = {
      async prepare() {
        prepares++
        throw new Error('prepare must not run before the environment check passed')
      },
      retained: async () => [],
      async nextTargetLocation() {
        throw new Error('not reached')
      },
      async precheck() {
        return {
          ok: false,
          code: 'postgresql-create-database-denied',
          message: `postgresql-create-database-denied: ${JSON.stringify({ statements })}`,
          detail: { statements },
        }
      },
    }
    const installation = f.deps.installation
    f.deps.installation = async () => {
      const observed = await installation()
      return { ...observed, facts: { ...observed.facts, provider: 'postgresql' } }
    }
    const result = await f.start({ provisioning })
    expect(result).toMatchObject({
      outcome: 'refused',
      exitCode: 3,
      operationId: null,
      code: 'postgresql-create-database-denied',
    })
    for (const statement of statements)
      expect(result.guidance.join('\n')).toContain(JSON.stringify(statement).slice(1, -1))
    expect(result.guidance.join('\n')).toContain('Prepare the reported empty databases')
    expect(prepares).toBe(0)
    await expectNothingRecorded(f)
  })

  test('旧版「搬到 PostgreSQL」操作未完成：登记意图之前就拒绝', async () => {
    const f = fixture()
    const probe = f.deps.installation
    f.deps.installation = async () => {
      const observed = await probe()
      return { ...observed, facts: { ...observed.facts, rfc349Operation: 'dbm_legacy_move' } }
    }
    let finalized = 0
    const result = await f.start({
      legacy: {
        async status() {
          // Asked before any session record exists.
          expect(await f.records.list()).toEqual([])
          return { phase: 'copying', rolledBackAt: null } as never
        },
        async finalize() {
          finalized++
          throw new Error('an unfinished move is not finalized')
        },
      },
    })
    expect(result).toMatchObject({
      outcome: 'refused',
      exitCode: 3,
      operationId: null,
      code: 'rfc349-operation-unfinished',
    })
    expect(result.guidance.join('\n')).toContain('db migration resume dbm_legacy_move')
    expect(finalized).toBe(0)
    await expectNothingRecorded(f)
  })

  test('检查依次进行：前一项不通过就不做后一项', async () => {
    const f = fixture()
    withPrecheck(f, { ok: false, reason: 'unreadable', message: 'closed', detail: {} })
    const measured = environment(0)
    let asked = 0
    const result = await f.start({
      environment: measured,
      provisioning: {
        prepare: async () => {
          throw new Error('not reached')
        },
        retained: async () => [],
        nextTargetLocation: async () => {
          throw new Error('not reached')
        },
        async precheck() {
          asked++
          return { ok: true }
        },
      },
    })
    expect(result.code).toBe('source-unreadable')
    expect(measured.calls).toEqual([])
    expect(asked).toBe(0)
  })

  test('没有可判断的依据时不拒绝：没有源端检查就不估算空间', async () => {
    const f = fixture()
    const measured = environment(1)
    const result = await f.start({ environment: measured })
    expect(result.outcome).toBe('done')
    expect(measured.calls).toEqual([`available:${f.deps.journal.operationRoot(f.operationId)}`])
  })
})

describe('RFC-626 —— 前置检查只在登记一次新的升级之前做', () => {
  test('通过之后才登记意图；会话已存在时续做不再检查', async () => {
    const f = fixture()
    const requests = withPrecheck(f, { ok: true, liveBytes: 1000 })
    const measured = environment(10 * GIB)
    // The first start passes the check, records its intent and stops at the first plan.
    f.scenario.atCheckpoint = (point) => {
      if (point === 'plan') throw new Error('killed while planning')
    }
    const first = await f.start({ environment: measured })
    expect(first.outcome).toBe('error')
    expect(requests).toHaveLength(1)
    expect((await f.records.list())[0]!.records.map((record) => record.kind)).toEqual(['intent'])
    expect(f.lock.bound).toEqual([f.operationId])
    // The second start resumes that session: its copies are already on the disk, and an
    // estimate made now would count them as missing.
    f.scenario.atCheckpoint = undefined
    const second = await f.start({ environment: environment(1) })
    expect(second.outcome).toBe('done')
    expect(requests).toHaveLength(1)
  })

  test('通过之后 PostgreSQL 的库准备被拒：走既有路径，保留会话记录', async () => {
    const f = fixture()
    withPrecheck(f, { ok: true, liveBytes: 1000 })
    const installation = f.deps.installation
    f.deps.installation = async () => {
      const observed = await installation()
      return { ...observed, facts: { ...observed.facts, provider: 'postgresql' } }
    }
    const result = await f.start({
      environment: environment(10 * GIB),
      provisioning: {
        async precheck() {
          return { ok: true }
        },
        async prepare() {
          throw Object.assign(new Error('postgresql-target-not-empty: {"database":"app_epoch2"}'), {
            code: 'postgresql-target-not-empty',
            detail: { database: 'app_epoch2' },
          })
        },
        retained: async () => [],
        nextTargetLocation: async () => {
          throw new Error('not reached')
        },
      },
    })
    expect(result).toMatchObject({
      outcome: 'refused',
      exitCode: 3,
      operationId: f.operationId,
      code: 'postgresql-target-not-empty',
    })
    const session = (await f.records.list())[0]!
    expect(session.records.map((record) => record.kind)).toEqual(['intent', 'refused'])
    expect(session.unfinished).toBe(true)
    // An operation exists now: the conclusion says where its artifacts are.
    expect(result.artifactRoot).toBe(f.deps.journal.operationRoot(f.operationId))
  })
})

describe('RFC-626 —— config.json 不合法：装配之前就拒绝', () => {
  test('退出码 3，文案含文件路径与解析错误，家目录里没有会话记录、操作目录、分配文件', async () => {
    const appHome = home()
    writeFileSync(join(appHome, 'config.json'), '{"database": ')
    writeFileSync(join(appHome, 'db.sqlite'), 'left exactly as it is')
    const result = await runAutomaticEpochUpgrade({ appHome, env: {} })
    expect(result).toMatchObject({
      mode: 'auto',
      outcome: 'refused',
      exitCode: 3,
      operationId: null,
      code: 'config-not-json',
    })
    expect(result.guidance[0]).toContain(join(appHome, 'config.json'))
    expect(result.guidance[0]).toContain('is not valid JSON')
    const migrations = join(appHome, 'database-migrations')
    // Only the lock's own directory may have appeared; its activity marker is gone again.
    const left = existsSync(migrations) ? readdirSync(migrations) : []
    expect(left.filter((name) => name !== 'auto-upgrade')).toEqual([])
    const session = join(migrations, 'auto-upgrade')
    expect(existsSync(join(session, 'sessions'))).toBe(false)
    expect(existsSync(join(session, 'allocations'))).toBe(false)
    expect(existsSync(join(session, 'active.json'))).toBe(false)
    expect(existsSync(join(appHome, '.daemon.lock'))).toBe(false)
    expect(existsSync(join(appHome, 'database-generation.json'))).toBe(false)
  })

  test('路径字段不是文本同样在这里拒绝，而不是等到转换', async () => {
    const appHome = home()
    writeFileSync(join(appHome, 'config.json'), '{"opencodePath": 7}')
    const result = await runAutomaticEpochUpgrade({ appHome, env: {} })
    expect(result).toMatchObject({
      outcome: 'refused',
      exitCode: 3,
      operationId: null,
      code: 'config-binary-invalid',
    })
    expect(result.guidance[0]).toContain('opencodePath is a number')
  })
})

// Implementation gate G4-5: the check of config.json is stricter than the configuration loader
// (bytes that are not UTF-8 are refused). It used to run before the session was classified,
// so `migrate` on an installation that was already upgraded, or a session that resumes, was
// refused where it had passed before. It is a check before a new session now, like the others.
describe('RFC-626 —— config.json 的检查只在新会话之前做', () => {
  const notUtf8 = {
    reason: 'config-not-utf8',
    guidance: ['The configuration file /home/config.json is not valid UTF-8: invalid', 'x'],
  }
  /** Loadable (the loader replaces the byte), but not UTF-8: what the conversion rejects. */
  const notUtf8Config = () =>
    Buffer.concat([
      Buffer.from('{"opencodePath":"/opt/opencode'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ])

  test('新会话：第一项检查就拒绝，不问源端，不留下任何东西', async () => {
    const f = fixture()
    const requests = withPrecheck(f, { ok: true, liveBytes: 1000 })
    const measured = environment(10 * GIB)
    const result = await f.start({ environment: measured, homeConfigRefusal: notUtf8 })
    expect(result).toMatchObject({
      outcome: 'refused',
      exitCode: 3,
      operationId: null,
      code: 'config-not-utf8',
      guidance: notUtf8.guidance,
    })
    expect(requests).toEqual([])
    expect(measured.calls).toEqual([])
    expect(f.checkpoints).toContain('environment-refused')
    await expectNothingRecorded(f)
  })

  test('续做：已有的会话不因它被拒，照常做完', async () => {
    const f = fixture()
    withPrecheck(f, { ok: true, liveBytes: 1000 })
    f.scenario.atCheckpoint = (point) => {
      if (point === 'plan') throw new Error('killed while planning')
    }
    expect((await f.start({ environment: environment(10 * GIB) })).outcome).toBe('error')
    f.scenario.atCheckpoint = undefined
    const resumed = await f.start({
      environment: environment(10 * GIB),
      homeConfigRefusal: notUtf8,
    })
    expect(resumed.outcome).toBe('done')
    expect(resumed.code).toBeUndefined()
  })

  test('已经升级完的家目录：migrate 的结论与以前一样是 noop', async () => {
    const appHome = home()
    writeFileSync(join(appHome, 'config.json'), notUtf8Config())
    const head = persistenceHead()
    writeGenerationPointerV2({
      pointerPath: join(appHome, 'database-generation.json'),
      payload: {
        version: 2,
        schemaEpoch: 2,
        generationId: 'dbg_rfc626_g45_upgraded',
        provider: 'sqlite',
        role: 'installed',
        database: { kind: 'sqlite-file', relativePath: 'db.sqlite' },
        contractDigest: head.contract.contract.digest,
        planDigest: head.sqlite.digest,
        operationId: null,
        manifestDigest: null,
        activatedAt: 1,
        previous: null,
      },
    })
    const result = await runAutomaticEpochUpgrade({ appHome, env: {} })
    expect(result).toMatchObject({ mode: 'auto', outcome: 'noop', exitCode: 0, operationId: null })
    expect(result.code).toBeUndefined()
  })

  test('未升级的家目录：同一个文件照旧在登记任何东西之前被拒', async () => {
    const appHome = home()
    writeFileSync(join(appHome, 'config.json'), notUtf8Config())
    // A database of the first release: the installation is classified as one to upgrade.
    const source = join(appHome, 'db.sqlite')
    copyFileSync(join(import.meta.dir, 'fixtures/rfc395-v1/prefix-0000.sqlite'), source)
    const before = readFileSync(source)
    const result = await runAutomaticEpochUpgrade({ appHome, env: {} })
    expect(result).toMatchObject({
      outcome: 'refused',
      exitCode: 3,
      operationId: null,
      code: 'config-not-utf8',
    })
    expect(readFileSync(source).equals(before)).toBe(true)
    expect(result.guidance[0]).toContain(join(appHome, 'config.json'))
    expect(result.guidance[0]).toContain('is not valid UTF-8')
    expect(existsSync(join(appHome, 'database-migrations', 'auto-upgrade', 'sessions'))).toBe(false)
  })
})

// Coordinator item 7 (measured): with only a few MB left on the volume of the home directory,
// opening the old database in WAL mode cannot write its shared-memory file, and the first
// check failed with "cannot be opened … ENOSPC" instead of the lack of space it is.
describe('RFC-626 —— 磁盘已满时旧库打不开：按空间不足拒绝', () => {
  const ENOSPC = 'ENOSPC: no space left on device, write'
  const UNTOUCHED =
    'The database was not modified and nothing was recorded for this upgrade. Start again after the correction.'

  test('预检结果到拒绝：只有打不开且错误代码是 ENOSPC 才算空间不足', () => {
    expect(sourceOutOfSpace({ reason: 'unreadable', detail: { code: 'ENOSPC' } })).toBe(true)
    expect(sourceOutOfSpace({ reason: 'unreadable', detail: { code: 'EACCES' } })).toBe(false)
    expect(sourceOutOfSpace({ reason: 'unreadable', detail: {} })).toBe(false)
    expect(sourceOutOfSpace({ reason: 'structure', detail: { code: 'ENOSPC' } })).toBe(false)
    const refusal = sourceOutOfSpaceRefusal({
      error: ENOSPC,
      availableBytes: 3 * 1024 * 1024,
      directory: '/home/aw/database-migrations/dbm_x',
    })
    expect(refusal).toEqual({
      reason: 'capacity',
      guidance: [
        `The disk that holds /home/aw/database-migrations/dbm_x has no free space left: not even the database to upgrade can be opened for reading (${ENOSPC}).`,
        '3145728 bytes (3.0 MiB) are available in /home/aw/database-migrations/dbm_x.',
        `Free disk space there, then start again. ${UNTOUCHED}`,
      ],
    })
    expect(
      sourceOutOfSpaceRefusal({ error: ENOSPC, availableBytes: null, directory: '/d' }).guidance[1],
    ).toBe('The free space in /d could not be measured.')
  })

  for (const [name, answer] of [
    [
      'the check reports it',
      {
        ok: false,
        reason: 'unreadable',
        message: `The old database cannot be reached: ${ENOSPC}; check that it is available, then start again.`,
        detail: { error: ENOSPC, code: 'ENOSPC' },
      } satisfies SourcePrecheck,
    ],
    [
      'the check throws it',
      () => {
        throw Object.assign(new Error(ENOSPC), { code: 'ENOSPC' })
      },
    ],
  ] as const)
    test(`${name}: capacity, with what is free and where, nothing recorded`, async () => {
      const f = fixture()
      withPrecheck(f, answer)
      const measured = environment(3 * 1024 * 1024)
      const result = await f.start({ environment: measured })
      const root = f.deps.journal.operationRoot(f.operationId)
      expect(result).toMatchObject({ outcome: 'refused', exitCode: 3, code: 'capacity' })
      expect(result.guidance).toEqual([
        `The disk that holds ${root} has no free space left: not even the database to upgrade can be opened for reading (${ENOSPC}).`,
        `3145728 bytes (3.0 MiB) are available in ${root}.`,
        `Free disk space there, then start again. ${UNTOUCHED}`,
      ])
      expect(measured.calls).toEqual([`available:${root}`])
      await expectNothingRecorded(f)
    })

  test('其它打不开的情形文案不变', async () => {
    const f = fixture()
    withPrecheck(f, {
      ok: false,
      reason: 'unreadable',
      message: 'The database file /data/db.sqlite cannot be read: EACCES: permission denied',
      detail: { error: 'EACCES: permission denied', code: 'EACCES' },
    })
    const measured = environment(GIB)
    const result = await f.start({ environment: measured })
    expect(result.code).toBe('source-unreadable')
    expect(result.guidance).toEqual(
      sourceRefusal({
        reason: 'unreadable',
        message: 'The database file /data/db.sqlite cannot be read: EACCES: permission denied',
      }).guidance,
    )
    expect(measured.calls).toEqual([])
  })
})

describe('RFC-626 —— 源端的拒绝文案', () => {
  test('结构不符与打不开各有说明，都说明没有改动任何东西', () => {
    const structure = sourceRefusal({ reason: 'structure', message: 'unexpected: table extra' })
    expect(structure.reason).toBe('source-structure')
    expect(structure.guidance[0]).toContain('unexpected: table extra')
    expect(structure.guidance.join('\n')).toContain('The database was not modified')
    const unreadable = sourceRefusal({ reason: 'unreadable', message: 'file is locked' })
    expect(unreadable.reason).toBe('source-unreadable')
    expect(unreadable.guidance[0]).toContain('file is locked')
  })
})

// Measured with the final binary on a volume filled to its last block: with less room still,
// the upgrade fails before the database is looked at — its lock file cannot be written — and
// what the operator got was the bare `ENOSPC: no space left on device, open '…/.daemon.lock'`
// with exit code 1. It is the same lack of space and is refused the same way (design §3.5).
describe('RFC-626 —— 磁盘满到连锁文件都写不出：同样按空间不足拒绝', () => {
  const ENOSPC = "ENOSPC: no space left on device, open '/home/aw/.daemon.lock'"
  const failing = (error: unknown) =>
    (() => ({
      acquire: async () => {
        throw error
      },
      release: async () => {},
    })) as unknown as NonNullable<
      Parameters<typeof runAutomaticEpochUpgrade>[0]
    >['createSessionLock']

  test('只有 ENOSPC 才算；文案写明是锁文件写不出，给出可用空间与处理办法', () => {
    expect(
      lockOutOfSpaceRefusal({ code: 'EACCES', error: 'x', availableBytes: 1, directory: '/d' }),
    ).toBeNull()
    expect(
      lockOutOfSpaceRefusal({ code: null, error: 'x', availableBytes: 1, directory: '/d' }),
    ).toBeNull()
    expect(
      lockOutOfSpaceRefusal({
        code: 'ENOSPC',
        error: ENOSPC,
        availableBytes: 0,
        directory: '/home/aw',
      }),
    ).toEqual({
      reason: 'capacity',
      guidance: [
        `The disk that holds /home/aw has no free space left: the upgrade cannot even write its lock file (${ENOSPC}).`,
        '0 bytes are available in /home/aw.',
        'Free disk space there, then start again. The database was not modified and nothing was recorded for this upgrade. Start again after the correction.',
      ],
    })
  })

  test('入口：取锁遇 ENOSPC 以退出码 3 拒绝，没有会话、没有新库', async () => {
    const appHome = home()
    writeFileSync(join(appHome, 'config.json'), '{}')
    writeFileSync(join(appHome, 'db.sqlite'), 'left exactly as it is')
    const result = await runAutomaticEpochUpgrade({
      appHome,
      env: {},
      createSessionLock: failing(Object.assign(new Error(ENOSPC), { code: 'ENOSPC' })),
    })
    expect(result).toMatchObject({
      mode: 'auto',
      outcome: 'refused',
      exitCode: 3,
      operationId: null,
      code: 'capacity',
    })
    expect(result.guidance[0]).toContain(`The disk that holds ${appHome} has no free space left`)
    expect(result.guidance[0]).toContain('cannot even write its lock file')
    expect(result.guidance[1]).toMatch(/ are available in /)
    expect(existsSync(join(appHome, 'database-migrations'))).toBe(false)
    expect(existsSync(join(appHome, 'database-generation.json'))).toBe(false)
    expect(readFileSync(join(appHome, 'db.sqlite'), 'utf8')).toBe('left exactly as it is')
  })

  test('入口：取锁的其它失败照旧抛出', async () => {
    const appHome = home()
    writeFileSync(join(appHome, 'config.json'), '{}')
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    await expect(
      runAutomaticEpochUpgrade({ appHome, env: {}, createSessionLock: failing(denied) }),
    ).rejects.toBe(denied)
  })
})
