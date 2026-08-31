// RFC-319 —— 运维 CLI：诊断 / DB 维护 / 回滚闸门 / 隐藏的 git 凭据助手
// （OPS-010 / OPS-011 / OPS-014 / OPS-015 / OPS-X8）。
//
// 和 `rfc319-cli-lifecycle.spec.ts` 同一条理由：这批能力的唯一使用者是站在机器
// 前面敲命令的人，他手上只有 `agent-workflow` 这一个文件。用进程内函数调一遍只
// 能证明「那个函数存在」——本文件第一轮跑就用这个差别抓到了三个**只在发行二进制
// 上成立**的缺陷（见文件末尾「未覆盖 / 已发现缺陷」）。
//
// 判据全部取自源码：
//   * doctor 的检查清单与顺序 → `packages/backend/src/cli/doctor.ts:28-89`；
//     排版 `  ✓/✗ <name>: <message>` 与收尾结论 → 同文件 `516-523`；
//     退出码由 `packages/backend/src/main.ts:96-101` 决定（任一项 ok=false → 1）。
//   * 各诊断项：git 地板 `doctor.ts:269-286`（`MIN_GIT_VERSION` 见
//     `services/gitVersion.ts:60-68`）、ssh 忠告 `doctor.ts:314-326`、
//     secret 权限 `doctor.ts:393-441`、migrations `doctor.ts:473-514`、
//     provider-aware DB 完整性 `doctor.ts:111-183` 与
//     `platform/persistence/databaseOperationalAdapter.ts`、备份健康 `doctor.ts:170-198`、
//     密封凭据 `doctor.ts:98-149`、lifecycle `doctor.ts:214-262`。
//   * `db compact` 的三态与停机闸门 → `packages/backend/src/cli/dbCompact.ts:28-69`；
//     `db` 子命令用法 / 退出码 → `main.ts:105-114`。
//   * `downgrade-audit rfc-295` 的只读开库与三种 status → `cli/rfc295-downgrade-audit.ts:38-76`；
//     被审任务状态白名单 → `services/rfc295DowngradeAudit.ts:23-30`。
//   * 隐藏子命令 `__git-credential` 的协议 → `main.ts:55-66` 与
//     `util/gitCredentialLease.ts:128-151`（协议 + 规范化 authority + 仓库路径
//     三者全中才回答，其余一律空响应）。
//
// 一个刻意的取舍：doctor 的每一项都**单独逼红过**（造坏掉的前置条件、看它是否
// 点名那一项并给非零退出码）。只断言「doctor 跑完了」对任何一次运行都成立，那种
// 断言在这里一条都没有。

import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
  closeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { expect, test } from '@playwright/test'

import { querySqlite, runCommandResult, runSqlite } from './command'
import { defaultBinaryPath, startDaemon, type DaemonHandle } from './harness'

// 一次冷启动（~5s，beforeAll 里只做一次）+ 每条用例若干次 doctor / CLI 调用，
// 其中 doctor 每次都要真的探 git / ssh / opencode。90s 的默认值对
// OPS-014 那种「起 daemon → 灌空洞 → 拒绝 → 停机 → VACUUM」的用例太紧。
//
// 在**每条用例体内**调用而不是在文件作用域：文件作用域的 `test.setTimeout` 不生效
// （实测——一条用例照样在 90000ms 上被砍），而那种失败读起来像被测行为慢，不像配置没生效。
const OPS_TEST_TIMEOUT_MS = 240_000

/** doctor 打印的检查清单（`cli/doctor.ts:28-89` 的 push 顺序去序后的集合）。 */
const DOCTOR_CHECK_ROSTER = [
  'opencode binary',
  'git version',
  'ssh (optional)',
  'app home',
  'config',
  'secret file protection',
  'migrations folder',
  'lifecycle',
  'database provider',
  'backups',
  'repo credentials',
] as const

interface DoctorCheck {
  readonly ok: boolean
  readonly name: string
  readonly message: string
}

/**
 * 跑发行二进制的一个子命令。
 *
 * 走 `e2e/command.ts` 的受限边界而不是在 spec 里自己起进程：所有 e2e 子进程都必须
 * 带上那份硬超时，否则一个挂住的探针会把整个 shard 卡死；`root-test-entrypoint.test.ts`
 * 对每份 spec 源码做**纯子串检查**来强制这条，连注释里提到被禁的那几个字面量都会
 * 把守卫打红——所以这里只描述规则、不复述那些词。
 *
 * 注意 `runCommandResult` 在**退出码为 0 时只带回 stdout**；doctor / db compact /
 * downgrade-audit 的正文都写 stdout，用法错误才写 stderr，两边都覆盖得到。
 */
function runCli(
  home: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { out: string; code: number } {
  const result = runCommandResult(defaultBinaryPath(), args, {
    env: { AGENT_WORKFLOW_HOME: home, ...extraEnv },
  })
  return { out: result.output, code: result.status }
}

function freshDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `aw-rfc319-ops-${tag}-`))
}

function dbPathOf(home: string): string {
  return join(home, 'db.sqlite')
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 逐行解析 doctor 的 `  ✓/✗ <name>: <message>` 排版。 */
function parseDoctor(output: string): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  for (const line of output.split('\n')) {
    const matched = /^ {2}([✓✗]) ([^:]+): (.*)$/.exec(line)
    if (matched === null) continue
    checks.push({ ok: matched[1] === '✓', name: matched[2] ?? '', message: matched[3] ?? '' })
  }
  return checks
}

function doctorCheck(output: string, name: string): DoctorCheck {
  const found = parseDoctor(output).find((check) => check.name === name)
  expect(
    found,
    `doctor 输出里根本没有 \`${name}\` 这一项 —— 这项诊断对只看命令输出的运维等于不存在。实际输出：\n${output}`,
  ).toBeDefined()
  return found as DoctorCheck
}

/**
 * 除 `exempt` 之外的每一项都必须是 ✓。
 *
 * 这是「点名」的另一半：一次失败的 doctor 如果把所有项一起标红，运维就无法从输出
 * 里读出到底该修哪一个，只能逐个猜。
 */
function expectOnlyFailing(output: string, exempt: readonly string[]): void {
  const unexpected = parseDoctor(output)
    .filter((check) => !check.ok && !exempt.includes(check.name))
    .map((check) => `${check.name}: ${check.message}`)
  expect(
    unexpected,
    `只坏了 ${exempt.join(' / ')} 这一项，doctor 却把别的项也标红了 ⇒ 运维读不出该修哪一个`,
  ).toEqual([])
}

