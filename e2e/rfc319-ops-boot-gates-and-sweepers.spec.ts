// RFC-319 —— 启动闸门与小时级后台任务
// (OPS-026/027/028/029/030/039/040/041/042/043)。
//
// 这一批用例和 `rfc319-cli-lifecycle.spec.ts` 一样跑**编译出来的二进制**，理由也一样：
// 这十条能力的使用者是站在机器前面的运维，他手上只有 `agent-workflow` 一个文件、一个
// `$AGENT_WORKFLOW_HOME` 目录，和 systemd 收到的那个退出码。进程内调用函数只能证明
// 「那个函数存在」，证明不了**发行出去的二进制**在库坏掉 / git 太老 / 迁移被改写时
// 会不会照样开门，也证明不了那些「一小时才跑一次」的清理到底跑没跑。
//
// 两类判据，两种做法：
//
//   ① **启动闸门**（OPS-027/028/029/030）——价值全在「拒绝」那一半。每条都断言
//      非零退出码 **加上** stderr 里点名了具体原因（库路径 + quick_check 文案 +
//      可用备份清单 + restore 命令 / 被改写的那条迁移的 tag / 实测 git 版本与地板
//      版本）。只断言「起不来」等于把一句 `process.exit(1)` 也判绿。
//
//   ② **后台清理**（OPS-039/040/041/042/043）——周期是 1 小时，**绝不能靠等**。
//      本文件不等任何一个小时级周期拍，只用产品自己提供的三种可触发入口：
//        * **boot 首拍**：事件归档器与终态任务 sweeper 都在 `T0 + 30s` 额外跑一次
//          （`services/daemonCadence.ts` 的 `MAINTENANCE_BOOT_FIRST_PASS_DELAY_MS`，
//          它存在的理由正是「重启比周期还频繁的部署一次都不会归档」）；
//        * **boot 同步拍**：备份保留期修剪在 `startBackupScheduler` 里是**开机同步**
//          执行的（`services/backupScheduler.ts:195` `safePrune('boot prune')`），
//          所以 daemon 打印 ready 时它已经跑完，一拍都不用等；
//          崩溃归档续跑（`recoverInterruptedArchives`）同理在 boot 早期触发；
//        * **1Hz**：资源限额巡检本来就是每秒一拍（`DAEMON_CADENCE.resourceLimits`）。
//      唯一一条真的要等的是 worktree GC（OPS-040）：它既没有 boot 首拍也没有手动入口，
//      首个周期拍落在 `T0 + MAINTENANCE_PHASE.worktreeGc` = 4 分钟。这条的代价写在
//      它自己的注释里，其余九条都在秒级完成。
//
// 判据全部取自源码：
//   * 库损坏拒绝文案 → `packages/backend/src/cli/start.ts:222-251`；
//     损坏判定 → `packages/backend/src/db/client.ts:180-199`。
//   * schema 漂移拒绝文案 → `packages/backend/src/cli/start.ts:254-279`；
//     两个 stage 的判据 → `packages/backend/src/db/schemaAdmission.ts:169-227`
//     （迁移收据链）与 `:314-360`（物理 schema 重放比对）。
//   * git 地板 → `packages/backend/src/services/gitVersion.ts:68-85`，
//     闸门 → `packages/backend/src/cli/start.ts:397-410`。
//   * pre-migration 原始备份 → `packages/backend/src/services/backupScheduler.ts:313-330`
//     与 `services/rawDbSnapshot.ts:95-190`（字节拷贝，不是逻辑导出）。
//   * boot auto-resume → `packages/backend/src/cli/start.ts:1488-1526`
//     与 `services/autoResume.ts`。
//   * 1Hz 限额 → `packages/backend/src/services/limits.ts:31-143`。
//   * 事件归档 + 读回 → `services/eventsArchive.ts:97-224/320-344`
//     与 `services/task.ts:6380-6420`（归档段在前、库内段在后拼成一条流）。
//   * worktree GC → `services/gc.ts:329-441`。
//   * 终态任务归档 → `services/taskArchive.ts:354-488/525-564`。
//   * 备份保留 → `services/backupScheduler.ts:54-135`。
//
// **平台**：本文件全部用例带 `@nightly`，而 nightly 全量腿只跑 ubuntu
// （`.github/workflows/e2e-full-nightly.yml` 的 `runs-on: ubuntu-latest`），PR 腿
// 用 `--grep-invert '@nightly'` 把它们排除在外。OPS-029 的 git 垫片因此写成
// `#!/bin/sh`——它只需要在 POSIX 上可执行，不需要为一条永远不会在 Windows 上跑的
// 用例去造 `.cmd` 分支。

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { expect, test } from '@playwright/test'

import { initGitRepo, repoRemoteUrl, runCommandResult, runSqlite, querySqlite } from './command'
import { defaultBinaryPath, startDaemon } from './harness'

// 一个 daemon 冷启动 ~4s；最重的几条要起三次 daemon 再加一次 30s 的 boot 首拍，
// 都远超配置里 90s 的默认预算。每条用例在**自己体内**显式声明预算而不是在文件作用域
// 调一次：文件作用域那种写法把「这条为什么要跑这么久」和用例本身拆开了，改动其中一条
// 时看不见另一处，而超时红出来的形态（`Test timeout exceeded`）又完全掩盖真正的断言。
const OPS_TEST_TIMEOUT_MS = 240_000

const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// 通用夹具
// ---------------------------------------------------------------------------

function freshHome(tag: string): string {
  return mkdtempSync(join(tmpdir(), `aw-rfc319-ops-${tag}-`))
}

/**
 * 删掉一个临时目录。**best-effort 且带重试**：这些 home 里躺着刚被停掉的 daemon 留下的
 * git worktree，macOS 上一个刚退出的子进程仍可能短暂握着目录项，`rmSync` 于是以
 * ENOTEMPTY 抛出——那是清理的噪音，不是被测行为，让它把一条全绿的用例判红毫无价值
 * （`e2e/crash-recovery.spec.ts` 出于同样的理由把它的清理包在 try 里）。
 */
function bestEffortRemove(dir: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      /* 下一轮重试；三次都失败就把目录留给操作系统的临时目录清理 */
    }
  }
}

function databasePath(home: string): string {
  return join(home, 'db.sqlite')
}

function backupsDir(home: string): string {
  return join(home, 'backups')
}

function taskArchiveDir(home: string): string {
  return join(home, 'archive', 'tasks')
}

/**
 * 跑发行二进制的一个子命令。
 *
 * 走 `e2e/command.ts` 的受限边界而不是在 spec 里自己起进程：所有 e2e 子进程都必须带上
 * 那份硬超时，否则一个挂住的探针会把整个 shard 卡死；`root-test-entrypoint.test.ts` 对
 * 每份 spec 源码做**纯子串检查**来强制这条（连注释里提到被禁的字面量都会把守卫打红，
 * 所以这里只描述规则、不复述那几个词）。
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

/**
 * 一个「已经被真实启动过一次」的 home：库迁到最新、管理员已建、token 已生成。
 *
 * 闸门类用例必须从这样的现场出发——在一个空目录上把库弄坏是伪造不出来的，产品在那种
 * 情况下本来就该建一个新库。
 */
async function readyHome(
  tag: string,
  configOverrides: Record<string, unknown> = {},
): Promise<string> {
  const home = freshHome(tag)
  const daemon = await startDaemon({ home, configOverrides })
  await daemon.stop()
  return home
}

/** 直接对着二进制跑一次 `start`。闸门在绑端口之前就会拒绝，所以端口给什么都行。 */
function attemptStart(home: string, extraEnv: Record<string, string> = {}) {
  return runCli(home, ['start', '--host', '127.0.0.1', '--port', '0'], extraEnv)
}

/**
 * 把库的第 2..6 页填成 0xFF：文件头与第 1 页（schema 页）留着，所以 `new Database()`
 * 与建连时那几条 PRAGMA 都能过，损坏只有在 `PRAGMA quick_check` 那一档才现形——
 * 这正是 RFC-213 那道闸门要守的位置（`db/client.ts:180-199` 的注释写明了这两条路径
 * 的分工）。顺手删掉 -wal/-shm，否则 SQLite 打开时会用 WAL 里的旧帧把损坏页盖回去。
 */
