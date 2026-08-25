// RFC-319 —— 运维面 CLI 与守护进程生命周期（OPS-003/004/005/006/008/009/017/031）。
//
// 这一批用例跑的**不是浏览器**，是编译出来的那个二进制本身。理由很直接：这些能力
// 的唯一使用者是站在机器前面敲命令的人，他手上只有 `agent-workflow` 这一个文件。
// 用进程内函数调一遍只能证明「那个函数存在」，证明不了**发行出去的二进制**里有这
// 个子命令、退出码是几、话说得对不对——而运维脚本恰恰只看退出码和那几行字。
//
// 判据全部取自源码，不靠记忆：
//   * 顶层子命令调度 / `--port` `--host` 解析 / 未知子命令 → `packages/backend/src/main.ts:30-49`
//     （`readFlag` / `readPortFlag` 都以 `process.exit(2)` 收场）与
//     `packages/backend/src/main.ts:200-243`（help 正文与 `unknown subcommand`）。
//   * `stop` 的四种结局与各自的话 → `packages/backend/src/cli/stop.ts:46-118`；
//     退出码由 `packages/backend/src/main.ts:71-80` 决定（只有 timeout / forced 非零）。
//   * `status` 的三态与 running 那一档的排版 → `packages/backend/src/cli/status.ts:22-84`。
//   * 单实例锁的拒绝文案 → `packages/backend/src/cli/start.ts:322-329`；
//     锁文件本身（`.daemon.lock`，内容就是 PID）→ `packages/backend/src/util/lock.ts:47-95`
//     与 `packages/backend/src/util/paths.ts`（`Paths.lock` / `daemonInfo` / `controlFile`）。
//   * `/health` 的载荷字段 → `packages/backend/src/routes/health.ts:36-68`。
//
// **本文件没有覆盖 OPS-007（stop 超时 / 强杀时诚实上报非优雅停机）**，原因写在
// 文件末尾的「未覆盖」注释里——那是一个 e2e 侧的硬墙，不是忘了写。

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { runCommandResult, runSqlite } from './command'
import { defaultBinaryPath, startDaemon, type DaemonHandle } from './harness'

// 两次 daemon 冷启动（各 ~3s）+ 一次端口冲突启动 + 若干秒级 CLI 调用；
// 90s 的默认值对 OPS-031 这种「起—杀—再起」的用例太紧。
test.setTimeout(180_000)

/**
 * 一个**永远不可能是活进程**的 PID。
 *
 * macOS 的 pid 上限是 99998，Linux 的 `pid_max` 默认 4194304，都远小于这个数；
 * `isProcessAlive` 只把 EPERM 当作「存在但没权限」，其余异常一律判死
 * （`packages/backend/src/util/process.ts:39-52`）。所以造陈旧锁用它，
 * 而不是去 kill 一个真实进程——后者会在并发跑的机器上误伤别人。
 */
const DEAD_PID = 2_147_483_600

interface HealthPayload {
  readonly ok: boolean
  readonly opencodeVersion: string | null
  readonly dbVersion: number
  readonly uptime: number
  readonly runningTasks: number
  readonly recovery: Record<string, number>
  readonly identityAccess: {
    readonly accessUpdate: {
      readonly success: number
      readonly noOp: number
      readonly conflict: number
      readonly rejected: number
    }
    readonly authorityReresolution: number
    readonly invalidStoredGrant: number
    readonly wsTargetedRefreshFailure: number
  }
}

/**
 * 跑发行二进制的一个子命令。
 *
 * 走 `e2e/command.ts` 的受限边界而不是在 spec 里自己起进程：所有 e2e 子进程都必须
 * 带上那份硬超时，否则一个挂住的探针会把整个 shard 卡死；`root-test-entrypoint.test.ts`
 * 对每份 spec 源码做纯子串检查来强制这条（禁止出现 `child_process` / `execFileSync(`）。
 */
function runCli(home: string, args: string[]): { out: string; code: number } {
  const result = runCommandResult(defaultBinaryPath(), args, {
    env: { AGENT_WORKFLOW_HOME: home },
  })
  return { out: result.output, code: result.status }
}

function freshHome(tag: string): string {
  return mkdtempSync(join(tmpdir(), `aw-rfc319-cli-${tag}-`))
}

function lockPath(home: string): string {
  return join(home, '.daemon.lock')
}

function daemonInfoPath(home: string): string {
  return join(home, '.daemon.info')
}

function controlFilePath(home: string): string {
  return join(home, '.daemon.control')
}

function readLockPid(home: string): string {
  return readFileSync(lockPath(home), 'utf8').trim()
}

/** `status` 的 running 排版是「两空格 + 标签 + 冒号 + 对齐空格 + 值」，只取值。 */
function statusField(output: string, label: string): string {
  const matched = new RegExp(String.raw`^\s*${label}:\s+(.+?)\s*$`, 'm').exec(output)
  expect(
    matched,
    `\`status\` 输出里根本没有 \`${label}\` 这一行 —— 运维拿不到这项读数`,
  ).not.toBeNull()
  return matched?.[1] ?? ''
}