/** 造一个 POSIX 可执行的探针替身，用来把 doctor 的某一项逼进失败分支。 */
function writeShim(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}`, 'utf8')
  chmodSync(path, 0o755)
  return path
}

function pathWithShims(shimDir: string): string {
  return `${shimDir}${delimiter}${process.env.PATH ?? ''}`
}

/** 把 WAL 里的帧全部落回主库，之后对主库字节的改动才真的会被 SQLite 看见。 */
function checkpointDb(home: string): void {
  runSqlite(dbPathOf(home), 'PRAGMA wal_checkpoint(TRUNCATE);')
}

function freelistPages(home: string): number {
  const rows = querySqlite<{ freelist_count: number }>(dbPathOf(home), 'PRAGMA freelist_count;')
  return rows[0]?.freelist_count ?? -1
}

function dbPageSize(home: string): number {
  const rows = querySqlite<{ page_size: number }>(dbPathOf(home), 'PRAGMA page_size;')
  return rows[0]?.page_size ?? -1
}

/**
 * 灌一批行再删掉：SQLite 不会把删掉的页还给文件系统，它们进 freelist——这正是
 * `db compact` 存在的理由，也是唯一能让「回收了多少」这件事可测的造法。
 */
function plantFreePages(home: string): void {
  runSqlite(
    dbPathOf(home),
    `CREATE TABLE rfc319_ops_ballast (id INTEGER PRIMARY KEY, payload TEXT);
     INSERT INTO rfc319_ops_ballast (payload)
       WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < 3000)
       SELECT hex(randomblob(2048)) FROM counter;
     DROP TABLE rfc319_ops_ballast;`,
  )
}

// ---------------------------------------------------------------------------
// 模板 home：一次真实冷启动的产物（已迁移的库、mode 600 的 token、secret.key），
// 之后每条用例复制一份自己糟蹋，互不影响。
// ---------------------------------------------------------------------------

let templateHome = ''
let shimRoot = ''
let opencodeShim = ''

test.beforeAll(async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  shimRoot = freshDir('shims')
  // doctor 的 opencode 一项只是**可用性探针**（`doctor.ts:39-57`：`--version` 退 0
  // 即可）。e2e 的编译桩不认 `--version`，所以这里给一个只回答版本的替身——否则
  // 「全绿」这一档根本造不出来，而「全绿 ⇒ 退出 0」正是 OPS-010 的核心。
  opencodeShim = writeShim(shimRoot, 'opencode', 'echo "opencode 9.9.9"\n')

  templateHome = freshDir('template')
  const daemon: DaemonHandle = await startDaemon({ home: templateHome })
  await daemon.stop()

  const configPath = join(templateHome, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  config.opencodePath = opencodeShim
  config.claudeCodePath = opencodeShim
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

  expect(
    existsSync(dbPathOf(templateHome)) && existsSync(join(templateHome, 'secret.key')),
    '前提不成立：一次正常启停之后 home 里没有库 / 没有 secret.key，后面的诊断用例无从造起',
  ).toBe(true)
})

test.afterAll(() => {
  if (templateHome !== '') rmSync(templateHome, { recursive: true, force: true })
  if (shimRoot !== '') rmSync(shimRoot, { recursive: true, force: true })
})

function cloneHome(tag: string): string {
  const home = freshDir(tag)
  cpSync(templateHome, home, { recursive: true })
  return home
}

// ---------------------------------------------------------------------------
// OPS-010 —— 整套诊断跑通 + 退出码
// ---------------------------------------------------------------------------

test('RFC-319 OPS-010: doctor 在编译二进制上跑完整套诊断——十一项逐条给结论、全绿退出 0，且不启动 daemon、不写回数据库 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = cloneHome('doctor-green')
  try {
    const before = sha256Of(dbPathOf(home))
    const result = runCli(home, ['doctor'])

    expect(
      result.code,
      '一台健康机器上 `doctor` 以非 0 退出 ⇒ 安装脚本 / 部署前置检查会在一台本来没问题的机器上中止，' +
        '而运维找不到任何一项是红的',
    ).toBe(0)
    expect(
      result.out.trimEnd().endsWith('all checks passed'),
      '全绿时没有给出一句总结论 ⇒ 用户要自己逐行数 ✓/✗ 才能回答「这台机器能不能用」',
    ).toBe(true)

    const checks = parseDoctor(result.out)
    expect(
      checks.map((check) => check.name).sort(),
      'doctor 打印出来的诊断项与它声称覆盖的那一套对不上 ⇒ 少一项就是少一道体检，' +
        '而少掉的那道恰恰不会有任何提示（输出照样以 `all checks passed` 收尾）',
    ).toEqual([...DOCTOR_CHECK_ROSTER].sort())
    expectOnlyFailing(result.out, [])

    // 逐项读数必须是真的，而不是排版好看的常量。
    expect(
      doctorCheck(result.out, 'app home').message,
      'doctor 报的 app home 不是它真正体检的那个目录 ⇒ 在一台跑着多个 $AGENT_WORKFLOW_HOME 的机器上，' +
        '用户不知道这份体检报告说的是哪一份状态',
    ).toBe(home)
    expect(
      doctorCheck(result.out, 'database provider').message,
      '完好的库没有得到 `quick_check ok` ⇒ 「库到底有没有坏」这个问题没有肯定答案，' +
        '恢复备份的决定就只能靠猜',
    ).toBe('sqlite generation dbg_legacy_sqlite: sqlite-quick-check=ok')
    expect(
      doctorCheck(result.out, 'git version').message,
      'git 那一项没有报出实测版本与要求的地板 ⇒ 升级 git 之后用户无从确认自己是不是升够了',
    ).toMatch(/^git version \S+.*\(>=2\.38\.0\)$/)

    // 这一条锁的是**发行产物本身**：单二进制必须自带迁移。
    // `scripts/build-binary.ts` 的 MIGRATION_FILES 生成一旦坏掉，二进制会带着
    // 零条迁移出厂——装了就起不来，而只有 doctor 这一行能在起之前说出来。
    const migrations = doctorCheck(result.out, 'migrations folder')
    expect(
      migrations.message,
      '单二进制没有报出自带的迁移条数 ⇒ 「这个包能不能建库」在安装前无法回答',
    ).toMatch(/^\d+ migrations? embedded in binary$/)
    expect(
      Number(/^(\d+)/.exec(migrations.message)?.[1] ?? '0'),
      '发行二进制里嵌了 0 条迁移 ⇒ 这个包装到任何一台新机器上都建不出库，' +
        '而失败会发生在用户第一次 `start` 的时候，不是在构建的时候',
    ).toBeGreaterThan(0)

    // doctor 的定位是「不启动 daemon 的体检」：既不能起进程，也不能改它在诊断的东西。
    expect(
      existsSync(join(home, '.daemon.lock')),
      '`doctor` 留下了 daemon 锁文件 ⇒ 它偷偷起了一个实例，' +
        '而用户以为自己只是做了一次只读体检；下一次真正 `start` 会撞上这把锁',
    ).toBe(false)
    expect(
      sha256Of(dbPathOf(home)),
      '`doctor` 改写了它正在诊断的数据库 ⇒ 一份用来判断「库坏没坏」的报告，本身就动了那个库；' +
        '这也让「先 doctor 再决定要不要恢复备份」这条流程失去意义',
    ).toBe(before)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-011 —— 逐项诊断的判定
// ---------------------------------------------------------------------------

test('RFC-319 OPS-011: git 版本低于 2.38 地板 / 版本行读不懂时，doctor 各自点名并让整条命令以退出码 1 收场 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = cloneHome('doctor-git')
  const shims = freshDir('gitshim')
  try {
    // ① 太老：每个节点跑完都要 `git merge-tree --write-tree` 合回去，2.38 以下
    //    直接不认这个用法（RFC-130 D7）。这不是洁癖，是装完就跑不了任务。
    writeShim(shims, 'git', 'echo "git version 2.20.0"\n')
    const tooOld = runCli(home, ['doctor'], { PATH: pathWithShims(shims) })
    expect(
      tooOld.code,
      'git 老到跑不了合并回写，doctor 却以 0 退出 ⇒ 安装脚本判定这台机器就绪，' +
        '用户直到第一个任务跑到合回步骤才发现，而那时错误信息在任务日志深处',
    ).toBe(1)
    const oldCheck = doctorCheck(tooOld.out, 'git version')
    expect(oldCheck.ok, 'git 版本低于地板却被判为通过 ⇒ 这道体检形同虚设').toBe(false)
    expect(
      oldCheck.message,
      '拒绝时没有同时说出「实测多少」和「要求多少」 ⇒ 用户不知道要升到哪一版才够，' +
        '只能升一次试一次',
    ).toBe(
      'git version 2.20.0 is older than required 2.38.0 (isolated merge-back needs `git merge-tree --write-tree`, RFC-130 D7)',
    )
    expectOnlyFailing(tooOld.out, ['git version'])

    // ② 边界：地板是 `>=`，2.38.0 必须放行。地板写成 `>` 会把一整批正好卡在
    //    2.38.0 的发行版（Debian bookworm 一线）拒之门外。
    writeShim(shims, 'git', 'echo "git version 2.38.0"\n')
    const atFloor = runCli(home, ['doctor'], { PATH: pathWithShims(shims) })
    expect(
      atFloor.code,
      '正好等于地板版本的 git 被拒 ⇒ 一批发行版自带的 git 全部装不上，' +
        '而它们其实完全支持所需的 `merge-tree --write-tree`',
    ).toBe(0)
    expect(
      doctorCheck(atFloor.out, 'git version').message,
      '正好在地板上时没有报出通过 ⇒ 同上',
    ).toBe('git version 2.38.0 (>=2.38.0)')

    // ③ 读不懂：与「太老」是两种不同的处置（一个去升级，一个去查 PATH 上那个
    //    `git` 到底是什么），所以连诊断项的名字都不一样。
    writeShim(shims, 'git', 'echo "definitely not a version banner"\n')
    const garbled = runCli(home, ['doctor'], { PATH: pathWithShims(shims) })
    expect(
      garbled.code,
      'PATH 上那个 `git` 根本不是 git，doctor 却以 0 退出 ⇒ 一个被包装脚本 / 别名劫持的 git' +
        '会一路带到任务执行才炸',
    ).toBe(1)
    expect(
      doctorCheck(garbled.out, 'git').message,
      '读不懂版本行时没有把原文回显出来 ⇒ 用户无从判断 PATH 上被谁劫持了',
    ).toBe('unparseable git output: definitely not a version banner')
    expect(
      parseDoctor(garbled.out).some((check) => check.name === 'git version'),
      '「读不懂」和「版本太老」用了同一个诊断项名 ⇒ 两种需要完全不同处置的现场被混为一谈',
    ).toBe(false)
    expectOnlyFailing(garbled.out, ['git'])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(shims, { recursive: true, force: true })
  }
})

test('RFC-319 OPS-011: ssh 只是可选前置——缺了要说清后果与装法，但绝不把 doctor 判红 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = cloneHome('doctor-ssh')
  const shims = freshDir('sshshim')
  try {
    // 在场：把 banner 也用替身固定下来，免得这条断言实际上在测跑测试的那台机器
    //（`ssh -V` 把 banner 写 stderr 并退 0，见 `doctor.ts:336`）。
    writeShim(shims, 'ssh', 'echo "OpenSSH_9.9p1 rfc319-probe" >&2\nexit 0\n')
    const present = runCli(home, ['doctor'], { PATH: pathWithShims(shims) })
    expect(
      doctorCheck(present.out, 'ssh (optional)').message,
      'ssh 在场时没有把实测 banner 报出来 ⇒ 排查 `ssh://` 远端连不上时，' +
        '用户无从确认平台看到的是不是自己以为的那个 ssh',
    ).toBe('OpenSSH_9.9p1 rfc319-probe — ssh:// remotes available')

    // 缺席：`ssh` 只有 `ssh://` 远端才需要，https 远端走 T20 的凭据子命令。
    // 所以这一项是**忠告**——把它做成失败会让一大批只用 https 的部署被自己的
    // 安装前置检查拦住，而他们永远用不到 ssh。
    writeShim(shims, 'ssh', 'exit 127\n')
    const missing = runCli(home, ['doctor'], { PATH: pathWithShims(shims) })
    expect(
      missing.code,
      '缺 ssh 就让 doctor 以非 0 退出 ⇒ 只用 https 远端的部署被一条自己永远用不到的前置条件挡住，' +
        '而正确的处置是「知道就行」',
    ).toBe(0)
    const advisory = doctorCheck(missing.out, 'ssh (optional)')
    expect(advisory.ok, '缺 ssh 被标成 ✗ ⇒ 同上，可选前置被当成硬前置').toBe(true)
    expect(
      advisory.message,
      '报缺失却不说清「哪种远端会受影响、哪种不受影响」 ⇒ 用户不知道这条要不要理会',
    ).toContain('ssh:// git remotes will fail (https remotes are unaffected)')
    expect(advisory.message, '报缺失却不给装法 ⇒ 真的需要 ssh 的用户停在一句「没有」上').toContain(
      'Install openssh-client',
    )
    expectOnlyFailing(missing.out, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(shims, { recursive: true, force: true })
  }
})

