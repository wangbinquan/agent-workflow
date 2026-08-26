// RFC-319 OPS-007 —— `stop` 停不下来的时候必须诚实：非零退出码 + 明说「这不是优雅停机」。
//
// 为什么这条测试存在：在它之前，这条能力**只有源码文本断言**在守
// （`rfc254-control-listener.test.ts` 的 `expect(source).toContain("status: 'forced'")`
// 等四行）。文本断言锁得住字面量，锁不住行为——把轮询超时后的那段 return 整块换成
// `{ status: 'stopped', graceful: true }`，只要文件里别处还留着 `status: 'forced'`
// 这串字符，那几条 toContain 依旧全绿，而运维拿到的就是一句谎报的「stopped」。
// 谎报的代价是具体的：脚本里 `stop && start` 会把「我把它打死了」当成干净停机继续走，
// 而下一次 start 面对的是一堆没 park 的在途任务（要按 interrupted 收尸）。
//
// 所以这里补两层真跑：
//   1. 进程内 —— 拿一个**真的不理 SIGTERM** 的活进程占住 lock，看 stopCommand 的结论；
//   2. 真 CLI —— `bun main.ts stop` 的**退出码**。「非零退出码」是这条能力的字面主张，
//      而退出码只有真跑一次才看得见，源码里那行 `process.exit(1)` 断言不了它真的生效。
//
// 为什么不放 e2e：CLI 的 stop 预算是 30s（cli/stop.ts 的 `opts.timeoutMs ?? 30_000`），
// 而 e2e harness 的 COMMAND_TIMEOUT_MS 是 15s —— 命令会先被 harness 掐断，那时看到的是
// harness 的超时，不是产品的超时分支。这条只能在没有该上限的后端套件里跑。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stopCommand } from '../src/cli/stop'
import { isProcessAlive, writePidFileForTest } from '../src/util/lock'
import { Paths } from '../src/util/paths'
import { removeTempDirSync } from './fixtures/tempDir'

const mainPath = resolve(import.meta.dir, '..', 'src', 'main.ts')

/**
 * 一个**装死**的子进程：装好 SIGTERM 处理器后就不再退出。
 *
 * POSIX 的 stop 只发信号、不强杀（强杀回退是 win32 专属的 taskkill），所以这个进程
 * 会一直占着 lock 直到预算耗尽 —— 这正是 timeout 分支在现实里的成因，不是模拟。
 *
 * 必须等它把处理器装好再发信号：装好之前 SIGTERM 的默认行为就是退出，那样测到的
 * 是「进程死了」而不是「进程赖着不走」，两条路径的结论并不相同。
 */
async function spawnStubborn(home: string): Promise<Bun.Subprocess> {
  const marker = join(home, 'stubborn.ready')
  const child = Bun.spawn({
    cmd: [
      'bun',
      '-e',
      `process.on('SIGTERM', () => {});` +
        `require('fs').writeFileSync(${JSON.stringify(marker)}, '1');` +
        `setInterval(() => {}, 1000)`,
    ],
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (existsSync(marker)) return child
    await Bun.sleep(20)
  }
  child.kill('SIGKILL')
  throw new Error('装死进程没有在 15s 内装好 SIGTERM 处理器')
}

async function reap(child: Bun.Subprocess): Promise<void> {
  try {
    child.kill('SIGKILL')
  } catch {
    /* 已经没了 */
  }
  await child.exited
}

describe('RFC-319 OPS-007 —— 停不下来的 daemon 不许被报成优雅停机', () => {
  let tmp: string
  let origHome: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-stop-honest-'))
    origHome = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = tmp
  })

  afterEach(() => {
    if (origHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = origHome
    removeTempDirSync(tmp)
  })

  test('drain 超时：结论是 timeout / graceful=false，lock 不删、进程不强杀', async () => {
    const child = await spawnStubborn(tmp)
    const pid = child.pid
    expect(pid, 'Bun.spawn 没给出 pid ⇒ 后面所有断言都无从谈起').toBeGreaterThan(0)
    writePidFileForTest(Paths.lock, pid)

    const started = Date.now()
    const result = await stopCommand({ timeoutMs: 600 })
    const waited = Date.now() - started

    try {
      expect(result.status).toBe('timeout')
      expect(
        result.graceful,
        'graceful 必须是 false —— 它是「在途任务有没有被 park」的唯一机器判据',
      ).toBe(false)
      expect(result.pid).toBe(pid)
      // 报文要能让运维直接定位：哪个进程、等了多久。
      expect(result.message).toContain(String(pid))
      expect(result.message).toContain('600ms')
      expect(
        result.message.toLowerCase(),
        '停不下来却在报文里说 stopped，正是这条测试要挡的谎报',
      ).not.toContain('stopped')
      // 它必须真的等满预算才下结论：立刻返回 timeout 等于根本没给 daemon 机会 drain。
      expect(waited, `只等了 ${waited}ms 就宣布超时 ⇒ 预算没被真正遵守`).toBeGreaterThanOrEqual(600)
      // 没把 lock 删掉冒充成功 —— 下一次 start 还要靠它发现「有人占着」。
      expect(existsSync(Paths.lock), 'lock 被删了 ⇒ 下一次 start 会以为现场是干净的').toBe(true)
      // POSIX 不强杀：taskkill 回退是 win32 专属，这里进程必须还活着。
      expect(isProcessAlive(pid), 'POSIX 路径把进程打死了 ⇒ win32 的强杀回退漏进了通用分支').toBe(
        true,
      )
    } finally {
      await reap(child)
    }
  }, 30_000)

  test('真跑一次 CLI：停不下来时退出码非零，输出里一个字都不说 stopped', async () => {
    const child = await spawnStubborn(tmp)
    const pid = child.pid
    writePidFileForTest(Paths.lock, pid)

    try {
      // 这里走的是产品默认的 30s 预算（CLI 没有 --timeout 旋钮），所以这条用例本身
      // 就要花掉 30s。它买到的是别处买不到的东西：真实退出码。
      const cli = Bun.spawn({
        cmd: ['bun', 'run', mainPath, 'stop'],
        env: { ...(process.env as Record<string, string>), AGENT_WORKFLOW_HOME: tmp },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const code = await cli.exited
      const out = await new Response(cli.stdout).text()

      expect(code, `stop 以 ${code} 退出 ⇒ 脚本里的 \`stop && start\` 会把强停当成干净停机`).toBe(1)
      expect(out).toContain('did not exit within 30000ms')
      expect(out.toLowerCase()).not.toContain('stopped')
    } finally {
      await reap(child)
    }
  }, 90_000)

  test('反向自证：没有 daemon 时 stop 退出码是 0（否则上面那条「非零」是恒真的）', async () => {
    // 没有这条，「退出码为 1」可能只是因为 stop 永远 exit 1 —— 那样它什么也没锁住。
    const cli = Bun.spawn({
      cmd: ['bun', 'run', mainPath, 'stop'],
      env: { ...(process.env as Record<string, string>), AGENT_WORKFLOW_HOME: tmp },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await cli.exited
    const out = await new Response(cli.stdout).text()
    expect(code, 'stop 对「本来就没在跑」也报错 ⇒ 退出码没有区分力').toBe(0)
    expect(out).toContain('not running')
  }, 30_000)
})