/** 造一整套「上一个 daemon 被断电带走」的现场：锁 + info + control 都指向死 PID。 */
function plantStaleDaemonFiles(home: string, pid: number): void {
  writeFileSync(lockPath(home), String(pid), 'utf8')
  writeFileSync(
    daemonInfoPath(home),
    JSON.stringify({
      pid,
      host: '127.0.0.1',
      port: 1,
      url: 'http://127.0.0.1:1/',
      startedAt: new Date(0).toISOString(),
    }),
    'utf8',
  )
  writeFileSync(
    controlFilePath(home),
    JSON.stringify({ url: 'http://127.0.0.1:1', nonce: 'rfc319-stale-nonce', pid }),
    'utf8',
  )
}

/**
 * 占住一个**由内核分配**的临时端口，并把它一直握在手里。
 *
 * 不写死端口号：e2e 默认 4 worker 并发，写死等于让并发跑互相打架，而那种红
 * 与被测行为毫无关系。`exclusive: true` 保证拿到的是独占监听。
 */
async function occupyLoopbackPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server: Server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : null
  if (port === null) throw new Error('rfc319-cli-lifecycle: 没能拿到一个临时端口')
  return {
    port,
    release: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)))
      }),
  }
}

async function readHealth(baseUrl: string): Promise<HealthPayload> {
  const response = await fetch(`${baseUrl}/health`)
  expect(response.status, `GET /health 返回了 ${response.status} —— 存活探针本身挂了`).toBe(200)
  return (await response.json()) as HealthPayload
}

// ---------------------------------------------------------------------------
// OPS-017 —— 顶层调度
// ---------------------------------------------------------------------------