function corruptDatabasePages(home: string): void {
  const path = databasePath(home)
  for (const sidecar of ['-wal', '-shm']) rmSync(`${path}${sidecar}`, { force: true })
  const bytes = readFileSync(path)
  // 文件头偏移 16 的两字节是页大小；SQLite 用 1 表示 65536。
  const declared = bytes.readUInt16BE(16)
  const pageSize = declared === 1 ? 65_536 : declared
  expect(
    bytes.length,
    `前提不成立：库只有 ${bytes.length} 字节，装不下 6 个 ${pageSize} 字节的页`,
  ).toBeGreaterThan(pageSize * 6)
  bytes.fill(0xff, pageSize, pageSize * 6)
  writeFileSync(path, bytes)
}

/**
 * 把一个已迁移的库改造成「落后于当前二进制」的形态：删掉全部 schema 对象、清空迁移
 * 收据，只留下 `__drizzle_migrations` 这张空表。
 *
 * 为什么这样造而不是「删掉最后一条收据」：删尾会让 `migrate()` 重放最后那条迁移，
 * 而它是不是幂等取决于当天最新那个文件写了什么——用例会随下一次有人加迁移而随机红。
 * 清空收据 + 清空对象则与迁移链的具体内容无关：`assertMigrationHistory` 的
 * preflight 允许「收据是期望链的前缀」（空集是合法前缀），`migrate()` 于是从零重放
 * 全链，与全新安装走同一条路。产品判「要不要做 pre-migration 备份」的条件
 * （`backupScheduler.ts:318-320`：库里最新收据的 created_at < 二进制 journal 的
 * maxWhen）在这个现场上成立，而它成立的**原因**与真实升级完全一致。
 */
function rewindDatabaseBehindBinary(home: string): void {
  const path = databasePath(home)
  for (const sidecar of ['-wal', '-shm']) rmSync(`${path}${sidecar}`, { force: true })
  const objects = querySqlite<{ type: string; name: string }>(
    path,
    `SELECT type, name FROM sqlite_master
      WHERE type IN ('table','view')
        AND name NOT LIKE 'sqlite_%'
        AND name <> '__drizzle_migrations';`,
  )
  expect(
    objects.length,
    '前提不成立：这个 home 的库里一张表都没有 —— 说明它根本没被真实启动过',
  ).toBeGreaterThan(50)
  const statements = ['PRAGMA foreign_keys = OFF;']
  for (const object of objects) {
    statements.push(`DROP ${object.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS "${object.name}";`)
  }
  statements.push('DELETE FROM __drizzle_migrations;')
  runSqlite(path, statements.join('\n'))
}

function tarballsIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.tar.gz'))
    .sort()
}

function countTables(dbFile: string): number {
  return (
    querySqlite<{ n: number }>(
      dbFile,
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table';",
    )[0]?.n ?? -1
  )
}

interface AuthedDaemon {
  readonly baseUrl: string
  readonly token: string
}

async function apiJson<T>(daemon: AuthedDaemon, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  expect(response.status, `GET ${path} 返回了 ${response.status}`).toBe(200)
  return (await response.json()) as T
}

async function apiStatus(daemon: AuthedDaemon, path: string): Promise<number> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  return response.status
}

interface RecoveryEventRow {
  readonly kind: string
  readonly reason: string | null
}

async function recoveryEventKinds(
  daemon: AuthedDaemon,
  taskId: string,
): Promise<RecoveryEventRow[]> {
  const body = await apiJson<{ events: RecoveryEventRow[] }>(
    daemon,
    `/api/tasks/${taskId}/recovery-events`,
  )
  return body.events
}

/** 直接往库里放一行任务。用 SQL 而不是走启动流程是刻意的：这些用例问的是「后台清理
 *  认不认这一行」，不是任务生命周期本身（那由 task-lifecycle-* 系列覆盖）。 */
function seedTaskRow(
  home: string,
  row: {
    id: string
    status: string
    worktreePath?: string
    spaceKind?: string
    finishedAt?: number | null
    startedAt?: number
    parentTaskId?: string | null
    maxDurationMs?: number | null
    maxTotalTokens?: number | null
    runningMs?: number
  },
): void {
  const nullable = (value: number | null | undefined): string =>
    value === null || value === undefined ? 'NULL' : String(value)
  runSqlite(
    databasePath(home),
    `INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
       base_branch, branch, status, inputs, started_at, running_ms, finished_at,
       parent_task_id, space_kind, repo_count, max_duration_ms, max_total_tokens)
     VALUES ('${row.id}', '${row.id}', 'rfc319-ops-wf',
       '{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}',
       '${join(home, 'fixture-repo')}', '${row.worktreePath ?? ''}',
       'main', 'agent-workflow/${row.id}', '${row.status}', '{}',
       ${row.startedAt ?? Date.now() - DAY_MS}, ${row.runningMs ?? 0},
       ${nullable(row.finishedAt)},
       ${row.parentTaskId === undefined || row.parentTaskId === null ? 'NULL' : `'${row.parentTaskId}'`},
       '${row.spaceKind ?? 'remote'}', 1,
       ${nullable(row.maxDurationMs)}, ${nullable(row.maxTotalTokens)});`,
  )
}

function seedNodeRun(
  home: string,
  row: { id: string; taskId: string; status?: string; tokTotal?: number | null },
): void {
  runSqlite(
    databasePath(home),
    `INSERT INTO node_runs (id, task_id, node_id, status, tok_total)
     VALUES ('${row.id}', '${row.taskId}', 'rfc319-node', '${row.status ?? 'done'}',
       ${row.tokTotal === undefined || row.tokTotal === null ? 'NULL' : String(row.tokTotal)});`,
  )
}

// ---------------------------------------------------------------------------
// OPS-027 —— 启动闸门：DB 损坏
// ---------------------------------------------------------------------------