test('RFC-319 OPS-011: at-rest 密钥文件权限被放宽时 doctor 点名到具体文件与实际 mode @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = cloneHome('doctor-secret')
  const tokenFile = join(home, 'token')
  try {
    expect(
      doctorCheck(runCli(home, ['doctor']).out, 'secret file protection').message,
      '一台正常启停过的机器上，token 没有落在 mode 600 ⇒ 同机的其他账号能直接读走管理员凭据',
    ).toBe('mode 600 ✓ [token]')

    // 600 之外的一切都要被点名——包括「只是加了同组可读」这种最常见的手滑
    //（改完权限忘了改回来 / 用 umask 027 的部署脚本铺文件）。
    for (const [mode, why] of [
      [0o644, '全世界可读'],
      [0o640, '同组可读'],
    ] as const) {
      chmodSync(tokenFile, mode)
      const result = runCli(home, ['doctor'])
      expect(
        result.code,
        `token 被放宽到 ${mode.toString(8)}（${why}）时 doctor 仍以 0 退出 ⇒ ` +
          '一台把管理员凭据摊开给同机其他账号的机器，在体检报告上与一台正常机器长得一模一样',
      ).toBe(1)
      const check = doctorCheck(result.out, 'secret file protection')
      expect(check.ok, `token 是 ${mode.toString(8)} 却被判通过 ⇒ 同上`).toBe(false)
      expect(
        check.message,
        `报权限不对却不说清是哪个文件、实际是多少、应该是多少 ⇒ 用户不知道该 chmod 哪一个`,
      ).toBe(`token has mode ${mode.toString(8)} (expected 600)`)
      expectOnlyFailing(result.out, ['secret file protection'])
    }

    chmodSync(tokenFile, 0o600)
    expect(
      runCli(home, ['doctor']).code,
      '把权限改回 600 之后 doctor 仍然红 ⇒ 用户照着提示修完却得不到「已经好了」的确认，' +
        '只能继续怀疑自己',
    ).toBe(0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('RFC-319 OPS-011: 备份健康读数只数 .tar.gz、报出最新一份的时间与总占用 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = cloneHome('doctor-backups')
  const backupsDir = join(home, 'backups')
  try {
    expect(
      doctorCheck(runCli(home, ['doctor']).out, 'backups').message,
      '一份备份都没有时不明说、也不给出创建命令 ⇒ 「这台机器有没有可恢复的东西」这个问题' +
        '要等到真的需要恢复那一刻才被问出来',
    ).toBe('none yet — create one with `agent-workflow backup`')

    mkdirSync(backupsDir, { recursive: true })
    const older = join(backupsDir, 'agent-workflow-older.tar.gz')
    const newer = join(backupsDir, 'agent-workflow-newer.tar.gz')
    writeFileSync(older, Buffer.alloc(1024 * 1024))
    writeFileSync(newer, Buffer.alloc(2 * 1024 * 1024))
    // 同目录下的非备份文件：真实机器上这里躺着 README / 半截下载 / 校验和。
    writeFileSync(join(backupsDir, 'notes.txt'), 'x'.repeat(1024 * 1024))
    writeFileSync(join(backupsDir, 'agent-workflow-half.tar.gz.part'), Buffer.alloc(1024 * 1024))
    const olderAt = new Date('2026-01-02T03:04:05.000Z')
    const newerAt = new Date('2026-02-03T04:05:06.000Z')
    utimesSync(older, olderAt, olderAt)
    utimesSync(newer, newerAt, newerAt)

    const withBackups = runCli(home, ['doctor'])
    const check = doctorCheck(withBackups.out, 'backups')
    expect(
      check.message,
      '备份读数把不是备份的文件也算进去了（.txt / 半截下载的 .part） ⇒ 用户以为自己有 4 份可恢复的快照，' +
        `真到恢复时只有 2 份能用；总占用也跟着虚高。实际报的是：${check.message}`,
    ).toBe(`2 backups, newest ${newerAt.toISOString()}, 3.0 MB total`)
    expect(
      withBackups.code,
      '有备份 / 没备份都不该影响 doctor 的成败——它是读数不是门禁 ⇒ 否则一台刚装好、还没来得及' +
        '做第一次备份的机器会被自己的体检判为不可用',
    ).toBe(0)

    // 单复数：`1 backup` 不带 s（`doctor.ts:196`）。这条读数会被人直接读出来，
    // 「1 backups」不是排版洁癖，是它看起来像个占位符没被填。
    rmSync(older)
    expect(
      doctorCheck(runCli(home, ['doctor']).out, 'backups').message,
      '只剩一份备份时计数没有单复数收敛 ⇒ 读起来像模板没填好',
    ).toBe(`1 backup, newest ${newerAt.toISOString()}, 2.0 MB total`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('RFC-319 OPS-010/OPS-011: 数据库损坏时 doctor 的 provider 检查报 unreadable 并给出恢复命令，其余读库项降级为「读不到」而不是跟着报警 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = cloneHome('doctor-corrupt')
  try {
    // 先把 WAL 落回主库，再砸掉文件头——否则 SQLite 会从 -wal 里读到那一页的
    // 完好副本，损坏根本不成立（第一次造现场时就撞到了这个）。
    checkpointDb(home)
    const fd = openSync(dbPathOf(home), 'r+')
    try {
      writeSync(fd, Buffer.alloc(100, 0x58), 0, 100, 0)
    } finally {
      closeSync(fd)
    }
    const beforeDoctor = sha256Of(dbPathOf(home))

    const result = runCli(home, ['doctor'])
    expect(
      result.code,
      '库已经不是一个 SQLite 文件了，doctor 却以 0 退出 ⇒ 用户拿着一份「一切正常」的体检报告，' +
        '继续往一个坏掉的库里写，直到 daemon 起不来',
    ).toBe(1)
    const integrity = doctorCheck(result.out, 'database provider')
    expect(integrity.ok, '损坏的库被判为完好 ⇒ 同上').toBe(false)
    expect(
      integrity.message,
      '报损坏却不说是哪个 provider / generation、也不给恢复入口 ⇒ 用户无法确认现场或执行恢复',
    ).toBe(
      'sqlite generation dbg_legacy_sqlite: ' +
        'sqlite-open=SQLite database is unavailable or unreadable — ' +
        'recover: agent-workflow restore <backup>',
    )

    // 另外两个读库项必须**降级**而不是各自报一次警：同一件事被报三遍会让运维
    // 去分头排查「凭据」和「任务生命周期」，而真正要做的只有恢复备份这一件。
    for (const [name, why] of [
      ['lifecycle', '任务生命周期'],
      ['repo credentials', '仓库密封凭据'],
    ] as const) {
      const degraded = doctorCheck(result.out, name)
      expect(
        degraded.ok,
        `库损坏时 \`${name}\`（${why}）也自己报了一次红 ⇒ 一次故障被拆成三条告警，` +
          '运维会分头去排查两个根本不存在的问题',
      ).toBe(true)
      expect(
        degraded.message,
        `\`${name}\` 在库读不动时没有明说自己读不到 ⇒ 它会打印一个看起来正常的读数（0 / 无），` +
          '而那正是「没问题」的样子',
      ).toContain('(unavailable:')
    }
    expectOnlyFailing(result.out, ['database provider'])

    expect(
      sha256Of(dbPathOf(home)),
      'doctor 对一个损坏的库动了手 ⇒ 一份用来诊断损坏的报告，把可能还能被抢救的字节改掉了',
    ).toBe(beforeDoctor)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('RFC-319 OPS-011: 密封的仓库凭据解不开 / secret.key 丢失，doctor 必须吵——这正是跨机恢复把库变砖的那一格 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = cloneHome('doctor-sealed')
  const secretKey = join(home, 'secret.key')
  const parkedKey = `${secretKey}.parked`
  try {
    expect(
      doctorCheck(runCli(home, ['doctor']).out, 'repo credentials').message,
      '一个还没存过任何仓库凭据的 home 上，这一项不明说 ⇒ 后面出现的任何数字都无从对照',
    ).toBe('no sealed credentials')

    // 空串 / NULL 的密文不是「解不开的凭据」，是「压根没存凭据」（`doctor.ts:109`
    // 的过滤条件）。把它们算进来会让每一台用 ssh 远端的机器凭空多出一堆告警。
    runSqlite(
      dbPathOf(home),
      `INSERT INTO cached_repos (id, url_hash, url_enc, url_redacted, local_path, last_fetched_at, created_at)
       VALUES ('01RFC319SEALEDNULL0000000', 'rfc319n', NULL, 'https://example.com/n.git', '/tmp/rfc319-n', 1, 1),
              ('01RFC319SEALEDEMPTY000000', 'rfc319e', '', 'https://example.com/e.git', '/tmp/rfc319-e', 1, 1);`,
    )
    expect(
      doctorCheck(runCli(home, ['doctor']).out, 'repo credentials').message,
      '没有密文的仓库行被当成「密封凭据」统计 ⇒ 每一台只用公开 / ssh 远端的机器都会凭空多出告警，' +
        '真正的告警被淹掉',
    ).toBe('no sealed credentials')

    // 真现场：备份**故意**不含 secret.key，所以跨机恢复之后 cached_repos 里的
    // 密文全都解不开（RFC-213 AC-12）。不吵出来的话，用户只会看到克隆莫名其妙失败。
    runSqlite(
      dbPathOf(home),
      `INSERT INTO cached_repos (id, url_hash, url_enc, url_redacted, local_path, last_fetched_at, created_at)
       VALUES ('01RFC319SEALEDBRICK000000', 'rfc319b', 'this-was-sealed-on-another-machine',
               'https://example.com/b.git', '/tmp/rfc319-b', 1, 1);`,
    )
    const bricked = runCli(home, ['doctor'])
    expect(
      bricked.code,
      '存着解不开的仓库凭据，doctor 却以 0 退出 ⇒ 跨机恢复之后用户拿到「一切正常」，' +
        '直到某个任务克隆失败才发现，而那时报错在 git 层、完全指不回这里',
    ).toBe(1)
    expect(
      doctorCheck(bricked.out, 'repo credentials').message,
      '报解不开却不说清「几条里的几条」「该做什么」 ⇒ 用户既不知道影响面，也不知道下一步',
    ).toBe(
      '1/1 sealed repo credential(s) cannot be decrypted (lost/mismatched secret.key) — re-launch those repos to re-enter',
    )
    expectOnlyFailing(bricked.out, ['repo credentials'])

    // key 整个丢了是另一种现场（处置一样，但原因判断完全不同），话必须不一样。
    renameSync(secretKey, parkedKey)
    const keyless = runCli(home, ['doctor'])
    expect(keyless.code, 'secret.key 丢了却不让 doctor 变红 ⇒ 同上').toBe(1)
    expect(
      doctorCheck(keyless.out, 'repo credentials').message,
      'key 丢失与密文对不上说同一句话 ⇒ 用户分不清是「钥匙没了」还是「钥匙换了」，' +
        '而前者还有可能从别处找回来',
    ).toBe(
      '1 sealed repo credential(s) but secret.key is MISSING — re-launch those repos to re-enter (restored from another machine?)',
    )
    renameSync(parkedKey, secretKey)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('RFC-319 OPS-011: lifecycle 把停放 / 中断 / 隔离的任务与未解决告警逐项数出来，但不把 doctor 判红 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = cloneHome('doctor-lifecycle')
  try {
    expect(
      doctorCheck(runCli(home, ['doctor']).out, 'lifecycle').message,
      '一个干净的 home 上这一项不明说「什么都没停放」 ⇒ 后面出现的数字没有对照基线',
    ).toBe('no parked / interrupted tasks, no open alerts')

    const task = (id: string, status: string, quarantined: 0 | 1): string =>
      `('${id}', '${id}', 'rfc319-wf', '{}', '/tmp/rfc319-repo', '/tmp/rfc319-worktree', ` +
      `'main', 'agent-workflow/${id}', '${status}', '{}', 1, ${quarantined})`
    runSqlite(
      dbPathOf(home),
      `INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
         base_branch, branch, status, inputs, started_at, auto_recovery_suspended)
       VALUES ${[
         task('01RFC319LIFEINT1000000000', 'interrupted', 0),
         task('01RFC319LIFEINT2000000000', 'interrupted', 0),
         task('01RFC319LIFEREVIEW0000000', 'awaiting_review', 0),
         task('01RFC319LIFEHUMAN00000000', 'awaiting_human', 0),
         task('01RFC319LIFEQUARANTINED00', 'failed', 1),
         task('01RFC319LIFEDONE000000000', 'done', 0),
       ].join(', ')};
       INSERT INTO lifecycle_alerts (id, task_id, rule, severity, detail, detected_at, resolved_at)
       VALUES ('01RFC319ALERTOPEN00000000', '01RFC319LIFEINT1000000000', 'R1', 'warning', '{}', 1, NULL),
              ('01RFC319ALERTFIXED0000000', '01RFC319LIFEINT2000000000', 'R2', 'error', '{}', 1, 2);`,
    )

    const parked = runCli(home, ['doctor'])
    expect(
      doctorCheck(parked.out, 'lifecycle').message,
      'lifecycle 的读数没有跟着库里真实的行走 ⇒ 这一行是装饰品：一支卡住的机队' +
        '（一批可恢复的中断任务、一批等人回话的任务、一批被自动恢复隔离的任务）' +
        '在体检报告上与一支健康机队完全一样。注意 `done` 不该被算进来，已解决的告警也不该。',
    ).toBe(
      '2 interrupted (resumable), 1 awaiting-review, 1 awaiting-human, 1 auto-recovery-quarantined, 1 open alert',
    )
    expect(
      parked.code,
      '一批停放中的任务把 doctor 判红 ⇒ 「等人回话」「等人评审」是这个产品的正常工作状态，' +
        '把它算成安装故障会让所有跑 doctor 的巡检脚本长期报警，真故障被淹没',
    ).toBe(0)
    expect(doctorCheck(parked.out, 'lifecycle').ok, '同上：停放不是故障').toBe(true)

    runSqlite(
      dbPathOf(home),
      `INSERT INTO lifecycle_alerts (id, task_id, rule, severity, detail, detected_at, resolved_at)
       VALUES ('01RFC319ALERTOPEN20000000', '01RFC319LIFEREVIEW0000000', 'T1', 'warning', '{}', 1, NULL);`,
    )
    expect(
      doctorCheck(runCli(home, ['doctor']).out, 'lifecycle').message,
      '未解决告警的计数没有跟着新告警走 / 单复数没收敛 ⇒ 这条读数读起来像个没填的模板',
    ).toContain('2 open alerts')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-014 —— db compact
// ---------------------------------------------------------------------------

test('RFC-319 OPS-014: daemon 在跑时 db compact 拒绝执行，并且一页空洞都没动 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = freshDir('compact-live')
  const daemon: DaemonHandle = await startDaemon({ home })
  try {
    plantFreePages(home)
    const freeBefore = freelistPages(home)
    expect(
      freeBefore,
      '前提不成立：造不出空洞页，后面「有没有真的 VACUUM」就无从判定',
    ).toBeGreaterThan(100)

    const livePid = readFileSync(join(home, '.daemon.lock'), 'utf8').trim()
    const refused = runCli(home, ['db', 'compact'])

    expect(
      refused.code,
      'daemon 在跑时 `db compact` 以 0 退出 ⇒ 维护脚本把它当成做完了，' +
        '而 VACUUM 要么没跑、要么正持着写锁把全站冻住——两种都不该被记为成功',
    ).toBe(1)
    expect(
      refused.out,
      '拒绝时不报出正在占用的那个 PID ⇒ 一台跑着多个实例的机器上，用户不知道该停哪一个',
    ).toContain(`daemon is running (pid ${livePid})`)
    expect(
      refused.out,
      '拒绝时不说清为什么不能带着 daemon 跑 ⇒ 用户会以为这是多余的洁癖，转头去找绕过的办法',
    ).toContain('VACUUM rewrites the whole database while holding')
    expect(refused.out, '拒绝时不给下一步动作 ⇒ 用户知道不行，但不知道该敲什么').toContain(
      'Stop it first:  agent-workflow stop',
    )
    expect(
      refused.out,
      '一边说 daemon 在跑，一边又打印了「已压缩」的回执 ⇒ 输出自相矛盾，用户只能信其中一半',
    ).not.toContain('compacted ')

    // 这一格最值钱：拒绝必须是**真的没做**，不是嘴上拒绝。VACUUM 会把 freelist
    // 清零，所以空洞还在，就是「一页都没动过」的直接证据。（不写死等于
    // `freeBefore`：活着的 daemon 自己也会写库、消耗掉几页，那种漂移与本条无关。）
    expect(
      freelistPages(home),
      `\`db compact\` 说自己拒绝了，空洞却从 ${freeBefore} 页塌了下去 ⇒ 它其实还是 VACUUM 了：` +
        '在一个活着的 daemon 底下重写整个库，持写锁的那几十秒里每一个请求都被冻住，' +
        '而运维看到的是一条「已拒绝」的消息',
    ).toBeGreaterThan(freeBefore / 2)

    const health = await fetch(`${daemon.baseUrl}/health`)
    expect(
      health.status,
      '一次被拒绝的 `db compact` 把在跑的 daemon 弄坏了 ⇒ 这条闸门本身成了故障源',
    ).toBe(200)
  } finally {
    await daemon.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('RFC-319 OPS-014: 停机后 db compact 真把空洞还给文件系统；无库时明说，子命令写错以退出码 2 拒绝 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = cloneHome('compact-stopped')
  const empty = freshDir('compact-nodb')
  try {
    plantFreePages(home)
    checkpointDb(home)
    const pageSize = dbPageSize(home)
    const freeBefore = freelistPages(home)
    const sizeBefore = statSync(dbPathOf(home)).size
    expect(freeBefore, '前提不成立：造不出空洞页').toBeGreaterThan(100)

    const compacted = runCli(home, ['db', 'compact'])
    expect(
      compacted.code,
      '停机之后 `db compact` 仍以非 0 退出 ⇒ 维护窗口里唯一能回收磁盘的手段用不了，' +
        '而它是被设计成「只能在停机时跑」的，没有第二条路',
    ).toBe(0)
    expect(
      compacted.out,
      '压缩完不报出动的是哪个库 ⇒ 一台有多个 $AGENT_WORKFLOW_HOME 的机器上无法确认动对了没有',
    ).toContain(`compacted ${dbPathOf(home)}`)
    expect(
      Number(/\((\d+) free pages × (\d+)B\)/.exec(compacted.out)?.[1] ?? '-1'),
      `回执报的可回收页数与库里真实的 freelist（${freeBefore} 页）对不上 ⇒ ` +
        '「本次维护能拿回多少磁盘」这个读数是编的，用户据它决定要不要开维护窗口',
    ).toBe(freeBefore)
    expect(
      compacted.out,
      '回执里的「压缩前大小」与磁盘上的实际大小对不上 ⇒ 这份回执读的不是被操作的那个文件',
    ).toContain(`file size: ${(sizeBefore / 1024 / 1024).toFixed(1)} MiB → `)

    // 只断言**磁盘上真实发生了什么**，不断言回执里的「freed」数字——那一行今天是
    // 错的（见文件末尾「已发现缺陷」①：WAL 下 `after` 在 close 之前就读了）。
    // 把错的数字写进断言等于把缺陷锁死。
    const sizeAfter = statSync(dbPathOf(home)).size
    expect(
      freelistPages(home),
      'VACUUM 之后 freelist 仍不为零 ⇒ 空洞根本没被回收，这条命令只是慢慢地什么都没做',
    ).toBe(0)
    expect(
      sizeAfter,
      `\`db compact\` 跑完，磁盘上的库却没有明显变小（${sizeBefore} → ${sizeAfter} 字节，` +
        `本该至少还回 ${freeBefore} 页 × ${pageSize}B 的一半）⇒ ` +
        '用户为此专门停了一次机、冻了一段服务，磁盘一个字节都没还回来',
    ).toBeLessThan(sizeBefore - (freeBefore * pageSize) / 2)

    // 指错 home 是最常见的手滑。此时**绝不能**顺手建一个空库出来：那会让下一次
    // 真正的诊断（downgrade-audit / restore 前置检查）对着一个假库做判断。
    const noDb = runCli(empty, ['db', 'compact'])
    expect(
      noDb.code,
      '对着一个没有库的目录 `db compact` 以 0 退出 ⇒ 脚本认为压缩成功了，' +
        '而真正那个库还堆着一样多的空洞',
    ).toBe(1)
    expect(noDb.out, '没有库时不明说 ⇒ 用户读不出「是路径错了」这个结论').toBe(
      `no database at ${dbPathOf(empty)}\n`,
    )
    expect(
      readdirSync(empty),
      '一次针对空目录的 `db compact` 在那里建出了文件 ⇒ 指错路径的手滑就此在机器上留下了一个假状态',
    ).toEqual([])

    // `db` 下面只有 compact 一个动作，写错必须以「用法错误」而不是「执行失败」收场。
    // （只列这两种：`db compact <多余参数>` 实测是被**忽略**的——`main.ts:106` 只看
    //  argv[3]，多余参数照常执行压缩。那是常见的 CLI 宽容度，不是缺陷，所以不断言。）
    for (const args of [['db'], ['db', 'vacuum']]) {
      const misuse = runCli(home, args)
      expect(
        misuse.code,
        `\`agent-workflow ${args.join(' ')}\` 没有以退出码 2 拒绝 ⇒ 脚本分不清「命令写错了」` +
          '和「压缩失败了」，会对一个永远不可能成功的写法一直重试',
      ).toBe(2)
      expect(
        misuse.out,
        `\`agent-workflow ${args.join(' ')}\` 被拒时不给正确写法 ⇒ 用户只能去翻文档`,
      ).toContain('usage: agent-workflow db compact')
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-015 —— downgrade-audit rfc-295
// ---------------------------------------------------------------------------

test('RFC-319 OPS-015: downgrade-audit 全清时报 OK 并退出 0，且全程只读——连一个空库都不会建出来 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = cloneHome('audit-ok')
  const empty = freshDir('audit-nodb')
  try {
    const workflowCount = querySqlite<{ n: number }>(
      dbPathOf(home),
      'SELECT count(*) AS n FROM workflows;',
    )[0]?.n
    expect(workflowCount, '前提不成立：读不到 workflows 行数').toBeGreaterThan(0)
    const before = sha256Of(dbPathOf(home))

    const clean = runCli(home, ['downgrade-audit', 'rfc-295'])
    expect(
      clean.code,
      '没有任何阻断项时闸门仍以非 0 退出 ⇒ 回滚前的这道检查永远说「不行」，' +
        '用完一次之后就没人再看它',
    ).toBe(0)
    expect(
      clean.out,
      '闸门放行时没有报出**扫了多少东西** ⇒ 「它到底看没看」和「它看完说没事」在输出上长得一样；' +
        '一次因为查询写错而扫到 0 行的放行，与一次真正的放行无法区分',
    ).toBe(
      `RFC-295 downgrade audit: OK; scanned ${workflowCount} workflow(s), 0 live/resumable task(s), 0 frozen closure workflow(s)\n`,
    )
    expect(
      sha256Of(dbPathOf(home)),
      '回滚前的只读闸门改写了数据库 ⇒ 它跑在「准备降级回旧版本」这个最脆弱的时刻，' +
        '任何写入都可能是旧版本读不懂的',
    ).toBe(before)

    // 最硬的只读证据：对着一个还没有库的 home，它必须直接说「没有库」，
    // 而不是像 `migrate` 那样顺手建一个出来。降级前的机器上凭空多出一个空库，
    // 会让后面每一道「库在哪一版」的判断都得到错误答案。
    const noDb = runCli(empty, ['downgrade-audit', 'rfc-295'])
    expect(noDb.code, '没有库时闸门以非 0 退出 ⇒ 全新机器上的回滚演练第一步就断了').toBe(0)
    expect(noDb.out, '没有库时不明说 ⇒ 用户读不出「这台机器上没有要审的东西」').toContain(
      '(no database)',
    )
    expect(
      readdirSync(empty),
      '只读闸门在一个空目录里建出了文件 ⇒ 它不是只读的；降级前的现场被这条命令自己改了',
    ).toEqual([])

    for (const args of [
      ['downgrade-audit'],
      ['downgrade-audit', 'rfc-296'],
      ['downgrade-audit', 'RFC-295'],
    ]) {
      const misuse = runCli(home, args)
      expect(
        misuse.code,
        `\`agent-workflow ${args.join(' ')}\` 没有以退出码 2 拒绝 ⇒ 拼错的闸门名会静默地什么都不审，` +
          '而回滚脚本把它记成「审过了」',
      ).toBe(2)
      expect(
        misuse.out,
        `\`agent-workflow ${args.join(' ')}\` 被拒时不给正确写法 ⇒ 用户只能去翻文档`,
      ).toContain('usage: agent-workflow downgrade-audit rfc-295')
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

test('RFC-319 OPS-015: downgrade-audit 逐条点名阻断项、只审在途任务，且没有任何绕过开关 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = cloneHome('audit-blocked')
  try {
    const workflowsBefore = querySqlite<{ n: number }>(
      dbPathOf(home),
      'SELECT count(*) AS n FROM workflows;',
    )[0]?.n as number

    // 三个现场：一个存量工作流、一个**在途**任务的冻结快照、一个**已完成**任务的
    // 冻结快照。最后一个必须被跳过——已完成的任务不会再被旧版本执行，把它算成
    // 阻断项等于让每一台跑过一阵子的机器永远降不了级。
    runSqlite(
      dbPathOf(home),
      `INSERT INTO workflows (id, name, definition, version)
       VALUES ('01RFC319AUDITWF0000000000', 'rfc319-audit-wf', '{ not json at all', 7);
       INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, workflow_version, repo_path,
         worktree_path, base_branch, branch, status, inputs, started_at)
       VALUES ('01RFC319AUDITLIVE00000000', 'rfc319-live', '01RFC319AUDITWFLIVE000000',
               '{ neither is this', 3, '/tmp/rfc319-repo', '/tmp/rfc319-worktree', 'main',
               'agent-workflow/rfc319-live', 'interrupted', '{}', 1),
              ('01RFC319AUDITDONE00000000', 'rfc319-done', '01RFC319AUDITWFDONE000000',
               '{ nor this one', 3, '/tmp/rfc319-repo', '/tmp/rfc319-worktree', 'main',
               'agent-workflow/rfc319-done', 'done', '{}', 1);`,
    )
    const before = sha256Of(dbPathOf(home))

    const blocked = runCli(home, ['downgrade-audit', 'rfc-295'])
    expect(
      blocked.code,
      '存在旧版本读不懂的数据，闸门却以 0 退出 ⇒ 回滚脚本一路跑到底，' +
        '降级完成之后才在保存 / 启动 / 恢复时逐个炸开，而那时已经没有回头路',
    ).toBe(1)
    expect(
      blocked.out,
      '闸门拦下来时没有说「拦住了」 ⇒ 输出与放行长得像，人读脚本日志时会看漏',
    ).toContain('RFC-295 downgrade audit: BLOCKED;')
    expect(
      blocked.out,
      '扫描计数没有把新加的工作流算进去 / 把已完成任务也算成在途 ⇒ 闸门读的不是真实库存',
    ).toContain(
      `scanned ${workflowsBefore + 1} workflow(s), 1 live/resumable task(s), 0 frozen closure workflow(s)`,
    )
    expect(
      blocked.out,
      '拦下来却不点名是哪个工作流的哪一版 ⇒ 用户拿到一句「不能降级」，无从下手去修',
    ).toContain('- definition-invalid workflow=01RFC319AUDITWF0000000000 revision=7 pointer=/:')
    expect(
      blocked.out,
      '在途任务冻结的那份快照没有被审 ⇒ 降级之后正是这些任务要被旧版本恢复执行，' +
        '它们才是回滚的真正风险面',
    ).toContain('task=01RFC319AUDITLIVE00000000')
    expect(
      blocked.out,
      '已完成任务的冻结快照也被算成阻断项 ⇒ 一台跑过一阵子的机器会因为历史任务永远降不了级，' +
        '而那些任务根本不会再被执行',
    ).not.toContain('01RFC319AUDITDONE00000000')

    // 这条命令**故意**没有 force / ignore 开关（`services/rfc295DowngradeAudit.ts:243-246`）。
    // 多给几个参数不该被解释成「我知道我在做什么」。
    const forced = runCli(home, ['downgrade-audit', 'rfc-295', '--force', '--yes'])
    expect(
      forced.code,
      '多带一个 `--force` 就让闸门放行 ⇒ 这道闸门形同虚设：遇到拦截时最自然的下一步' +
        '就是加一个看起来像开关的参数再试一次',
    ).toBe(1)
    expect(forced.out, '同上：带上绕过参数之后结论变了').toContain(
      'RFC-295 downgrade audit: BLOCKED;',
    )

    expect(
      sha256Of(dbPathOf(home)),
      '闸门在**有阻断项**的那条路径上改写了数据库 ⇒ 只读承诺只在没事时成立，' +
        '恰恰在出事时不成立',
    ).toBe(before)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-012 / OPS-013 —— migrate 与 migration-report
//
// 这两条**曾经在发行二进制上一跑就挂**（`Can't find meta/_journal.json file`，
// 退出码 1）：`cli/migrate.ts` / `cli/migrationReport.ts` 把源码树里的
// `Paths.migrationsDir` 直接交给 `openDb`，而 `bun build --compile` 会把
// `import.meta.dirname` 烤成 `/`（`embed.ts` 自己写着这句），那是一个不存在的
// 路径。主干 f565b1cb7 把九个调用点收敛到 `util/migrationsFolder.ts` 的
// `resolveMigrationsFolder()` 之后才成立——下面两条正是那条修复的回归网，
// 源码侧另有 `packages/backend/tests/cli-embedded-migrations.test.ts` 守着不复辟。
// ---------------------------------------------------------------------------

test('RFC-319 OPS-012: migrate 在发行二进制上真的把库建起来，应用条数与二进制自称嵌的条数逐一对上，且重跑不重复应用 @nightly', () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = freshDir('migrate')
  try {
    // doctor 与 migrate 是两条互不相干的读法：一条数二进制里嵌了多少 .sql，
    // 一条把它们真的应用到库里。把两个数字对起来，才是「这个包能建出完整的库」
    // 这句话的证据；单看任何一个都可能是「嵌了但没应用」或「应用了半截」。
    const embedded = Number(
      /^(\d+)/.exec(doctorCheck(runCli(home, ['doctor']).out, 'migrations folder').message)?.[1] ??
        '0',
    )
    expect(embedded, '前提不成立：二进制自称嵌了 0 条迁移').toBeGreaterThan(0)
    expect(
      existsSync(dbPathOf(home)),
      '前提不成立：还没 migrate 就已经有库了，下面的「建起来了」就无从判定',
    ).toBe(false)

    const applied = runCli(home, ['migrate'])
    expect(
      applied.code,
      '`migrate` 在发行二进制上以非 0 退出 ⇒ 一台 daemon 起不来的机器上，' +
        '唯一那条「手工把迁移补上再看看」的退路是断的，运维只剩重装或恢复备份',
    ).toBe(0)
    expect(
      applied.out,
      '`migrate` 不报出它动的是哪个库 ⇒ 一台有多个 $AGENT_WORKFLOW_HOME 的机器上无法确认动对了没有',
    ).toBe(`migrations applied (database: ${dbPathOf(home)})\n`)

    const appliedRows = querySqlite<{ n: number }>(
      dbPathOf(home),
      'SELECT count(*) AS n FROM __drizzle_migrations;',
    )[0]?.n
    expect(
      appliedRows,
      `\`migrate\` 说自己应用完了，库里却只记了 ${String(appliedRows)} 条迁移（二进制嵌了 ${embedded} 条）⇒ ` +
        '这个库是半截的：缺的那些表 / 列要等 daemon 真的去读它们时才炸，' +
        '而那时错误信息只会说某张表不存在',
    ).toBe(embedded)

    // 记账表对上还不够——真正要用的是业务表。只建了 `__drizzle_migrations`
    // 的库同样能让上面那条通过。
    const tables = querySqlite<{ name: string }>(
      dbPathOf(home),
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks','workflows','cached_repos','users') ORDER BY name;",
    ).map((row) => row.name)
    expect(
      tables,
      '迁移记账表对上了，业务表却没建出来 ⇒ 这个库看起来是新的、实际不可用，' +
        'daemon 起来之后第一条查询就会失败',
    ).toEqual(['cached_repos', 'tasks', 'users', 'workflows'])
    expect(
      doctorCheck(runCli(home, ['doctor']).out, 'database provider').message,
      '`migrate` 造出来的库过不了完整性检查 ⇒ 这条恢复退路交付的是一个一出生就坏的库',
    ).toBe('sqlite generation dbg_legacy_sqlite: sqlite-quick-check=ok')

    // 重跑必须是无害的：运维在不确定「刚才那条到底跑没跑」时的第一反应就是再敲一次。
    const again = runCli(home, ['migrate'])
    expect(
      again.code,
      '第二次 `migrate` 以非 0 退出 ⇒ 「不确定跑没跑就再跑一次」这个最自然的动作会把人吓一跳，' +
        '而它本该是安全的',
    ).toBe(0)
    expect(
      querySqlite<{ n: number }>(
        dbPathOf(home),
        'SELECT count(*) AS n FROM __drizzle_migrations;',
      )[0]?.n,
      '重跑 `migrate` 把迁移又应用了一遍 ⇒ 记账表被灌了重复行，' +
        '下一次升级判断「哪些还没应用」时就会读到一个说不通的历史',
    ).toBe(embedded)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('RFC-319 OPS-013: migration-report 把每条 legacy 资产逐项定性，--json 给出同一份数字，且全程不落库 @nightly', () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = freshDir('migreport')
  try {
    expect(runCli(home, ['migrate']).code, '前提不成立：建不出库').toBe(0)

    const empty = runCli(home, ['migration-report'])
    expect(
      empty.code,
      '没有任何 legacy 资产时报告以非 0 退出 ⇒ cutover 前的这次对账在「本来就没东西要迁」' +
        '的机器上直接失败，而那正是最该顺利通过的一种',
    ).toBe(0)
    expect(
      empty.out,
      '没有 legacy 资产时不明说 total 0 ⇒ 「扫过了、确实没有」与「根本没扫」在输出上没有区别',
    ).toContain('total 0 · mappable 0 · partial 0 · blocked 0')

    // 三种定性各造一条，外加一条矩阵行——报告的价值全在这个分类上：
    // 能机械迁的、必须人工二选一的、和绝不允许平台替人猜的。
    runSqlite(
      dbPathOf(home),
      `INSERT INTO capability_templates (id, name, capability, scripts_json, hooks_json,
         param_schema_json, param_defaults_json, agent_by_slot_json, prompt_by_slot_json,
         params_json, created_at, updated_at)
       VALUES ('01RFC319TPLCIFIX00000000', 'rfc319-ci', 'ci-fix', '{}', '[]', '[]', '{}',
               '{"ci-fixer":"rfc319-agent"}', '{}', '{}', 1, 1),
              ('01RFC319TPLREVIEW0000000', 'rfc319-review', 'mr-review', '{}', '[]', '[]', '{}',
               '{"reviewer":"rfc319-agent"}', '{}', '{}', 1, 1),
              ('01RFC319TPLUNKNOWN000000', 'rfc319-odd', 'totally-unknown-capability', '{}', '[]',
               '[]', '{}', '{}', '{}', '{}', 1, 1);
       INSERT INTO repo_capability_config (id, repo_id, capability, template_id, enabled,
         trigger_config_json, created_at, updated_at)
       VALUES ('01RFC319MATRIX0000000000', '01RFC319REPO000000000000', 'ci-fix',
               '01RFC319TPLCIFIX00000000', 1, '{}', 1, 1);`,
    )

    const report = runCli(home, ['migration-report'])
    expect(report.code, '有 legacy 资产时报告以非 0 退出 ⇒ 对账物料拿不到').toBe(0)
    expect(
      report.out,
      '汇总数字没有跟着库里真实的 legacy 行走 ⇒ 这份报告是 cutover 的对账物料，' +
        '数字对不上就等于没对过账。两张 capability_templates 表 + 一张矩阵行共 4 条：' +
        '可机械迁 1、需人工二选一 1、不许猜 2',
    ).toContain('total 4 · mappable 1 · partial 1 · blocked 2')
    expect(
      report.out,
      '能机械迁的那条没有被定成 MAPPABLE / 没有给出目标资源 ⇒ 人工要重新把它读一遍才知道能不能迁',
    ).toContain('MAPPABLE  capability-template [ci-fix]  rfc319-ci')
    expect(
      report.out,
      'mr-review 没有同时产出两个候选 ⇒ 「change.review 还是 mr.review.external」这个必须人工做的' +
        '选择被平台悄悄替人做了，而两者的语义完全不同',
    ).toContain('→ action-template  rfc319-review-change-review')
    expect(report.out, '同上：另一个候选也必须在报告里').toContain(
      '→ action-template  rfc319-review-mr-review-external',
    )
    expect(
      report.out,
      'mr-review 没有被标出「必须人工二选一」 ⇒ 迁移的人不知道这里还欠一个决定，' +
        '两份候选就可能被一起发布成 active',
    ).toContain('✗ mr-review-purpose-choice')
    expect(
      report.out,
      '认不出的能力没有被点名拒绝 ⇒ 平台会对一条它读不懂的历史配置保持沉默，' +
        '而沉默在 cutover 清单上等于「已处理」',
    ).toContain('✗ unknown-capability:totally-unknown-capability')

    // `--json` 是给脚本读的那一份：它必须能解析，且与人读那份说同一件事。
    const asJson = runCli(home, ['migration-report', '--json'])
    expect(asJson.code, '`--json` 以非 0 退出 ⇒ 自动化对账拿不到结构化结果').toBe(0)
    const parsed = JSON.parse(asJson.out) as {
      summary: { total: number; mappable: number; partial: number; blocked: number }
      items: { legacyKind: string; legacyCapability: string | null; disposition: string }[]
    }
    expect(
      parsed.summary,
      '`--json` 的汇总与人读那份对不上 ⇒ 同一次分析给出两套数字，对账时不知道该信哪一份',
    ).toEqual({ total: 4, mappable: 1, partial: 1, blocked: 2 })
    expect(
      parsed.items.map(
        (item) => `${item.legacyKind}:${item.legacyCapability ?? '-'}:${item.disposition}`,
      ),
      '`--json` 的逐条定性与人读那份不一致 ⇒ 同上；尤其 repo-capability-config 这一类' +
        '如果整块漏掉，矩阵侧的迁移债在自动化对账里就是隐形的',
    ).toEqual([
      'capability-template:ci-fix:mappable',
      'capability-template:mr-review:partial',
      'capability-template:totally-unknown-capability:blocked',
      'repo-capability-config:-:blocked',
    ])

    // 报告是**只读分析**：落库（materialize）是 cutover runbook 里另一个显式步骤。
    // 报告本身建 candidate 会让「先看看再决定」这句话不成立。
    expect(
      querySqlite<{ n: number }>(
        dbPathOf(home),
        "SELECT count(*) AS n FROM maintenance_state WHERE key = 'rfc310-migration-report';",
      )[0]?.n,
      '只跑了一次报告，落库结果就被写进 maintenance_state ⇒ 「先看看再决定」变成了「看一眼就落地」',
    ).toBe(0)
    expect(
      querySqlite<{ n: number }>(dbPathOf(home), 'SELECT count(*) AS n FROM action_templates;')[0]
        ?.n,
      '只跑了一次报告，candidate 资源就被建出来了 ⇒ 分析与落库两步被合成一步，' +
        '而落库那一步本来需要人先把报告里的人工项逐条处理掉',
    ).toBe(0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-X8 —— 隐藏子命令 `__git-credential`
// ---------------------------------------------------------------------------

interface ProbeRequest {
  readonly path: string
  readonly authorization: string | null
}

interface CredentialProbe {
  readonly port: number
  /** 迄今为止进来的每一次请求：路径 + Authorization 头（没有就是 null）。 */
  seen(): Promise<ProbeRequest[]>
  close(): Promise<void>
}

type ProbeMessage = { kind: 'listening'; port: number } | { kind: 'seen'; requests: ProbeRequest[] }

/**
 * 一个要求 Basic 认证的**最小 git smart-HTTP 端点**，跑在 worker 线程里。
 *
 * 为什么用真的 git 驱动：生产里这条隐藏子命令唯一的调用方就是 git——它先吃 401，
 * 再按 `credential.helper` 去问助手，拿到答案才带上 Authorization 重试。中间任何
 * 一环对不上（协议名、authority 规范化、仓库路径），git 都会静默地拿不到凭据，
 * 而那正是要测的东西。
 *
 * 为什么必须放进**另一个线程**：e2e 唯一允许的子进程边界是同步的（那份硬超时正是
 * 靠同步调用兑现的），它会把整个事件循环堵住。服务端与它同线程时，git 的请求在
 * 15s 里一次都不会被 accept，拿回来的是 harness 的超时而不是产品行为——第一版就是
 * 这样红的，而且红得像「助手不回答」，完全指错方向。
 */
const CREDENTIAL_PROBE_SOURCE = `
const http = require('node:http')
const { parentPort } = require('node:worker_threads')

const requests = []
const line = Buffer.from(
  '0000000000000000000000000000000000000000 capabilities^{}\\u0000agent=rfc319\\n',
  'utf8',
)
const advertisement = Buffer.concat([
  Buffer.from('001e# service=git-upload-pack\\n0000', 'utf8'),
  Buffer.from((line.length + 4).toString(16).padStart(4, '0'), 'utf8'),
  line,
  Buffer.from('0000', 'utf8'),
])

const server = http.createServer((req, res) => {
  const authorization = req.headers.authorization === undefined ? null : req.headers.authorization
  requests.push({ path: req.url === undefined ? '' : req.url, authorization })
  if (authorization === null) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="rfc319"', 'Content-Length': '0' })
    res.end()
    return
  }
  res.writeHead(200, {
    'Content-Type': 'application/x-git-upload-pack-advertisement',
    'Content-Length': String(advertisement.length),
  })
  res.end(advertisement)
})

parentPort.on('message', () => {
  parentPort.postMessage({ kind: 'seen', requests })
})

server.listen({ host: '127.0.0.1', port: 0 }, () => {
  parentPort.postMessage({ kind: 'listening', port: server.address().port })
})
`

async function startCredentialProbe(): Promise<CredentialProbe> {
  const worker = new Worker(CREDENTIAL_PROBE_SOURCE, { eval: true, execArgv: [] })
  const port = await new Promise<number>((resolveListen, rejectListen) => {
    const onMessage = (message: ProbeMessage): void => {
      if (message.kind !== 'listening') return
      worker.off('message', onMessage)
      resolveListen(message.port)
    }
    worker.on('message', onMessage)
    worker.once('error', rejectListen)
  })
  return {
    port,
    seen: () =>
      new Promise<ProbeRequest[]>((resolveSeen) => {
        const onMessage = (message: ProbeMessage): void => {
          if (message.kind !== 'seen') return
          worker.off('message', onMessage)
          resolveSeen(message.requests)
        }
        worker.on('message', onMessage)
        worker.postMessage('seen')
      }),
    close: async () => {
      await worker.terminate()
    },
  }
}

test('RFC-319 OPS-X8: __git-credential 只回答协议 / 主机 / 仓库路径三者全中的那一次 get @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const target = await startCredentialProbe()
  const sibling = await startCredentialProbe()
  const scratch = freshDir('gitcred')
  const leasePath = join(scratch, 'lease.json')
  const username = 'rfc319-publisher'
  const password = 'rfc319-one-shot-secret'
  const expectedBasic = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  try {
    writeFileSync(
      leasePath,
      JSON.stringify({
        version: 1,
        protocol: 'http',
        host: `127.0.0.1:${target.port}`,
        path: 'rfc319/target.git',
        username,
        password,
      }),
      { mode: 0o600 },
    )

    // 与生产装配同形（`util/gitCredentialLease.ts:188-203`）：先清空继承来的
    // helper 链，再挂上自己这一条；`useHttpPath=true` 是路径能进请求的前提。
    const helper = `!'${defaultBinaryPath()}' '__git-credential'`
    const askpass = join(scratch, 'no-askpass-here')
    const gitEnv = {
      AW_GIT_CRED_FILE: leasePath,
      GIT_TERMINAL_PROMPT: '0',
      // 指向一个不存在的文件：这样「助手没给凭据」在任何机器上都稳定落到
      // 「拿不到密码」这个结局，而不是取决于跑测试的人有没有设 GIT_ASKPASS。
      GIT_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: 'never',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      no_proxy: '*',
      NO_PROXY: '*',
    }
    const lsRemote = (
      url: string,
      env: Record<string, string> = gitEnv,
    ): { code: number; out: string } => {
      const result = runCommandResult(
        'git',
        [
          '-c',
          'credential.helper=',
          '-c',
          'credential.useHttpPath=true',
          '-c',
          'credential.interactive=false',
          '-c',
          `credential.helper=${helper}`,
          'ls-remote',
          url,
        ],
        { env },
      )
      return { code: result.status, out: result.output }
    }

    // ① 全中：git 必须真的拿到凭据并带着它重试。
    const hit = lsRemote(`http://127.0.0.1:${target.port}/rfc319/target.git`)
    expect(
      hit.code,
      '协议 / 主机 / 路径全中，git 却没能完成认证 ⇒ 这条隐藏子命令是平台向外推代码的唯一凭据通道，' +
        '它不答就等于所有 https 推送 / 克隆全部失败，而失败信息只会说「拿不到密码」。' +
        `git 说：${hit.out}`,
    ).toBe(0)
    const afterHit = await target.seen()
    expect(
      afterHit.map((request) => request.authorization),
      '目标端点没有收到那份租约里的凭据 ⇒ 助手要么没被调用、要么答错了人',
    ).toContain(expectedBasic)
    expect(
      afterHit[0]?.authorization,
      '第一次请求就带上了凭据 ⇒ 凭据在服务端还没提出要求时就被发出去了',
    ).toBeNull()

    // ② 同一台主机上的**另一个仓库**：这是 RFC-321 存在的理由——同机的另一个项目
    //    （或一个恶意 submodule）不能顺手拿走这次发布用的凭据。
    const siblingHit = lsRemote(`http://127.0.0.1:${target.port}/rfc319/other-team.git`)
    const siblingSeen = (await target.seen()).filter((request) =>
      request.path.includes('other-team'),
    )
    expect(
      siblingSeen.length,
      '前提不成立：git 根本没去请求那个并列仓库，下面的「没拿到凭据」就成了空转',
    ).toBeGreaterThan(0)
    expect(
      siblingSeen.filter((request) => request.authorization !== null),
      '同主机上另一个仓库路径拿到了凭据 ⇒ 一个并列项目 / 一个恶意 submodule ' +
        '只要指向同一台主机，就能把这次发布用的密码骗走',
    ).toEqual([])
    expect(siblingHit.code, '路径不匹配却仍然认证成功 ⇒ 同上，路径这一维的绑定形同虚设').not.toBe(0)

    // ③ 另一台主机：authority 不同就一个字节都不该给。
    const otherHost = lsRemote(`http://127.0.0.1:${sibling.port}/rfc319/target.git`)
    const otherHostSeen = await sibling.seen()
    expect(
      otherHostSeen.length,
      '前提不成立：git 没去请求另一台主机，下面的断言成了空转',
    ).toBeGreaterThan(0)
    expect(
      otherHostSeen.filter((request) => request.authorization !== null),
      '换了一个 authority（不同端口）仍然拿到了凭据 ⇒ 把远端地址改一改就能把密码钓走',
    ).toEqual([])
    expect(otherHost.code, '主机不匹配却仍然认证成功 ⇒ 同上').not.toBe(0)

    // ④ 没有租约文件：助手绝不能退回到任何环境里现成的凭据存储。
    const seenBeforeNoLease = (await target.seen()).length
    const noLease = lsRemote(`http://127.0.0.1:${target.port}/rfc319/target.git`, {
      ...gitEnv,
      AW_GIT_CRED_FILE: '',
    })
    expect(
      (await target.seen()).slice(seenBeforeNoLease).filter((r) => r.authorization !== null),
      '没有租约时助手还是给出了凭据 ⇒ 它在读某个环境里现成的凭据存储，' +
        '那意味着任务进程能借这条通道拿到不属于它的密码',
    ).toEqual([])
    expect(noLease.code, '没有租约却仍然认证成功 ⇒ 同上').not.toBe(0)
  } finally {
    await target.close()
    await sibling.close()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('RFC-319 OPS-X8: __git-credential 不出现在用法里，且对 get 以外的操作一个字节都不输出 @nightly', () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = freshDir('gitcred-hidden')
  try {
    const help = runCli(home, ['--help'])
    expect(help.code, '`--help` 以非 0 退出 ⇒ 用户只是想看用法，却被当成出错').toBe(0)
    expect(
      help.out,
      '把 git 内部协议用的隐藏子命令列进了用法 ⇒ 用户会去手敲它，' +
        '而它不是给人用的（既不提示、也不回话，看起来像卡住了）',
    ).not.toContain('__git-credential')

    // git 在存 / 删凭据时会调 `store` / `erase`。这两个必须是**彻底沉默**的成功：
    // 助手的任何一行输出都会落进 git 的 stderr，出现在用户的推送日志里。
    for (const operation of ['store', 'erase', 'unexpected', '']) {
      const result = runCli(home, ['__git-credential', operation])
      expect(
        result.code,
        `\`__git-credential ${operation}\` 以非 0 退出 ⇒ git 会把凭据助手的失败当成整次操作的失败，` +
          '一次推送就此中断，而原因与凭据毫无关系',
      ).toBe(0)
      expect(
        result.out,
        `\`__git-credential ${operation}\` 打印了东西 ⇒ 它会原样出现在 git 的输出里，` +
          '轻则刷屏、重则把凭据协议的字段泄进用户日志',
      ).toBe('')
    }

    expect(
      readdirSync(home),
      '隐藏子命令在 $AGENT_WORKFLOW_HOME 里留下了文件 ⇒ 它在每一次 git 操作里都会被调用若干次，' +
        '留一个字节就是留成千上万个',
    ).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 未覆盖 / 已发现缺陷
// ---------------------------------------------------------------------------
//
// ① **`db compact` 的回执里「freed」永远是 0**（`cli/dbCompact.ts:57`）。
//    `const after = statSync(dbPath).size` 读在 `finally { sqlite.close() }` **之前**，
//    而 WAL 模式下 VACUUM 的结果要到 close 触发的 checkpoint 才落回主库文件。
//    实测：21,602,304 → 3,137,536 字节（真的回收了 17.6 MiB），回执却打印
//    `file size: 20.6 MiB → 20.6 MiB (freed 0.0 MiB)`。运维读到「一个字节都没省」，
//    会以为这次停机白停了。上面的用例因此只断言磁盘上的真实结果 + 回执里正确的
//    那半行（`reported reclaimable` 与压缩前大小），不把错的那半锁进来。
//
// ② **`migrate`（OPS-012）/ `migration-report`（OPS-013）此前在发行二进制上一跑就挂**
//    —— 本文件第一轮起草时实测到，主干 f565b1cb7 已修，上面两条用例就是它的回归网。
//    留下原始判据以免复辟：`cli/migrate.ts` / `cli/migrationReport.ts` / `cli/backup.ts`
//    曾把 `Paths.migrationsDir` 直接交给 `openDb`，而 `util/paths.ts` 的它是
//    `resolve(import.meta.dirname, '..', '..', 'db', 'migrations')`——`bun build --compile`
//    把 `import.meta.dirname` 烤成 `/`（`embed.ts:22-27` 自己写着这句），于是那是一个
//    不存在的路径，三条命令一律 `Can't find meta/_journal.json file` + 退出码 1，
//    并且在失败前已经把一个 4096 字节的空 `db.sqlite` 留在盘上。同一个二进制的
//    `user` / `auth` 当时是对的——差的就是 `IS_EMBEDDED` → `extractMigrationsTo` 那一步。
//    进程内单测抓不到这一类：dev 下 `IS_EMBEDDED=false`，`Paths.migrationsDir` 是真路径。
//    现在这条前置由 `packages/backend/tests/cli-embedded-migrations.test.ts` 守着。
//
// ③ **OPS-007（stop 超时 / 强杀时以非零退出码诚实上报「不是优雅停机」）仍然造得出
//    现场、收不到结果**，与 `rfc319-cli-lifecycle.spec.ts` 末尾记的是同一堵墙，这里
//    只补一句复核结论：`main.ts:78-86` 调 `stopCommand()` 不传任何 options，CLI 也
//    没有 `--timeout` 旋钮，等待预算固定 30s（`cli/stop.ts:79`）；而 e2e 允许的子进程
//    边界只有 `e2e/command.ts` 的 15s 硬超时，15s 到点子进程被打死，拿到的是
//    harness 的行为不是产品的契约。`forced` 那一档 `cli/stop.ts:95` 明写
//    `platform === 'win32'`，而 `@nightly` 这一档只在 ubuntu 上跑
//    （`.github/workflows/e2e-full-nightly.yml`，ci.yml 的 windows 腿带
//    `AW_E2E_TIER_EXCLUDE='@nightly'`）。放宽 `runCommandResult` 的超时会撞上
//    `root-test-entrypoint.test.ts` 里「`timeout: COMMAND_TIMEOUT_MS` 恰好出现 3 次」
//    的守卫，属于跨文件改动，留给后续 RFC 连同产品侧的 `stop --timeout` 一起处置。