test('RFC-319 OPS-017: version / help / 未知子命令各走各的出口，且打错字不留下任何状态 @nightly', async () => {
  const home = freshHome('dispatch')
  try {
    const version = runCli(home, ['version'])
    expect(
      version.code,
      '`version` 以非 0 退出 ⇒ 任何「先确认版本再动手」的运维脚本（升级、比对备份）第一步就断了',
    ).toBe(0)
    expect(
      version.out.trim(),
      '`version` 没有打印出可辨认的版本串 ⇒ 用户手上这个二进制到底是哪一版无从判断，' +
        '而恢复备份前正是要拿它跟备份里的版本对账',
    ).toMatch(/^agent-workflow \S+$/)

    // 四种「我想看看怎么用」的写法必须给出同一份说明书。任何一种漏掉，用户都会
    // 得到一个「什么都没发生」的空终端，并合理地以为二进制坏了。
    const helpForms = [['help'], ['--help'], ['-h'], []]
    const helpOutputs = helpForms.map((args) => runCli(home, args))
    for (const [index, help] of helpOutputs.entries()) {
      const label = helpForms[index]?.join(' ') || '(不带任何参数)'
      expect(
        help.code,
        `\`agent-workflow ${label}\` 以非 0 退出 ⇒ 用户只是想看用法，却被当成出错`,
      ).toBe(0)
      expect(
        help.out,
        `\`agent-workflow ${label}\` 没有打印用法 ⇒ 用户在终端里得不到任何指引，只能去翻文档或猜`,
      ).toContain('usage: agent-workflow <command> [options]')
      for (const subcommand of ['start', 'stop', 'status', 'doctor', 'backup', 'restore']) {
        expect(
          help.out,
          `用法里没有列出 \`${subcommand}\` ⇒ 这条命令对只看 --help 的用户等于不存在`,
        ).toContain(`  ${subcommand}`)
      }
    }
    expect(
      new Set(helpOutputs.map((help) => help.out)).size,
      '四种求助写法给出了不一样的说明书 ⇒ 用户按 `-h` 看到的命令表和按 `help` 看到的不一致，' +
        '会以为某个子命令是自己记错了',
    ).toBe(1)

    const unknown = runCli(home, ['strat'])
    expect(
      unknown.code,
      '打错的子命令以 0 退出 ⇒ `agent-workflow strat && echo ok` 会打印 ok，' +
        'CI / 开机脚本里一个拼写错误就此静默地什么都不做，而且看起来一切正常',
    ).toBe(2)
    expect(
      unknown.out,
      '没有把「不认识的是哪个词」说出来 ⇒ 用户面对一整屏用法说明，仍然不知道自己哪里敲错了',
    ).toContain('unknown subcommand: strat')
    expect(unknown.out, '拒绝时不顺便给出可用命令表 ⇒ 用户得再敲一次 `--help` 才能自救').toContain(
      'usage: agent-workflow <command> [options]',
    )
    expect(
      unknown.code,
      '打错子命令与正常求助用同一个退出码 ⇒ 脚本无法区分「用户想看帮助」和「命令写错了」',
    ).not.toBe(helpOutputs[0]?.code)

    expect(
      readdirSync(home),
      'version / help / 打错子命令这些只读动作居然在 $AGENT_WORKFLOW_HOME 里落了文件 ⇒ ' +
        '一次手滑就给机器留下了状态（数据库、锁文件），下一次真正启动要带着它跑',
    ).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-003 —— start 的非法 flag 值
// ---------------------------------------------------------------------------

test('RFC-319 OPS-003: start 的非法 flag 值以退出码 2 拒绝，且一个字节的状态都不落 @nightly', async () => {
  const home = freshHome('startflags')
  try {
    // 三类「值本身不合法」：不是数字 / 超出 0-65535 / 不是整数。
    for (const [raw, why] of [
      ['abc', '端口写成了单词'],
      ['70000', '端口超出 16 位'],
      ['-1', '端口为负'],
      ['1.5', '端口不是整数'],
    ] as const) {
      const rejected = runCli(home, ['start', '--host', '127.0.0.1', '--port', raw])
      expect(
        rejected.code,
        `${why}（--port ${raw}）却没有以退出码 2 拒绝 ⇒ systemd / 开机脚本分不清「配置写错了」` +
          '和「启动失败了」，于是对一个永远不可能成功的配置无限重启',
      ).toBe(2)
      expect(
        rejected.out,
        `${why}（--port ${raw}）的报错里没有回显用户实际写下的值 ⇒ 用户拿着一句泛泛的报错，` +
          '在一长串启动参数里找不到是哪一个写错了',
      ).toContain(`invalid --port value: ${raw}`)
    }

    // 两类「给了 flag 却没给值」：最容易发生在 shell 变量为空的时候
    // （`--port $PORT` 而 $PORT 未设置），此时后面的参数会被当成值吞掉。
    const portWithoutValue = runCli(home, ['start', '--port'])
    expect(
      portWithoutValue.code,
      '`--port` 后面缺值却不是退出码 2 ⇒ 一个未展开的 shell 变量会被当成正常启动，' +
        'daemon 绑到一个用户没打算用的端口上',
    ).toBe(2)
    expect(portWithoutValue.out, '缺值时没说清是哪个 flag 缺值 ⇒ 用户只能逐个删参数去试').toContain(
      '--port requires a value',
    )

    const hostWithoutValue = runCli(home, ['start', '--host'])
    expect(
      hostWithoutValue.code,
      '`--host` 后面缺值却不是退出码 2 ⇒ 同上；而 host 写错的后果更重——daemon 可能绑到 0.0.0.0，' +
        '把一台本该只听 loopback 的机器暴露到局域网',
    ).toBe(2)
    expect(hostWithoutValue.out, '缺值时没说清是哪个 flag 缺值 ⇒ 用户只能逐个删参数去试').toContain(
      '--host requires a value',
    )

    expect(
      readdirSync(home),
      '参数校验没通过却已经动了 $AGENT_WORKFLOW_HOME ⇒ 一次参数写错就在机器上建了库 / 留了锁，' +
        '用户以为「没启动起来所以什么都没发生」，实际下一次启动要背着这些残留',
    ).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-004 —— 单实例锁
// ---------------------------------------------------------------------------

test('RFC-319 OPS-004: 第二个 daemon 起不来，并报出正在占用的那个 PID 与锁文件路径 @nightly', async () => {
  const home = freshHome('singleton')
  const daemon: DaemonHandle = await startDaemon({ home })
  try {
    const livePid = readLockPid(home)
    expect(
      livePid,
      '在跑的 daemon 没有把自己的 PID 写进锁文件 ⇒ 后面所有「谁占着」的回答都无从谈起',
    ).toMatch(/^\d+$/)

    const second = runCli(home, ['start', '--host', '127.0.0.1', '--port', '0'])
    expect(
      second.code,
      '同一个 home 上第二个 daemon 居然启动成功 ⇒ 两个进程同时写同一个 SQLite 与同一批 worktree，' +
        '任务状态互相覆盖，这是数据损坏级别的后果',
    ).not.toBe(0)
    expect(
      second.out,
      '被拒时没有报出正在占用的 PID ⇒ 用户知道「起不来」却不知道该去看哪个进程，' +
        '最常见的下一步就是盲目 `pkill -f agent-workflow`，把在跑的任务一起带走',
    ).toContain(`another daemon is already running (PID ${livePid})`)
    expect(
      second.out,
      '被拒时没有报出锁文件路径 ⇒ 真的遇到陈旧锁时用户不知道要删哪个文件（它还是个隐藏文件）',
    ).toContain(`lock file: ${lockPath(home)}`)
    expect(second.out, '被拒时没有给出「如果它是陈旧的该怎么办」 ⇒ 用户在一条死路上停住').toContain(
      'if it is stale, remove the lock file manually and try again',
    )

    // 报出来的那个 PID 必须是真凶：与 `.daemon.info` 记的是同一个进程。
    const info = JSON.parse(readFileSync(daemonInfoPath(home), 'utf8')) as { pid: number }
    expect(
      String(info.pid),
      '拒绝信息里的 PID 与 daemon 自己登记的 PID 不是同一个 ⇒ 用户会按报错去 kill 一个无关进程',
    ).toBe(livePid)

    // 被拒的那次启动**不许**破坏在跑的这个实例：锁还在、健康探针照常回答。
    expect(
      existsSync(lockPath(home)),
      '一次被拒绝的启动把在跑实例的锁文件删掉了 ⇒ 单实例保护当场失效，下一次启动就能真的起第二个',
    ).toBe(true)
    const health = await readHealth(daemon.baseUrl)
    expect(
      health.ok,
      '被拒的那次启动把在跑的 daemon 弄坏了 ⇒ 用户只是手滑起了第二次，结果把正在服务的实例搞挂',
    ).toBe(true)
  } finally {
    await daemon.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-005 —— 绑定端口被占用
// ---------------------------------------------------------------------------

test('RFC-319 OPS-005: 端口被别人占着时启动失败要指名道姓说是哪个端口，且不会把这个 home 卡死 @nightly', async () => {
  const home = freshHome('portclash')
  // 先用 harness 正常起一次：这一步把 home 初始化好（管理员账号、库、token），
  // 后面「冲突之后还能不能起来」才有一个真正可登录的实例可验。
  const warmup: DaemonHandle = await startDaemon({ home })
  await warmup.stop()

  const occupied = await occupyLoopbackPort()
  let released = false
  let revived: DaemonHandle | null = null
  try {
    const clash = runCli(home, ['start', '--host', '127.0.0.1', '--port', String(occupied.port)])
    expect(
      clash.code,
      '端口被占着却以 0 退出 ⇒ `agent-workflow start` 在 systemd 里被记为启动成功，' +
        '而实际上没有任何进程在监听，用户直到访问不了页面才发现',
    ).not.toBe(0)
    expect(
      clash.out,
      '启动失败的反馈里没有出现那个端口号 ⇒ 用户面对一句泛泛的「起不来」，' +
        '既不知道是端口问题也不知道要去 `lsof` 哪个端口',
    ).toMatch(new RegExp(String.raw`port\s+${occupied.port}\b`, 'i'))
    expect(
      clash.out.toLowerCase(),
      '失败原因没有说成「被占用」 ⇒ 用户会往权限 / 防火墙 / 二进制损坏这些方向排查，绕远路',
    ).toContain('in use')
    expect(
      clash.out,
      '端口冲突时居然还打印了 ready 横幅 ⇒ 用户会拿着一个根本没人监听的 URL 去开浏览器',
    ).not.toContain('agent-workflow ready')

    await occupied.release()
    released = true

    // 冲突只该是一次失败，不该在这台机器上留下永久性伤害：换个空闲端口必须能起来。
    revived = await startDaemon({ home })
    const health = await readHealth(revived.baseUrl)
    expect(
      health.ok,
      '一次端口冲突之后，同一个 home 就再也起不来了 ⇒ 用户被一个临时的端口占用永久挡在门外，' +
        '而失败信息里从没提过要去清理什么',
    ).toBe(true)
  } finally {
    if (revived !== null) await revived.stop()
    if (!released) await occupied.release()
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-006 —— stop 优雅排空
// ---------------------------------------------------------------------------

test('RFC-319 OPS-006: stop 等到进程真的走完才报「已停」，并把锁 / info / control 三件套一起清干净 @nightly', async () => {
  const home = freshHome('stop')
  const daemon: DaemonHandle = await startDaemon({ home })
  try {
    // 前提：三件套都在。它们是 `status` / `stop` / Windows 上的控制通道各自的依据。
    for (const [path, why] of [
      [lockPath(home), '锁文件'],
      [daemonInfoPath(home), 'daemon.info'],
      [controlFilePath(home), 'control 文件'],
    ] as const) {
      expect(existsSync(path), `前提不成立：在跑的 daemon 没有写出${why}`).toBe(true)
    }
    const pid = readLockPid(home)
    const baseUrl = daemon.baseUrl

    const stopped = runCli(home, ['stop'])
    expect(
      stopped.code,
      '一次正常的停机以非 0 退出 ⇒ `agent-workflow stop && agent-workflow start` 这种重启脚本' +
        '会在第一步就中断，用户的服务停在「已停」上再也没起来',
    ).toBe(0)
    expect(
      stopped.out,
      '停机成功却没有回执 / 没有报出停的是哪个 PID ⇒ 一台跑着多个实例的机器上，' +
        '用户无法确认自己停的是不是想停的那个',
    ).toContain(`daemon (PID ${pid}) stopped`)

    // 「优雅」不是形容词，是可判定的：daemon 自己的日志里必须留下收到 SIGTERM 的排空记录，
    // 且没有走到「排空超时、把在跑的活动强行标记为 interrupted」那一步。
    const daemonLog = readFileSync(join(home, 'logs', 'daemon.log'), 'utf8')
    expect(
      daemonLog,
      'daemon 日志里没有排空记录 ⇒ 它是被打死的而不是被请走的，在跑的任务没有被停放，' +
        '下一次启动要把它们当作 interrupted 收尸',
    ).toContain('shutting down')
    expect(
      daemonLog,
      '一个空闲 daemon 的停机居然耗尽了排空预算 ⇒ 用户每次重启都要多等 30 秒，' +
        '并且拿到一堆本不该出现的 interrupted 任务',
    ).not.toContain('graceful budget exceeded')

    // 三件套必须一起消失。任何一个留下，下一次启动 / `status` 都会被它误导。
    for (const [path, why] of [
      [
        lockPath(home),
        '锁文件留在盘上 ⇒ 下一次启动要靠陈旧锁回收才能起来，`status` 先报一次假的「有实例在跑」',
      ],
      [daemonInfoPath(home), 'daemon.info 留在盘上 ⇒ `status` 会拿着一个已经没人监听的 URL 去探活'],
      [
        controlFilePath(home),
        'control 文件留在盘上 ⇒ 它带着 at-rest 的 shutdown nonce，一个已死实例的凭据继续躺在磁盘上',
      ],
    ] as const) {
      expect(existsSync(path), why).toBe(false)
    }

    // 端口必须真的还回去了：只删文件不退出的话，下一次启动会撞上 OPS-005 的端口冲突。
    let reachable = true
    try {
      await fetch(`${baseUrl}/health`)
    } catch {
      reachable = false
    }
    expect(
      reachable,
      '`stop` 说停了，端口却还有人监听 ⇒ 用户按回执认为可以重启 / 可以做 `db compact` 这类' +
        '「必须先停机」的操作，实际上进程还活着，两边同时写同一个库',
    ).toBe(false)
  } finally {
    await daemon.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-008 —— stop 的无锁 / 陈旧锁自愈
// ---------------------------------------------------------------------------

test('RFC-319 OPS-008: 没有锁与陈旧锁，stop 都要自愈成功而不是把人拦在门外 @nightly', async () => {
  const neverStarted = freshHome('stop-nolock')
  const stale = freshHome('stop-stale')
  try {
    const idle = runCli(neverStarted, ['stop'])
    expect(
      idle.code,
      '一台从没起过 daemon 的机器上 `stop` 以非 0 退出 ⇒ 所有 `stop && start` 形态的部署脚本' +
        '在全新机器上的第一次部署就会失败，而失败原因是「本来就没在跑」',
    ).toBe(0)
    expect(idle.out, '没在跑的时候不肯明说 ⇒ 用户分不清「已经停好了」和「命令没生效」').toContain(
      'no daemon lock found (not running)',
    )

    plantStaleDaemonFiles(stale, DEAD_PID)
    const healed = runCli(stale, ['stop'])
    expect(
      healed.code,
      '陈旧锁（断电 / OOM 之后留下的）让 `stop` 以非 0 退出 ⇒ 重启脚本卡死在第一步，' +
        '而用户唯一能做的是去删一个从没人告诉过他的隐藏文件',
    ).toBe(0)
    expect(
      healed.out,
      '清理陈旧锁时不说清「锁是陈旧的、已经删了」 ⇒ 用户会以为真的停掉了一个在跑的实例，' +
        '也就不会去追查上一次是怎么死的',
    ).toContain(`lock for PID ${DEAD_PID} was stale (process not alive); removed`)

    for (const [path, why] of [
      [lockPath(stale), '陈旧锁没被删掉 ⇒ 自愈只是嘴上说说，下一次 `start` 仍然要自己再走一遍回收'],
      [
        daemonInfoPath(stale),
        '陈旧的 daemon.info 没被删掉 ⇒ `status` 会继续拿这个死实例的 host/port 去探活并报出误导性的读数',
      ],
      [
        controlFilePath(stale),
        '陈旧的 control 文件没被删掉 ⇒ 一个已死实例的 shutdown nonce 继续留在磁盘上，' +
          '而 Windows 上的 `stop` 正是靠它来决定往哪里发停机请求',
      ],
    ] as const) {
      expect(existsSync(path), why).toBe(false)
    }
  } finally {
    rmSync(neverStarted, { recursive: true, force: true })
    rmSync(stale, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-009 —— status 三态
// ---------------------------------------------------------------------------

test('RFC-319 OPS-009: status 的三态各说各的话，running 那一档的读数与 /health 逐项对得上 @nightly', async () => {
  const notRunning = freshHome('status-off')
  const staleLock = freshHome('status-stale')
  const running = freshHome('status-on')
  let daemon: DaemonHandle | null = null
  try {
    // ① not-running
    const off = runCli(notRunning, ['status'])
    expect(
      off.code,
      '没在跑的时候 `status` 以 0 退出 ⇒ 监控脚本 `agent-workflow status || alert` 永远不会报警，' +
        '服务挂了没人知道',
    ).toBe(1)
    expect(off.out, '没在跑却不明说 ⇒ 人肉巡检看不出结论').toContain(
      'agent-workflow: daemon is not running',
    )

    // ② stale-lock：与 ① 同为「没在服务」，但**处置动作完全不同**，所以话必须不一样。
    plantStaleDaemonFiles(staleLock, DEAD_PID)
    const stale = runCli(staleLock, ['status'])
    expect(
      stale.code,
      '陈旧锁状态下 `status` 以 0 退出 ⇒ 监控认为一切正常，而实际上根本没有进程在服务',
    ).toBe(1)
    expect(
      stale.out,
      '陈旧锁没有被单独说出来 ⇒ 用户按「没在跑」去直接 start，撞上锁之后才发现，多绕一圈',
    ).toContain(`stale lock for dead PID ${DEAD_PID}`)
    expect(stale.out, '报出陈旧锁却不给下一步动作 ⇒ 用户知道有问题但不知道该敲什么').toContain(
      'run `agent-workflow stop` to clean it up',
    )
    expect(
      stale.out,
      '陈旧锁与「没在跑」说同一句话 ⇒ 两种需要不同处置的现场被混为一谈，' +
        '用户永远发现不了上一次是异常死亡',
    ).not.toBe(off.out)

    // ③ running：读数必须是真的，而不是排版好看的常量。
    daemon = await startDaemon({ home: running })
    const on = runCli(running, ['status'])
    expect(
      on.code,
      '在跑的时候 `status` 以非 0 退出 ⇒ 监控脚本会对一个健康的实例持续报警，' +
        '真正的告警被淹没在噪音里',
    ).toBe(0)
    expect(on.out, 'running 这一档没有明说 ⇒ 三态里最重要的一态反而看不出来').toContain(
      'agent-workflow: daemon running',
    )

    const health = await readHealth(daemon.baseUrl)
    expect(
      statusField(on.out, 'pid'),
      '`status` 报的 PID 与锁文件里的不是同一个 ⇒ 用户按它去 `kill` / 去 `ps` 查的是别的进程',
    ).toBe(readLockPid(running))
    expect(
      statusField(on.out, 'url'),
      '`status` 给的 URL 不是这个实例真正在监听的地址 ⇒ 用户照着它开浏览器打不开，' +
        '而这正是新用户找到界面的唯一入口',
    ).toBe(`${daemon.baseUrl}/`)
    expect(
      statusField(on.out, 'host:port'),
      '`status` 报的 host:port 与实际监听的不一致 ⇒ 排查连不上的问题时会被带偏到防火墙 / DNS 方向',
    ).toBe(daemon.baseUrl.replace(/^https?:\/\//, ''))
    expect(
      statusField(on.out, 'db version'),
      '`status` 的 db version 与 /health 读数对不上 ⇒ 升级前后判断迁移是否落地的两个入口互相矛盾，' +
        '用户不知道该信哪个',
    ).toBe(String(health.dbVersion))
    expect(
      statusField(on.out, 'tasks now'),
      '`status` 的在跑任务数与 /health 对不上 ⇒ 「现在能不能安全停机」这个判断失去依据',
    ).toBe(String(health.runningTasks))
    expect(
      statusField(on.out, 'opencode'),
      '`status` 的 opencode 行与 /health 的 opencodeVersion 不是一回事 ⇒ 用户以为运行时已就绪，' +
        '直到真的跑任务才发现没有',
    ).toBe(health.opencodeVersion ?? '(not checked at startup)')
    expect(
      Number(statusField(on.out, 'uptime').replace(/s$/, '')),
      '`status` 的 uptime 不是一个可读的秒数 ⇒ 「这个进程是不是刚刚崩溃重启过」无从判断',
    ).toBeGreaterThanOrEqual(0)
  } finally {
    if (daemon !== null) await daemon.stop()
    rmSync(notRunning, { recursive: true, force: true })
    rmSync(staleLock, { recursive: true, force: true })
    rmSync(running, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-031 —— GET /health
// ---------------------------------------------------------------------------

test('RFC-319 OPS-031: /health 不带凭据就能读，且每个读数都是活的 —— 在跑任务数 / 恢复计数 / 身份访问计数都跟着真实动作变 @nightly', async () => {
  const home = freshHome('health')
  const bootAt = Date.now()
  let daemon: DaemonHandle | null = await startDaemon({ home })
  let restarted: DaemonHandle | null = null
  try {
    const baseUrl = daemon.baseUrl

    // ── ① 公共存活探针：不带任何凭据就能读，而同一个 origin 上的业务端点必须仍然关着门。
    const anonymous = await fetch(`${baseUrl}/health`)
    expect(
      anonymous.status,
      '/health 需要凭据才能读 ⇒ 负载均衡 / systemd / docker 的探活都拿不到 200，' +
        '实例会被反复判定为不健康并重启',
    ).toBe(200)
    const guarded = await fetch(`${baseUrl}/api/users`)
    expect(
      guarded.status,
      '业务端点也变成免鉴权了 ⇒ /health 的公开不再是一个刻意的豁免口，而是整个鉴权塌了，' +
        '任何人都能读到用户列表',
    ).toBe(401)

    const first = (await anonymous.json()) as HealthPayload
    expect(
      first.ok,
      '/health 回的 ok 不为 true ⇒ 探活方拿到一个自称不健康的实例，直接把它摘掉',
    ).toBe(true)
    expect(
      Number.isInteger(first.dbVersion) && first.dbVersion > 0,
      'dbVersion 不是一个正整数 ⇒ 升级 / 恢复备份前「库在哪一版」这个判断没有依据',
    ).toBe(true)
    expect(
      Number.isInteger(first.uptime) && first.uptime >= 0,
      'uptime 不是一个非负整数秒 ⇒ 「进程是不是在反复崩溃重启」看不出来',
    ).toBe(true)
    expect(
      first.uptime,
      'uptime 大于这个进程真实存在的时间 ⇒ 它报的根本不是本进程的存活时长（毫秒当秒 / 时间戳当时长），' +
        '崩溃重启会被完全掩盖',
    ).toBeLessThanOrEqual(Math.ceil((Date.now() - bootAt) / 1000) + 5)
    expect(
      first.runningTasks,
      '刚起来、什么都没跑就报有任务在跑 ⇒ 「现在能不能安全停机 / 做 db compact」的判断永远是「不能」',
    ).toBe(0)
    expect(
      Object.keys(first.identityAccess.accessUpdate).sort(),
      'accessUpdate 的分档不再是 success/noOp/conflict/rejected 四档 ⇒ 已有的看板 / 告警规则' +
        '会读到 undefined 并静默失效',
    ).toEqual(['conflict', 'noOp', 'rejected', 'success'])
    expect(
      typeof first.recovery,
      'recovery 不是一个对象 ⇒ 「本次启动以来系统自动干了多少次修复」这条线整块不存在',
    ).toBe('object')

    // ── ② runningTasks 是活的：直接在库里放一行 running 任务，读数必须当场跟上。
    //      走库而不是走完整启动流程是刻意的——这条断言问的是「这个仪表读的是不是真实的行」，
    //      不是任务生命周期本身（那由 task-lifecycle-* 系列覆盖）。
    runSqlite(
      join(home, 'db.sqlite'),
      `INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
         base_branch, branch, status, inputs, started_at)
       VALUES ('01RFC319HEALTHGAUGE000000', 'rfc319-health-gauge', 'rfc319-wf', '{}',
         '${join(home, 'fake-repo')}', '${join(home, 'fake-worktree')}',
         'main', 'agent-workflow/rfc319-health-gauge', 'running', '{}', ${Date.now()});`,
    )
    const withTask = await readHealth(baseUrl)
    expect(
      withTask.runningTasks,
      'runningTasks 对一行真实存在的 running 任务无动于衷 ⇒ 这个读数是个装饰品，' +
        '用户据它决定「现在停机安全」，结果把在跑的任务拦腰砍断',
    ).toBe(first.runningTasks + 1)

    // ── ③ identityAccess 是活的：做一次真实的权限变更，成功档与 no-op 档必须各自 +1。
    const auth = { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' }
    const username = `rfc319-health-${Date.now().toString(36)}`
    const created = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role: 'user',
        password: 'Rfc319HealthPass!1',
      }),
    })
    expect(
      created.ok,
      `前提不成立：建用户失败 ${created.status} ${await created.clone().text()}`,
    ).toBe(true)
    const target = (await created.json()) as { id: string }

    const beforeUpdate = await readHealth(baseUrl)
    const promote = await fetch(`${baseUrl}/api/users/${target.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ role: 'admin' }),
    })
    expect(promote.ok, `前提不成立：提权失败 ${promote.status}`).toBe(true)
    const afterSuccess = await readHealth(baseUrl)
    expect(
      afterSuccess.identityAccess.accessUpdate.success,
      '一次真实生效的权限变更没有被计入 success ⇒ 「谁的权限被改过、改了多少次」这条运维观测线是死的，' +
        '越权事故发生时没有任何计量可回溯',
    ).toBe(beforeUpdate.identityAccess.accessUpdate.success + 1)

    const again = await fetch(`${baseUrl}/api/users/${target.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ role: 'admin' }),
    })
    expect(again.ok, `前提不成立：重复提权请求失败 ${again.status}`).toBe(true)
    const afterNoOp = await readHealth(baseUrl)
    expect(
      afterNoOp.identityAccess.accessUpdate.noOp,
      '一次「什么都没改变」的权限请求被算进了别的档 ⇒ 真实变更数被重放 / 重试请求灌水，' +
        '这条线索在事故复盘时反而误导人',
    ).toBe(beforeUpdate.identityAccess.accessUpdate.noOp + 1)
    expect(
      afterNoOp.identityAccess.accessUpdate.success,
      '一次 no-op 请求把 success 也顶上去了 ⇒ 计量分不清「真的改了」和「请求重放」',
    ).toBe(afterSuccess.identityAccess.accessUpdate.success)
    expect(
      afterNoOp.identityAccess.authorityReresolution,
      'authorityReresolution 恒定不动 ⇒ 「权限被反复重解析」这类性能 / 正确性问题没有观测点',
    ).toBeGreaterThan(first.identityAccess.authorityReresolution)

    // ── ④ recovery 是活的，且整份载荷是「本次启动以来」的：把 daemon 打死再起来，
    //      上一轮那行 running 任务会被开机回收，recovery 里必须留下这笔账。
    await daemon.killChild('SIGKILL')
    daemon = null
    restarted = await startDaemon({ home })
    const afterRestart = await readHealth(restarted.baseUrl)
    expect(
      afterRestart.recovery['boot-reap'] ?? 0,
      'daemon 被打死重启、开机回收了上一轮的残留任务，recovery 却一个数都没记 ⇒ ' +
        '一个每次重启都在悄悄收尸的实例在健康面板上与一个从不出事的实例长得一模一样',
    ).toBeGreaterThanOrEqual(1)
    // 这一档的 recovery 里现在**确实有东西**，所以「值必须是数字」在这里才不是空转：
    // 一个把计数序列化成字符串 / 对象的改动会让所有累加与阈值告警在读取侧静默失效。
    for (const [kind, count] of Object.entries(afterRestart.recovery)) {
      expect(
        typeof count,
        `recovery.${kind} 不是数字 ⇒ 这条计量没法累加、没法设阈值，运维面板上只会显示一个死值`,
      ).toBe('number')
    }
    expect(
      afterRestart.runningTasks,
      '重启之后上一轮的 running 任务仍被算作在跑 ⇒ 一行永远不会推进的幽灵任务会让' +
        '「能不能安全停机」永远答不出来',
    ).toBe(0)
    expect(
      afterRestart.identityAccess.accessUpdate.success,
      'identityAccess 计数跨进程活了下来 ⇒ 它自称是「本次启动以来」的计量，实际却在累加历史，' +
        '看板上的速率与告警阈值全部失真',
    ).toBe(0)
  } finally {
    if (daemon !== null) await daemon.stop()
    if (restarted !== null) await restarted.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 未覆盖：OPS-007（stop 超时 / 强杀时以非零退出码诚实上报「不是优雅停机」）
// ---------------------------------------------------------------------------
//
// 这一条**造得出现场，但 e2e 侧收不到结果**，所以如实留空而不是用 sleep 去赌：
//
//   * 现场是确定的：在库里放一行 `running` 任务，daemon 的排空会一直等它，
//     `stop` 于是走到 `packages/backend/src/cli/stop.ts:85-118` 的 timeout 分支，
//     打印 `did not exit within 30000ms` 并由 `packages/backend/src/main.ts:71-80`
//     以退出码 1 收场。本地实测复现稳定。
//   * 收不到的原因是两个硬编码时长撞在一起：`stop` 的等待预算是 30s
//     （`cli/stop.ts:85`，且 `main.ts:72` 调 `stopCommand()` 时不传任何 options，
//     CLI 也没有 `--timeout` 之类的旋钮），而 e2e 允许的子进程边界只有
//     `e2e/command.ts` 的 `runCommandResult`，它的硬超时是 15s
//     （`e2e/command.ts:15` `COMMAND_TIMEOUT_MS`）。15s 一到子进程被 harness 打死，
//     拿到的是 `status: -1` 和空输出——那是 harness 的行为，不是产品的契约，
//     拿它写断言等于自欺。
//   * `forced`（强杀后如实标注「这不是优雅停机」）这一档在 POSIX 上根本不可达：
//     `cli/stop.ts:104` 明写 `platform === 'win32'` 才会走硬杀，非 Windows 只会
//     停在 timeout。CI 的 e2e 腿跑在 ubuntu / macOS 上。
//
// 要让它可覆盖，二选一（都超出「只新增一个 spec 文件」的范围，留给后续 RFC）：
//   a) 产品侧给 `stop` 加 `--timeout <ms>`（本身也是真实的运维需求：不同部署对
//      「愿意等多久」的判断不同）；或
//   b) e2e 侧让 `runCommandResult` 接受 per-call 超时，供这一条用例放宽到 40s。