test('RFC-319 OPS-027: 数据库损坏时拒绝服务，并把库路径、quick_check 原因、可用备份与 restore 命令一并交到运维手上 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  // `backupOnMigration:false` 是为了让这条用例只观察**恢复指引**本身：开着的话，损坏
  // 库的 `readDbMigrationIdentity` 读不出收据 ⇒ 产品判它「落后于二进制」，于是每次失败
  // 启动都会现做一份 pre-migration 备份并把它排进「最新」——那份备份的内容正是这个坏掉
  // 的库。关掉它，清单里就只剩用户自己那份健康备份，这才是这条用例要证明的东西。
  const withoutBackups = await readyHome('corrupt-bare', { backupOnMigration: false })
  const withBackup = freshHome('corrupt-backed')
  try {
    // 备份走 `POST /api/backup`（设置页「导出备份」按的就是它），**不是** `agent-workflow
    // backup` 子命令——后者在发行的单二进制里是坏的：`cli/backup.ts:16` 直接用
    // `Paths.migrationsDir`（开发树里的相对路径）而没有像 `cli/start.ts:346-361` 那样在
    // `IS_EMBEDDED` 时先把内嵌迁移解出来，于是它必定以 `Can't find meta/_journal.json file`
    // 收场。这条已实测（见本次交付的缺陷回报），本用例因此绕开它取备份。
    const backupDaemon = await startDaemon({
      home: withBackup,
      configOverrides: { backupOnMigration: false },
    })
    try {
      const made = await fetch(`${backupDaemon.baseUrl}/api/backup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${backupDaemon.token}` },
      })
      expect(made.ok, `前提不成立：POST /api/backup 失败 ${made.status}`).toBe(true)
    } finally {
      await backupDaemon.stop()
    }
    const healthyBackups = tarballsIn(backupsDir(withBackup))
    expect(healthyBackups.length, '前提不成立：备份没有落下任何 tar.gz').toBe(1)
    const healthyBackupPath = join(backupsDir(withBackup), healthyBackups[0]!)

    corruptDatabasePages(withoutBackups)
    corruptDatabasePages(withBackup)

    // ── ① 没有任何备份可用时：仍然必须拒绝，并说清「去哪儿找备份、找到了怎么用」。
    const bare = attemptStart(withoutBackups)
    expect(
      bare.code,
      '库已经损坏，daemon 却以 0 退出 ⇒ systemd 认为启动成功，而实际上没有任何进程在服务；' +
        '更糟的是如果它没退出而是继续跑，用户会在一个已损坏的库上继续写',
    ).not.toBe(0)
    expect(
      bare.out,
      '拒绝时没有明说是「数据库损坏」⇒ 用户会往端口 / 权限 / 二进制损坏这些方向排查，' +
        '而唯一的正解是恢复备份',
    ).toContain('database corruption detected — refusing to start')
    expect(
      bare.out,
      '拒绝时不报出是哪个库文件 ⇒ 一台跑着多个 $AGENT_WORKFLOW_HOME 的机器上，' +
        '用户不知道该抢救哪一个',
    ).toContain(`db:          ${databasePath(withoutBackups)}`)
    expect(
      bare.out,
      '拒绝时不带 quick_check 的原始判词 ⇒ 「为什么说我坏了」无从复核，' +
        '用户没法自己拿 sqlite3 去印证',
    ).toMatch(/quick_check:\s+\S/)
    expect(
      bare.out,
      '没有备份时不说清「我在哪儿找过」⇒ 用户不知道该把手上的 tar.gz 放到哪个目录，' +
        '也不知道是不是自己放错了地方',
    ).toContain(`No backups found under ${backupsDir(withoutBackups)}`)
    expect(
      bare.out,
      '没有备份时不给出「备份在别处该怎么用」⇒ 指引在最需要它的那一档断掉了',
    ).toContain('If you have a backup tarball elsewhere: agent-workflow restore <tarball>')
    expect(
      bare.out,
      '不给出那条「明知不安全但我就是要看一眼数据」的逃生口 ⇒ 取证 / 手工抢救没有入口，' +
        '用户只能去翻源码',
    ).toContain('AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK=1')

    // ── ② 有备份可用时：清单必须是**真实存在的文件**，restore 命令必须能照抄照跑。
    const backed = attemptStart(withBackup)
    expect(backed.code, '同上：损坏库上的启动必须以非 0 收场').not.toBe(0)
    expect(
      backed.out,
      '磁盘上明明有备份，拒绝信息却只字不提 ⇒ 用户手边就有解药却被告知「没有备份」',
    ).toContain('Available backups (newest first):')
    expect(
      backed.out,
      '备份清单里没有列出刚刚生成的那份 ⇒ 清单不是从 backups/ 真读出来的',
    ).toContain(healthyBackupPath)
    expect(
      backed.out,
      '没有给出可以直接粘回终端的 restore 命令 ⇒ 用户还要自己去猜子命令与参数顺序',
    ).toContain(`Recover with: agent-workflow restore ${healthyBackupPath}`)
    expect(
      existsSync(healthyBackupPath),
      '拒绝信息推荐的那份备份在磁盘上并不存在 ⇒ 指引指向了一个死路径',
    ).toBe(true)
    expect(
      backed.out,
      '有备份的那一档仍然打印「没有备份」⇒ 两个分支被混为一谈，指引与现场对不上',
    ).not.toContain('No backups found under')
  } finally {
    bestEffortRemove(withoutBackups)
    bestEffortRemove(withBackup)
  }
})

// ---------------------------------------------------------------------------
// OPS-028 —— 启动闸门：schema 漂移 / 被改写的历史迁移
// ---------------------------------------------------------------------------

test('RFC-319 OPS-028: 被改写的历史迁移与凭空多出的表都让启动止步，且各自点名是哪一条 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = await readyHome('drift')
  try {
    // 先记下这个库当前认下的第一条迁移收据。改写它 = 「有人回头改了一个已经应用过的
    // 迁移文件」——drizzle 自己只看最新那条时间戳，完全看不见这种改动，RFC-275 的
    // preflight 正是为它而建。
    const firstReceipt = querySqlite<{ hash: string }>(
      databasePath(home),
      'SELECT hash FROM __drizzle_migrations ORDER BY created_at ASC LIMIT 1;',
    )[0]
    expect(firstReceipt?.hash, '前提不成立：库里没有任何迁移收据').toMatch(/^[0-9a-f]{64}$/)
    const originalHash = firstReceipt!.hash

    // 注意 `__drizzle_migrations.id` 在 SQLite 上**全是 NULL**（drizzle 建表时写的是
    // `SERIAL PRIMARY KEY`，不是 INTEGER PRIMARY KEY，因而不是 rowid 别名），所以按 id
    // 定位会静默匹配不到任何行、篡改变成空操作、用例假绿。按 created_at 定位。
    runSqlite(
      databasePath(home),
      `UPDATE __drizzle_migrations
         SET hash = '${'0'.repeat(64)}'
       WHERE created_at = (SELECT MIN(created_at) FROM __drizzle_migrations);`,
    )

    const rewritten = attemptStart(home)
    expect(
      rewritten.code,
      '历史迁移被改写过，daemon 却照常启动 ⇒ 「库里的表结构」与「二进制以为的表结构」' +
        '已经是两回事，之后每一条 SQL 都在赌运气，而且错会在很久以后才以数据形态暴露',
    ).not.toBe(0)
    expect(
      rewritten.out,
      '拒绝时没有明说是 schema 漂移 ⇒ 用户会以为是库坏了并去做一次不必要的 restore',
    ).toContain('database schema drift detected — refusing to start')
    expect(
      rewritten.out,
      '没有说清是在哪一档发现的 ⇒ 「收据链对不上」和「物理表结构对不上」需要的处置不同',
    ).toContain('stage: migration-history-preflight')
    expect(
      rewritten.out,
      '没有点名是哪一条迁移被改写 ⇒ 用户面对两百多个迁移文件，无从下手',
    ).toMatch(/migration 0000_\S+ hash differs \(0{12} != [0-9a-f]{12}\)/)
    expect(
      rewritten.out,
      '拒绝之后不给下一步 ⇒ 用户知道「有漂移」却不知道该恢复备份、重建库还是补一条正向迁移',
    ).toContain('Do not edit __drizzle_migrations or rewrite an already-applied migration.')

    // 复原收据，改造成另一种漂移：库里凭空多出一张二进制根本不知道的表。
    // 这一档由 `assertPhysicalSchema` 的**全链重放比对**兜住，收据链此时完全正确。
    runSqlite(
      databasePath(home),
      `UPDATE __drizzle_migrations
         SET hash = '${originalHash}'
       WHERE created_at = (SELECT MIN(created_at) FROM __drizzle_migrations);`,
    )
    runSqlite(databasePath(home), 'CREATE TABLE rfc319_ops_drift_probe (x TEXT);')

    const extraTable = attemptStart(home)
    expect(
      extraTable.code,
      '物理表结构与迁移链重放出来的结果不一致，daemon 却照常启动 ⇒ 那正是「有人手工动过库」' +
        '的现场，而它恰恰是最需要在开门前被拦下的一种',
    ).not.toBe(0)
    expect(
      extraTable.out,
      '物理 schema 漂移没有被单独标出 stage ⇒ 与收据链漂移混为一谈，处置方向会走偏',
    ).toContain('stage: physical-schema')
    expect(
      extraTable.out,
      '没有点名多出来的是哪个对象 ⇒ 用户拿不到可以直接去 DROP 的名字',
    ).toContain('unexpected table rfc319_ops_drift_probe')

    // 把手工痕迹擦掉之后必须能重新起来：闸门是一道可通过的门，不是一次性的砖墙。
    runSqlite(databasePath(home), 'DROP TABLE rfc319_ops_drift_probe;')
    const healed = await startDaemon({ home })
    try {
      expect(
        await apiStatus(healed, '/health'),
        '把手工加的表删掉之后仍然起不来 ⇒ 用户按拒绝信息做了正确的处置，却被永久挡在门外',
      ).toBe(200)
    } finally {
      await healed.stop()
    }
  } finally {
    bestEffortRemove(home)
  }
})

// ---------------------------------------------------------------------------
// OPS-029 —— 启动闸门：git 版本地板
// ---------------------------------------------------------------------------

/** PATH 上第一个真实的 git。垫片只接管 `--version`，其余一律转交给它。 */
function resolveRealGit(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'git')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('rfc319-ops: PATH 上找不到 git —— e2e 环境本身不成立')
}

