// RFC-284 T16（proposal C7）—— pluginInstaller.runCommand 收编 runManagedProcess 的
// 有意变更对拍锁：
//   1) >64KB stderr：失败详情 = 头 2KB 切片（STDERR_CAPTURE_BYTES），与收编前的
//      「64KB 前缀捕获再切头」逐字节同轴——HEAD 标记在、TAIL 标记不在、长度受上限；
//   2) 信号死：错误类型仍是 PluginInstallFailedError（exitCode 呈现轴见用例内注释）；
//   3) 超时：仍抛 PluginInstallTimeoutError（现为树杀真死后报错，非旧的即刻 reject）；
//   4) npmBin 不存在：spawn-failed 文案指名 argv0（替代旧 node 'error' 事件裸 reject）。
// 成功路径的 outcome / 产物路径逐字节不变由既有 install 套件承担
// （plugins-http / scheduler-plugin-preload / rfc201-plugin-exact-operation）。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import {
  installPlugin,
  PluginInstallFailedError,
  PluginInstallTimeoutError,
} from '../src/services/pluginInstaller'

const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.ts')

let pluginsDir = ''

beforeEach(async () => {
  pluginsDir = await mkdtemp(join(tmpdir(), 'rfc284-t16-'))
})

afterEach(async () => {
  await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
  delete process.env.FAKE_NPM_MODE
})

async function installErr(opts: { npmBin?: string; timeoutMs?: number } = {}): Promise<unknown> {
  return installPlugin(ulid(), 'left-pad@1.0.0', {
    pluginsDir,
    npmBin: opts.npmBin ?? FAKE_NPM,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  }).then(
    () => null,
    (e: unknown) => e,
  )
}

describe('rfc284 T16: pluginInstaller → runManagedProcess（C7 对拍锁）', () => {
  test('C7-1: >64KB stderr 的失败详情 = 头 2KB 切片（HEAD 在、TAIL 不在）', async () => {
    process.env.FAKE_NPM_MODE = 'huge-stderr'
    const err = await installErr()
    expect(err).toBeInstanceOf(PluginInstallFailedError)
    const failed = err as PluginInstallFailedError
    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toContain('HEAD-MARKER')
    expect(failed.stderr).not.toContain('TAIL-MARKER')
    expect(failed.stderr.length).toBeLessThanOrEqual(2_048)
  })

  test('C7-2: 信号死 → PluginInstallFailedError（非超时、非 spawn 错）', async () => {
    process.env.FAKE_NPM_MODE = 'self-kill'
    const err = await installErr()
    expect(err).toBeInstanceOf(PluginInstallFailedError)
    const failed = err as PluginInstallFailedError
    // 旧实现 node 'exit' (code=null, signal) → -1；managedProcess 走 Bun 的
    // exited 数值。本断言锁「非 0 失败码」这一产品面；具体数值轴的迁移已在
    // proposal C7 登记（诊断细节，不构成 API 契约）。
    expect(failed.exitCode).not.toBe(0)
  })

  test('C7-3: 超时 → PluginInstallTimeoutError（树杀真死后报错）', async () => {
    process.env.FAKE_NPM_MODE = 'timeout'
    const err = await installErr({ timeoutMs: 400 })
    expect(err).toBeInstanceOf(PluginInstallTimeoutError)
    expect((err as PluginInstallTimeoutError).timeoutMs).toBe(400)
  })

  test('C7-4: npmBin 不存在 → 报错指名缺失的 argv0', async () => {
    const missing = join(pluginsDir, 'no-such-npm')
    const err = await installErr({ npmBin: missing })
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('no-such-npm')
  })
})