test('RFC-319 OPS-029: git 低于 2.38 时拒绝启动，并把实测版本与地板版本一起说出来 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = await readyHome('gitfloor')
  const shimDir = join(home, 'rfc319-git-shim')
  try {
    // 产品探测 git 的方式是 `Bun.spawn({ cmd: ['git', …] })`（`util/git.ts:170`），
    // 也就是**走 PATH**。所以把一个假 git 排在 PATH 最前面就能压低它读到的版本，
    // 不需要改产品一行代码。垫片只对 `--version` 撒谎（判据要扫遍 argv：产品那条
    // 探测命令被 `hardenGitArgs` 塞进了一长串 `-c k=v`，`--version` 落在最后）。
    mkdirSync(shimDir, { recursive: true })
    const shim = join(shimDir, 'git')
    writeFileSync(
      shim,
      [
        '#!/bin/sh',
        'for a in "$@"; do',
        '  if [ "$a" = "--version" ]; then',
        '    echo "git version 2.30.0"',
        '    exit 0',
        '  fi',
        'done',
        `exec ${resolveRealGit()} "$@"`,
        '',
      ].join('\n'),
    )
    chmodSync(shim, 0o755)

    const refused = attemptStart(home, { PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}` })
    expect(
      refused.code,
      'git 老到跑不了 `merge-tree --write-tree`，daemon 却照常启动 ⇒ 界面一切正常，' +
        '而每一个任务都会在 agent 已经跑完之后死在 merge-back 上，' +
        '用户付了模型的钱却拿不到结果，报错还是一句看不懂的 git usage',
    ).not.toBe(0)
    expect(refused.out, '拒绝时不点名地板版本 ⇒ 用户不知道要升到哪一版才算够').toContain(
      'git >= 2.38.0 is required',
    )
    expect(
      refused.out,
      '拒绝时不回显实测到的版本 ⇒ 一台装了多个 git 的机器上，用户无法判断 daemon 到底' +
        '解析到了哪一个（而这正是最常见的成因）',
    ).toContain('found: git version 2.30.0')
    expect(
      refused.out,
      '不说清「升级之后还得让 daemon 的 PATH 解析到新的那个」⇒ 用户 brew 升级完再启动，' +
        '撞上同一条报错，第二次就会怀疑是产品坏了',
    ).toContain("the daemon's PATH must resolve the upgraded binary")

    // 反向对照：同一个 home、同一条命令，只把垫片从 PATH 上摘掉就必须能起来。
    // 没有这一半，上面那些断言对「daemon 根本起不来」也同样成立。
    const withRealGit = await startDaemon({ home })
    try {
      expect(
        await apiStatus(withRealGit, '/health'),
        '摘掉假 git 之后仍然起不来 ⇒ 上面那次拒绝根本不是 git 版本闸门的功劳',
      ).toBe(200)
    } finally {
      await withRealGit.stop()
    }
  } finally {
    bestEffortRemove(home)
  }
})

// ---------------------------------------------------------------------------
// OPS-030 —— 升级启动前的 pre-migration 原始备份
// ---------------------------------------------------------------------------

test('RFC-319 OPS-030: 库落后于二进制时先做一份 pre-migration 原始备份，且 backupOnMigration=false 时确实不做 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const enabled = await readyHome('premig-on', { backupOnMigration: true })
  const optedOut = await readyHome('premig-off', { backupOnMigration: false })
  const extractDir = freshHome('premig-extract')
  try {
    rewindDatabaseBehindBinary(enabled)
    rewindDatabaseBehindBinary(optedOut)
    expect(
      tarballsIn(backupsDir(enabled)).length,
      '前提不成立：这个 home 在启动前就已经有备份了',
    ).toBe(0)

    // ── ① 默认（开着）：迁移跑起来之前先落一份原始字节副本。
    //     旋钮每次启动都要显式带上：harness 每次 `startDaemon` 都会重写 config.json，
    //     不带就会退回 schema 默认值（true），于是「opt-out」那一半会静默地测了个寂寞。
    const upgraded = await startDaemon({
      home: enabled,
      configOverrides: { backupOnMigration: true },
    })
    try {
      expect(
        await apiStatus(upgraded, '/health'),
        '落后的库没能被迁上来 ⇒ 这条用例的前置（一次真实的「升级启动」）就不成立',
      ).toBe(200)
    } finally {
      await upgraded.stop()
    }
    const written = tarballsIn(backupsDir(enabled)).filter((n) => n.startsWith('pre-migration-'))
    expect(
      written.length,
      '有待应用的迁移，却没有留下任何 pre-migration 备份 ⇒ 一次迁移写坏了库就没有回头路，' +
        '而这正是升级最危险的那一刻',
    ).toBe(1)

    // 「原始」不是形容词：备份里的库必须还是**迁移前**那个样子。如果它是迁移**之后**
    // 才拷的（或者干脆是逻辑导出），那这份备份回滚不了任何东西——它和现在的库一样新。
    const tarball = join(backupsDir(enabled), written[0]!)
    const extract = runCommandResult('tar', ['-xzf', tarball, '-C', extractDir])
    expect(extract.status, `前提不成立：解不开备份包\n${extract.output}`).toBe(0)
    const backedUpDb = join(extractDir, 'db.sqlite')
    expect(
      existsSync(backedUpDb),
      '备份包里没有 db.sqlite ⇒ 它备份的不是库，回滚时什么都拿不回来',
    ).toBe(true)
    const backedUpTables = countTables(backedUpDb)
    const liveTables = countTables(databasePath(enabled))
    expect(liveTables, '前提不成立：这次启动之后库里仍然没有表，说明迁移根本没跑').toBeGreaterThan(
      50,
    )
    expect(
      backedUpTables,
      `备份里的库有 ${backedUpTables} 张表、迁移后的库有 ${liveTables} 张 ⇒ ` +
        '两者一样新，说明这份「pre-migration」备份是在迁移之后才拷的，回滚回来仍然是坏的那一版',
    ).toBeLessThan(liveTables)
    const manifest = JSON.parse(readFileSync(join(extractDir, 'manifest.json'), 'utf8')) as {
      kind?: string
    }
    expect(
      manifest.kind,
      '备份清单没有把自己标成 pre-migration ⇒ 保留策略的家族划分、以及事后翻找「升级前那一份」' +
        '都会认错对象',
    ).toBe('pre-migration')

    // ── ② 显式 opt-out：同样的现场，一份备份都不许留。
    const withoutBackup = await startDaemon({
      home: optedOut,
      configOverrides: { backupOnMigration: false },
    })
    try {
      expect(
        await apiStatus(withoutBackup, '/health'),
        '关掉 backupOnMigration 之后连迁移都不做了 ⇒ 这个开关的语义被扩大成了「别升级」',
      ).toBe(200)
    } finally {
      await withoutBackup.stop()
    }
    expect(
      countTables(databasePath(optedOut)),
      'opt-out 的那一次没有把库迁上来 ⇒ 开关只该管备份，不该管迁移',
    ).toBeGreaterThan(50)
    expect(
      tarballsIn(backupsDir(optedOut)),
      'backupOnMigration=false 却仍然写了备份 ⇒ 这个开关是摆设；' +
        '对磁盘紧张 / 自己有外部备份体系的部署来说，每次升级都会凭空多出一份几百 MB 的包',
    ).toEqual([])
  } finally {
    bestEffortRemove(enabled)
    bestEffortRemove(optedOut)
    bestEffortRemove(extractDir)
  }
})

// ---------------------------------------------------------------------------
// OPS-026 —— 启动时自动 resume 上一代 interrupted 任务
// ---------------------------------------------------------------------------

/**
 * 两个 daemon 用**同一个观察窗口**：关着的那次必须在整段窗口里一步不动，开着的那次
 * 必须在同一段窗口内离开 interrupted。同窗对照才让「没动」这个断言有意义——否则
 * 「关着时没动」对一个坏掉的、永远都不会动的产品同样成立。
 */
const AUTO_RESUME_OBSERVATION_MS = 20_000

async function taskStatus(daemon: AuthedDaemon, taskId: string): Promise<string> {
  const body = await apiJson<{ status: string }>(daemon, `/api/tasks/${taskId}`)
  return body.status
}

test('RFC-319 OPS-026: autoResumeOnBoot 开着才自动续跑上一代 interrupted 任务，关着就原地不动 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const repoDir = freshHome('resume-repo')
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 ops auto-resume fixture\n', 'utf-8')
  initGitRepo(repoDir)

  // 慢 stub：任务在 daemon 被打死时还留在 running，boot 回收才有东西可收。
  const crashed = await startDaemon({
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '20000' },
  })
  const home = crashed.home
  try {
    const headers = { Authorization: `Bearer ${crashed.token}`, 'Content-Type': 'application/json' }
    const agentResponse = await fetch(`${crashed.baseUrl}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'rfc319-ops-auto-resume',
        description: 'rfc319 ops auto-resume fixture',
        outputs: ['answer'],
        readonly: true,
        bodyMd: '',
      }),
    })
    expect(agentResponse.ok, `前提不成立：建代理失败 ${agentResponse.status}`).toBe(true)
    const agent = (await agentResponse.json()) as { id: string }

    const workflowResponse = await fetch(`${crashed.baseUrl}/api/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'rfc319-ops-auto-resume-wf',
        description: 'rfc319 ops auto-resume fixture',
        definition: {
          $schema_version: 1,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'agent_1',
              kind: 'agent-single',
              agentId: agent.id,
              agentName: 'rfc319-ops-auto-resume',
              promptTemplate: '{{topic}}',
              position: { x: 320, y: 0 },
            },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
              position: { x: 640, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e1',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'agent_1', portName: 'topic' },
            },
            {
              id: 'e2',
              source: { nodeId: 'agent_1', portName: 'answer' },
              target: { nodeId: 'out_1', portName: 'answer' },
            },
          ],
        },
      }),
    })
    expect(workflowResponse.ok, `前提不成立：建工作流失败 ${workflowResponse.status}`).toBe(true)
    const workflow = (await workflowResponse.json()) as { id: string }

    const launch = await fetch(`${crashed.baseUrl}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflowId: workflow.id,
        name: 'rfc319-ops-auto-resume-task',
        inputs: { topic: 'rfc319-ops' },
        repoUrl: repoRemoteUrl(repoDir),
        ref: 'main',
      }),
    })
    // 响应体只能读一次：把它先读成文本，再解析。写成
    // `expect(ok, \`… ${await res.text()}\`)` 会在**每一次**（包括成功时）就把 body 消费掉，
    // 随后的 `res.json()` 抛 "Body is unusable"，而那条报错与被测行为毫无关系。
    const launchBody = await launch.text()
    expect(launch.ok, `前提不成立：启动任务失败 ${launch.status} ${launchBody}`).toBe(true)
    const taskId = (JSON.parse(launchBody) as { id: string }).id

    await expect.poll(() => taskStatus(crashed, taskId), { timeout: 30_000 }).toBe('running')
    // task.status 会在 isolation-create 外部副作用结算前先变成 running；若此时 SIGKILL，
    // boot 恢复必须把 outcome-unknown 留给人确认，根本不属于 auto-resume 的安全窗口。
    // 等真实 runtime 子进程与 PID 都已落库，才是在测 daemon 崩溃后的自动续跑。
    await expect
      .poll(
        async () => {
          const body = await apiJson<{
            runs: Array<{ nodeId: string; status: string; pid: number | null }>
          }>(crashed, `/api/tasks/${taskId}/node-runs`)
          return body.runs.some(
            (run) => run.nodeId === 'agent_1' && run.status === 'running' && run.pid !== null,
          )
        },
        {
          timeout: 30_000,
          message: '前提不成立：agent runtime 子进程没有进入带 PID 的 running 状态',
        },
      )
      .toBe(true)
    await crashed.killChild('SIGKILL')

    // ── ① autoResumeOnBoot 关着（产品默认）：boot 回收把它标成 interrupted，然后就该
    //      停在那儿等人。整段观察窗口内不许有任何移动，也不许留下 auto-resume 审计。
    const withoutAutoResume = await startDaemon({
      home,
      stubMode: 'slow',
      extraEnv: { STUB_OPENCODE_SLEEP_MS: '0' },
      configOverrides: { autoResumeOnBoot: false },
    })
    try {
      expect(
        await taskStatus(withoutAutoResume, taskId),
        '前提不成立：daemon 被打死重启后，上一代在跑的任务没有被回收成 interrupted',
      ).toBe('interrupted')
      const deadline = Date.now() + AUTO_RESUME_OBSERVATION_MS
      while (Date.now() < deadline) {
        expect(
          await taskStatus(withoutAutoResume, taskId),
          'autoResumeOnBoot 关着，任务却自己动了 ⇒ 这个开关是摆设；对刻意把「崩溃后要不要' +
            '自动重跑」留给人判断的部署（重跑要花钱、会重复推代码）来说，这是不请自来的副作用',
        ).toBe('interrupted')
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(
        (await recoveryEventKinds(withoutAutoResume, taskId)).map((e) => e.kind),
        'autoResumeOnBoot 关着却写了自动恢复审计 ⇒ 恢复台账里出现了从未发生过的动作',
      ).not.toContain('auto-resume')
    } finally {
      await withoutAutoResume.stop()
    }

    // ── ② autoResumeOnBoot 开着：同样的窗口预算内必须自己动起来，并跑到终态。
    const withAutoResume = await startDaemon({
      home,
      stubMode: 'slow',
      extraEnv: { STUB_OPENCODE_SLEEP_MS: '0' },
      configOverrides: { autoResumeOnBoot: true },
    })
    try {
      await expect
        .poll(() => taskStatus(withAutoResume, taskId), {
          timeout: AUTO_RESUME_OBSERVATION_MS,
          message:
            'autoResumeOnBoot 开着，任务却仍然停在 interrupted ⇒ 「daemon 重启后自动续跑」' +
            '这条闭环没有闭上，用户重启一次服务就要手工把每一个被打断的任务点一遍',
        })
        .not.toBe('interrupted')
      await expect
        .poll(() => taskStatus(withAutoResume, taskId), {
          timeout: 60_000,
          message: '自动续跑起来了却没跑到 done ⇒ 续跑只是把状态推离 interrupted 的空动作',
        })
        .toBe('done')

      const events = await recoveryEventKinds(withAutoResume, taskId)
      const autoResume = events.filter((e) => e.kind === 'auto-resume')
      expect(
        autoResume.length,
        '自动续跑没有在恢复台账里留下任何一行 ⇒ 事后复盘时「这个任务是谁推动的、什么时候」' +
          '无从回答，而自动动作恰恰是最需要留痕的那一类',
      ).toBeGreaterThanOrEqual(1)
      expect(
        autoResume.map((e) => e.reason),
        '恢复审计没有把归因写成 autoResumeOnBoot ⇒ 分不清是开机自动续跑还是人点的 Resume',
      ).toContain('autoResumeOnBoot')
    } finally {
      await withAutoResume.stop()
    }
  } finally {
    bestEffortRemove(home)
    bestEffortRemove(repoDir)
  }
})

// ---------------------------------------------------------------------------
// OPS-041 —— 资源限额 1Hz 巡检
// ---------------------------------------------------------------------------

test('RFC-319 OPS-041: 1Hz 巡检把超时与超 token 的任务各自取消，并留下可归因的原因与恢复审计 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = freshHome('limits')
  const daemon = await startDaemon({ home })
  try {
    const overTime = '01RFC319OPS041TIME00000'
    const overTokens = '01RFC319OPS041TOKEN0000'
    const untouched = '01RFC319OPS041NOLIMIT00'

    // ① 累计运行时长早已超过上限（RFC-207：算的是 running_ms，不是创建至今的墙钟）。
    seedTaskRow(home, {
      id: overTime,
      status: 'running',
      maxDurationMs: 1_000,
      runningMs: 3_600_000,
    })
    // ② 时长没上限，但 token 用量超了。
    seedTaskRow(home, { id: overTokens, status: 'running', maxTotalTokens: 100 })
    seedNodeRun(home, {
      id: '01RFC319OPS041RUN000000',
      taskId: overTokens,
      status: 'running',
      tokTotal: 5_000,
    })
    // ③ 对照：同样在跑，但两条上限都没配 —— 一次都不许被碰。
    seedTaskRow(home, { id: untouched, status: 'running' })

    for (const [taskId, summary, needle] of [
      [overTime, 'task-time-limit-exceeded', 'exceeding configured limit 1000ms'],
      [overTokens, 'task-token-limit-exceeded', 'exceeding configured limit 100'],
    ] as const) {
      await expect
        .poll(() => taskStatus(daemon, taskId), {
          timeout: 30_000,
          message:
            `超过上限的任务没有被 1Hz 巡检取消（${summary}）⇒ 上限配置是摆设：` +
            '一个卡死的任务会一直占着并发额度，一个失控的循环会一直烧 token，' +
            '而用户以为自己设了保险丝',
        })
        .toBe('canceled')
      const detail = await apiJson<{ errorSummary: string | null; errorMessage: string | null }>(
        daemon,
        `/api/tasks/${taskId}`,
      )
      expect(
        detail.errorSummary,
        '被限额取消的任务对外只说「已取消」⇒ 用户在界面上看不出是自己撞了上限还是别人点了取消，' +
          '于是既不会去调上限，也不会去查任务为什么跑不完',
      ).toBe(summary)
      expect(
        detail.errorMessage,
        '取消原因里没有写清实际用量与配置上限 ⇒ 用户不知道该把上限调到多少才够',
      ).toContain(needle)
      expect(
        (await recoveryEventKinds(daemon, taskId)).map((e) => e.kind),
        '限额取消没有进恢复台账 ⇒ 「这台机器上有多少任务是被限额掐掉的」这条线索不存在，' +
          '一个配小了的上限会长期静默地杀任务而没人发现',
      ).toContain('limit-cancel')
    }

    expect(
      await taskStatus(daemon, untouched),
      '没有配置任何上限的任务也被巡检取消了 ⇒ 巡检不是在执行限额，是在杀任务',
    ).toBe('running')
  } finally {
    await daemon.stop()
    bestEffortRemove(home)
  }
})

// ---------------------------------------------------------------------------
// OPS-039 —— 事件归档（events → JSONL）与归档后读回
// ---------------------------------------------------------------------------

interface NodeRunEventsResponse {
  readonly events: Array<{ id: number; kind: string; payload: { marker?: string } }>
}

test('RFC-319 OPS-039: 超阈值的节点事件被归档成 JSONL 并从库里删除，而事件接口仍然一条不少地读回来 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = freshHome('eventsarchive')
  const taskId = '01RFC319OPS039TASK00000'
  const nodeRunId = '01RFC319OPS039RUN000000'
  const total = 12
  const keep = 3
  // 归档器的 boot 首拍在 T0+30s（MAINTENANCE_BOOT_FIRST_PASS_DELAY_MS）。这里
  // **不等周期拍**（那是一小时），只等这一拍，再留一倍余量。
  const daemon = await startDaemon({
    home,
    configOverrides: {
      // 字节水位置 0 = 只按行数判；否则有效阈值是「行数阈值」与「字节折算行数」取 min，
      // 而后者有 1000 行的下限，会把这条用例的小阈值顶掉。
      eventsArchiveThresholds: {
        perNodeRunRows: keep,
        globalRows: 1_000_000,
        perNodeRunBytes: 0,
        globalBytes: 0,
      },
    },
  })
  try {
    seedTaskRow(home, { id: taskId, status: 'done', finishedAt: Date.now() })
    seedNodeRun(home, { id: nodeRunId, taskId })
    const values: string[] = []
    for (let i = 1; i <= total; i += 1) {
      values.push(`('${nodeRunId}', ${Date.now() + i}, 'text', '{"marker":"rfc319-ops-039-${i}"}')`)
    }
    runSqlite(
      databasePath(home),
      `INSERT INTO node_run_events (node_run_id, ts, kind, payload) VALUES ${values.join(',')};`,
    )

    const expectedMarkers = Array.from({ length: total }, (_, i) => `rfc319-ops-039-${i + 1}`)
    const readEvents = async (): Promise<string[]> => {
      const body = await apiJson<NodeRunEventsResponse>(
        daemon,
        `/api/tasks/${taskId}/node-runs/${nodeRunId}/events?limit=1000`,
      )
      return body.events.map((e) => e.payload.marker ?? '<no-marker>')
    }
    expect(await readEvents(), '前提不成立：刚种进去的事件在归档之前就读不全').toEqual(
      expectedMarkers,
    )

    const jsonl = join(home, 'logs', taskId, `${nodeRunId}.jsonl`)
    await expect
      .poll(() => existsSync(jsonl), {
        timeout: 90_000,
        message:
          '事件行数早已超过 per-node 水位，归档器却没有在 boot 首拍写出任何 JSONL ⇒ ' +
          '事件表只增不减。生产实测过它长到 78 万行 / 1.7GB，之后每一次列表查询都在' +
          '同一条同步连接上拖住整站',
      })
      .toBe(true)

    await expect
      .poll(
        () =>
          querySqlite<{ n: number }>(
            databasePath(home),
            'SELECT count(*) AS n FROM node_run_events WHERE node_run_id = ?;',
            [nodeRunId],
          )[0]?.n ?? -1,
        {
          timeout: 30_000,
          message:
            '归档写了文件却没有把行从库里删掉 ⇒ 归档变成了「同一份数据存两遍」，' +
            '库该多大还是多大，磁盘反而更紧',
        },
      )
      .toBe(keep)

    // 归档文件里必须是**被删掉的那几条**，而不是随手抓的几行。
    const archivedMarkers = readFileSync(jsonl, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as { payload: string }).payload)
      .map((payload) => (JSON.parse(payload) as { marker: string }).marker)
    expect(
      archivedMarkers,
      '落盘的不是最旧的那一批 ⇒ 归档挑错了行，读回来的顺序与内容都会错位',
    ).toEqual(expectedMarkers.slice(0, total - keep))

    // 这才是这条能力的重点：用户视角**看不出**发生过归档。
    expect(
      await readEvents(),
      '归档之后事件接口读不回被归档的那几条 ⇒ 「归档」在用户眼里等于「日志被吃了」；' +
        '而这条接口正是任务详情页每次展开节点都要走的那条路',
    ).toEqual(expectedMarkers)
  } finally {
    await daemon.stop()
    bestEffortRemove(home)
  }
})

// ---------------------------------------------------------------------------
// OPS-042 —— 终态任务自动归档 sweeper（boot 首拍 + 崩溃续跑）
// ---------------------------------------------------------------------------

interface ArchiveManifest {
  readonly rootTaskId: string
  readonly taskIds: string[]
  readonly rows: Record<string, number>
}

test('RFC-319 OPS-042: 终态任务树在 boot 首拍被归档出库，且崩在半路的 .tmp- 残留按库里还有没有行各走各的收尾 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  const home = freshHome('taskarchive')
  const oldRoot = '01RFC319OPS042ROOT00000'
  const oldChild = '01RFC319OPS042CHILD0000'
  const recent = '01RFC319OPS042RECENT000'
  const now = Date.now()

  const sweeping = await startDaemon({
    home,
    configOverrides: {
      taskArchive: { enabled: true, retentionDays: 30, maxTreesPerSweep: 50 },
    },
  })
  try {
    // 一棵整树都超期的树（root + 一个后代），和一棵刚结束的树做对照。
    seedTaskRow(home, { id: oldRoot, status: 'done', finishedAt: now - 90 * DAY_MS })
    seedTaskRow(home, {
      id: oldChild,
      status: 'done',
      finishedAt: now - 89 * DAY_MS,
      parentTaskId: oldRoot,
    })
    seedNodeRun(home, { id: '01RFC319OPS042RUN000000', taskId: oldChild })
    seedTaskRow(home, { id: recent, status: 'done', finishedAt: now - DAY_MS })

    expect(
      await apiStatus(sweeping, `/api/tasks/${oldRoot}`),
      '前提不成立：刚种下的任务在归档之前就已经读不到了',
    ).toBe(200)

    const manifestPath = join(taskArchiveDir(home), oldRoot, 'manifest.json')
    await expect
      .poll(() => existsSync(manifestPath), {
        timeout: 90_000,
        message:
          '整树终态且早已超过保留期的任务，在 boot 首拍没有被归档出库 ⇒ 「终态任务超期出库」' +
          '这条体积封顶的执行者形同虚设，任务表与它的事件行只增不减',
      })
      .toBe(true)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ArchiveManifest
    expect(
      manifest.taskIds.slice().sort(),
      '归档的单位不是整棵树 ⇒ 后代任务被留在库里指向一个已经不存在的父任务，' + '详情页从此打不开',
    ).toEqual([oldRoot, oldChild].sort())
    expect(
      manifest.rows.tasks,
      '清单里记的任务行数与实际不符 ⇒ 事后核对「归档有没有截断」失去依据',
    ).toBe(2)
    expect(
      existsSync(join(taskArchiveDir(home), oldRoot, 'db', 'node_runs.jsonl')),
      '归档目录里没有 node_runs ⇒ 执行事实随删库一起消失，归档只剩一个空壳',
    ).toBe(true)

    await expect
      .poll(() => apiStatus(sweeping, `/api/tasks/${oldRoot}`), {
        timeout: 30_000,
        message:
          '归档已经落盘，任务却还留在库里能被读到 ⇒ 「归档 == 从库删除」的语义没兑现，' +
          '库不会变小',
      })
      .toBe(404)
    expect(
      await apiStatus(sweeping, `/api/tasks/${oldChild}`),
      '后代任务没有随树一起从库里删掉 ⇒ 半棵树留在库里，且它的父任务已经不存在',
    ).toBe(404)
    expect(
      await apiStatus(sweeping, `/api/tasks/${recent}`),
      '还在保留期内的任务也被卷走了 ⇒ 这是不可逆删除，用户昨天刚跑完的任务今天就没了',
    ).toBe(200)

    const audit = querySqlite<{ source: string; tree_count: number; task_count: number }>(
      databasePath(home),
      'SELECT source, tree_count, task_count FROM task_archive_audit;',
    )
    expect(
      audit.map((row) => row.source),
      'hourly sweeper 归档了数据却没有写审计行 ⇒ 「谁在什么时候删掉了哪些任务」无从追溯，' +
        '而被记录的任务行本身已经不在库里了',
    ).toEqual(['sweep'])
    expect(audit[0]?.task_count, '审计行记的任务数与实际归档的对不上').toBe(2)
  } finally {
    await sweeping.stop()
  }

  // ── 崩溃续跑：归档是「先落盘 → rename → 才删库」，崩在中间会留下 `.tmp-<rootId>`。
  //    库里行还在 ⇒ 上次没走到删库那步，tmp 是半成品，丢弃重来；
  //    库里行已经没了 ⇒ 是 rename 之后崩的，tmp 就是那份正式产物，提升它。
  //    两种收尾的判据完全相反，任何一边搞错都会造成「库删了、盘上没有」的静默丢数据。
  const promoted = '01RFC319OPS042PROMOTED0'
  const discarded = '01RFC319OPS042DISCARD00'
  try {
    for (const [id, marker] of [
      [promoted, 'rfc319-ops-042-promoted'],
      [discarded, 'rfc319-ops-042-discarded'],
    ] as const) {
      const tmpDir = join(taskArchiveDir(home), `.tmp-${id}`)
      mkdirSync(join(tmpDir, 'db'), { recursive: true })
      writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify({ rootTaskId: id, marker }))
    }
    // 只有 `discarded` 在库里还有行。
    seedTaskRow(home, { id: discarded, status: 'done', finishedAt: now - DAY_MS })

    const recovering = await startDaemon({
      home,
      // 归档 sweeper 本身关掉：这一段要验的是**崩溃续跑**，不是又一次归档。关掉它
      // 也顺带证明续跑不受开关影响——半截状态必须无条件收尾。
      configOverrides: { taskArchive: { enabled: false, retentionDays: 30, maxTreesPerSweep: 50 } },
    })
    try {
      await expect
        .poll(() => existsSync(join(taskArchiveDir(home), promoted, 'manifest.json')), {
          timeout: 30_000,
          message:
            '库里已经没有这行任务、盘上只剩 `.tmp-` 半截目录，boot 却没有把它提升为正式归档 ⇒ ' +
            '这份归档永远不会被任何人找到，而它是那些任务仅存的副本',
        })
        .toBe(true)
      expect(
        existsSync(join(taskArchiveDir(home), `.tmp-${promoted}`)),
        '提升之后 `.tmp-` 目录还留在原地 ⇒ 同一份归档在盘上存了两份，下一次 boot 还会再收一次',
      ).toBe(false)

      await expect
        .poll(() => existsSync(join(taskArchiveDir(home), `.tmp-${discarded}`)), {
          timeout: 30_000,
          message:
            '库里的任务行还在（说明上次归档没走到删库那一步），`.tmp-` 半成品却没有被丢弃 ⇒ ' +
            '一份可能被截断的导出会一直躺在归档目录里，日后被当成正式产物',
        })
        .toBe(false)
      expect(
        existsSync(join(taskArchiveDir(home), discarded)),
        '一份还没走完的半成品被提升成了正式归档 ⇒ 归档目录里出现了内容不完整的树，' +
          '而它对应的任务还好端端地在库里',
      ).toBe(false)
      expect(
        await apiStatus(recovering, `/api/tasks/${discarded}`),
        '崩溃续跑顺手把库里的任务行删了 ⇒ 续跑只该收尾磁盘上的半截状态，不该动数据',
      ).toBe(200)
    } finally {
      await recovering.stop()
    }
  } finally {
    bestEffortRemove(home)
  }
})

// ---------------------------------------------------------------------------
// OPS-043 —— 自动备份调度与保留策略
// ---------------------------------------------------------------------------

/** 造一份「看起来像备份」的文件：保留策略只看文件名家族、mtime 与大小。 */
function plantBackup(dir: string, name: string, ageMs: number, sizeBytes = 64): void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, 'x'.repeat(sizeBytes))
  const seconds = (Date.now() - ageMs) / 1000
  utimesSync(path, seconds, seconds)
}

test('RFC-319 OPS-043: 备份按份数与天数裁剪、受保护家族按家族各自轮换，且到点自动产出一份新备份 @nightly', async () => {
  test.setTimeout(OPS_TEST_TIMEOUT_MS)
  // `readyHome` 的初始化 daemon 也会跑 durable boot catch-up。让它占用 daily slot，
  // 后面真正被测的默认 hourly daemon 就不会因初始化进程在高负载下延迟退出而被同槽去重。
  const home = await readyHome('backups', {
    maintenanceSchedule: { kind: 'daily', at: '00:00', timezone: 'UTC' },
  })
  const dir = backupsDir(home)
  try {
    // ── ① 份数 + 天数 + 受保护家族。RFC-338 把 boot prune 改为 ready 后 30s 的
    //     durable catch-up；等待真实产物收敛，不能在 ready 时读取旧目录。
    rmSync(dir, { recursive: true, force: true })
    plantBackup(dir, 'scheduled-newest.tar.gz', 10 * 60_000)
    plantBackup(dir, 'scheduled-second.tar.gz', 20 * 60_000)
    plantBackup(dir, 'auto-stale.tar.gz', 3 * DAY_MS)
    plantBackup(dir, 'scheduled-ancient.tar.gz', 4 * DAY_MS)
    plantBackup(dir, 'agent-workflow-manual-1.tar.gz', 60_000)
    plantBackup(dir, 'agent-workflow-manual-2.tar.gz', 2 * 60_000)
    plantBackup(dir, 'agent-workflow-manual-3.tar.gz', 3 * 60_000)
    plantBackup(dir, 'pre-restore-old.tar.gz', 5 * DAY_MS)
    plantBackup(dir, 'pre-restore-fs-old.tar.gz', 5 * DAY_MS)

    const pruning = await startDaemon({
      home,
      configOverrides: {
        backupIntervalMs: 0,
        backupRetentionCount: 2,
        backupRetentionDays: 1,
        backupMaxTotalBytes: 0,
        backupProtectedKeepCount: 2,
        backupOnMigration: false,
      },
    })
    try {
      const countAndAgeSurvivors = [
        'agent-workflow-manual-1.tar.gz',
        'agent-workflow-manual-2.tar.gz',
        'pre-restore-fs-old.tar.gz',
        'pre-restore-old.tar.gz',
        'scheduled-newest.tar.gz',
        'scheduled-second.tar.gz',
      ]
      await expect
        .poll(() => tarballsIn(dir), {
          timeout: 120_000,
          intervals: [1_000],
          message:
            'boot catch-up 的修剪结果与保留策略对不上。这一条同时锁四件事：①最新的 N 份留下；' +
            '②超过 N 份但仍在保留天数内的也留下；③两条都不满足的才删；' +
            '④手动 / pre-* 这些受保护家族**不受份数与天数约束**，只按各自家族的份数轮换 —— ' +
            '把最后一条弄丢的后果是用户唯一那份手动备份被一次例行修剪悄悄删掉',
        })
        .toEqual(countAndAgeSurvivors)
    } finally {
      await pruning.stop()
    }

    // ── ② 总体积上限：份数与天数都放宽到不生效，只让体积说话。
    // RFC-338 的 durable ledger 会把同一个 hourly job/slot 精确去重；这是一条
    // 独立策略腿，不能复用①已经完成的 slot 再期待它以新 payload 重跑。
    const cappingHome = await readyHome('backups-cap', {
      maintenanceSchedule: { kind: 'daily', at: '00:00', timezone: 'UTC' },
    })
    const cappingDir = backupsDir(cappingHome)
    rmSync(cappingDir, { recursive: true, force: true })
    plantBackup(cappingDir, 'scheduled-size-1.tar.gz', 60_000, 1_000)
    plantBackup(cappingDir, 'scheduled-size-2.tar.gz', 2 * 60_000, 1_000)
    plantBackup(cappingDir, 'scheduled-size-3.tar.gz', 3 * 60_000, 1_000)
    plantBackup(cappingDir, 'scheduled-size-4.tar.gz', 4 * 60_000, 1_000)
    plantBackup(cappingDir, 'agent-workflow-big.tar.gz', 5 * 60_000, 9_000)

    const capping = await startDaemon({
      home: cappingHome,
      configOverrides: {
        backupIntervalMs: 0,
        backupRetentionCount: 50,
        backupRetentionDays: 3_650,
        backupMaxTotalBytes: 2_500,
        backupProtectedKeepCount: 50,
        backupOnMigration: false,
      },
    })
    try {
      await expect
        .poll(() => tarballsIn(cappingDir), {
          timeout: 120_000,
          intervals: [1_000],
          message:
            '总体积上限没有生效（或把受保护的那份也算进去了）⇒ 一个大库的定时备份集会在两次' +
            '份数/天数修剪之间把磁盘吃满，而这正是 maxTotalBytes 存在的理由；' +
            '反过来把手动备份算进配额并删掉它，等于用一个体积旋钮销毁用户显式留下的副本',
        })
        .toEqual([
          'agent-workflow-big.tar.gz',
          'scheduled-size-1.tar.gz',
          'scheduled-size-2.tar.gz',
        ])
    } finally {
      await capping.stop()
      bestEffortRemove(cappingHome)
    }

    // ── ③ 调度本身：到点必须真的产出一份新备份，而不只是「有个定时器在转」。
    rmSync(dir, { recursive: true, force: true })
    const scheduling = await startDaemon({
      home,
      configOverrides: {
        backupIntervalMs: 3_000,
        backupRetentionCount: 50,
        backupRetentionDays: 3_650,
        backupMaxTotalBytes: 0,
        backupProtectedKeepCount: 50,
        backupOnMigration: false,
      },
    })
    try {
      await expect
        .poll(() => tarballsIn(dir).filter((name) => name.startsWith('scheduled-')).length, {
          timeout: 60_000,
          message:
            '配置了备份间隔，到点却没有产出任何 scheduled-* 备份 ⇒ 用户以为自己开了定时备份，' +
            '真出事那天才发现 backups/ 是空的',
        })
        .toBeGreaterThanOrEqual(1)
      const produced = tarballsIn(dir).filter((name) => name.startsWith('scheduled-'))
      expect(
        statSync(join(dir, produced[0]!)).size,
        '定时备份产出了一个空文件 ⇒ 有名无实，恢复时才发现里面什么都没有',
      ).toBeGreaterThan(0)
    } finally {
      await scheduling.stop()
    }
  } finally {
    bestEffortRemove(home)
  }
})

// ---------------------------------------------------------------------------
// OPS-040 —— worktree 自动 GC
// ---------------------------------------------------------------------------
//
// 这是本文件里**唯一**一条真的要等的用例。worktree GC 既没有 boot 首拍也没有任何手动
// 入口（`services/gc.ts:803-841` 只装了一个周期 ticker，`routes/` 下没有对应端点），
// 它的第一拍落在 `T0 + MAINTENANCE_PHASE.worktreeGc` = 4 分钟。所以这条用例的成本就是
// 四分钟——它只在 nightly 全量腿上跑，是可以承受的价格；而把它省掉的代价是「终态任务的
// 工作区永远不回收」这类事故（一棵 worktree 动辄几百 MB）没有任何端到端防护。
// 等待用 `expect.poll` 而不是固定 sleep，相位表将来被调小时用例会更快通过、不会假红。

test('RFC-319 OPS-040: 终态任务的旧工作区被小时级 GC 清掉，而未到龄的与还在跑的都不动 @nightly', async () => {
  test.setTimeout(420_000)
  const home = freshHome('worktreegc')
  // 夹具工作区刻意放在 home 之外：同一拍里还串跑着几段「扫 <home>/worktrees 找孤儿目录」
  // 的 GC，把夹具放进去会让这条用例分不清是哪一段删的。
  const spaces = freshHome('worktreegc-spaces')
  const stale = join(spaces, 'stale')
  const young = join(spaces, 'young')
  const active = join(spaces, 'active')
  const now = Date.now()

  const daemon = await startDaemon({
    home,
    configOverrides: { worktreeAutoGc: { enabled: true, olderThanDays: 1, onlyMerged: false } },
  })
  try {
    for (const dir of [stale, young, active]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'work.txt'), 'rfc319-ops-040\n')
    }
    // space_kind='scratch' 让回收走「整个目录就是这个任务的全部」那条最短路径
    // （无 linked worktree 注销、无快照 ref 清理），这条用例问的是 GC 的**判据**，
    // 不是 git 的拆解动作。
    seedTaskRow(home, {
      id: '01RFC319OPS040STALE0000',
      status: 'done',
      spaceKind: 'scratch',
      worktreePath: stale,
      finishedAt: now - 5 * DAY_MS,
    })
    seedTaskRow(home, {
      id: '01RFC319OPS040YOUNG0000',
      status: 'done',
      spaceKind: 'scratch',
      worktreePath: young,
      finishedAt: now - 60_000,
    })
    seedTaskRow(home, {
      id: '01RFC319OPS040ACTIVE000',
      status: 'running',
      spaceKind: 'scratch',
      worktreePath: active,
      finishedAt: null,
    })

    await expect
      .poll(() => existsSync(stale), {
        timeout: 330_000,
        intervals: [5_000],
        message:
          '终态且早已超过 olderThanDays 的任务，它的工作区在 GC 拍过之后还在盘上 ⇒ ' +
          '「worktree 自动回收」这条能力是空的：每个跑完的任务都会永久占着一份工作区，' +
          '一台长期运行的机器最终被自己的历史任务塞满磁盘',
      })
      .toBe(false)

    expect(
      existsSync(young),
      '刚结束一分钟的任务，工作区就被回收了 ⇒ olderThanDays 没生效。' +
        '用户正要打开任务详情看产物、或者准备手工把改动挑出来，目录已经没了',
    ).toBe(true)
    expect(
      existsSync(active),
      '还在跑的任务的工作区被 GC 删掉了 ⇒ 正在写文件的 agent 被抽走了脚下的地板，' +
        '这是数据丢失级别的后果',
    ).toBe(true)

    const rows = querySqlite<{ id: string; pruned: number | null }>(
      databasePath(home),
      'SELECT id, workspace_pruned_at AS pruned FROM tasks ORDER BY id;',
    )
    const prunedIds = rows.filter((row) => row.pruned !== null).map((row) => row.id)
    expect(
      prunedIds,
      '目录删了却没有在任务行上打墓碑（或给不该删的行打了墓碑）⇒ 之后任何一条复活路径' +
        '（resume / retry / 同步工作流）都会试图在一个已经不存在的目录上继续，' +
        '而不是干脆地告诉用户「工作区已回收」',
    ).toEqual(['01RFC319OPS040STALE0000'])
  } finally {
    await daemon.stop()
    bestEffortRemove(home)
    bestEffortRemove(spaces)
  }
})
