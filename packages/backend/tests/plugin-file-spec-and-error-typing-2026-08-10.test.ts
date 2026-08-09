// 2026-08-10 本机全能力验收的两条回归锁（同源：插件安装的错误面）。
//
// 1) **`file:<path>` 单冒号形态必然装不上**。`inferSourceKind` 明确把 `file:`
//    前缀判成 file 源（npm 自己的合法写法，`file:/abs` / `file:./rel`），但
//    `installFilePlugin` 只对 **`file://`** 做转换，单冒号形态被原样丢给
//    `realpath("file:/Users/…")` ⇒ 恒定 `plugin-file-not-found`。分类器与安装器
//    对同一个前缀理解不一致，那条分支等于「能存不能装」。
//
// 2) **同一个失败在不同入口的表现天差地别**。四个安装错误类原本是裸 `Error`，
//    只有 `routes/plugins.ts` 有一层私有翻译 ⇒ `/api/plugins` 得到 422
//    `plugin-file-not-found`，而**意图会话提交**与**配置包导入**（同样会装插件）
//    直接 500 `internal-error`，调用方拿不到任何可操作信息。实测就是这么撞上的：
//    意图提交 7 个资源全回滚，响应只有 `internal-error`。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  fileSpecToHostPath,
  inferSourceKind,
  installPlugin,
  NpmUnavailableError,
  PluginFileNotFoundError,
  PluginInstallFailedError,
  PluginInstallTimeoutError,
} from '@/services/pluginInstaller'
import { DomainError } from '@/util/errors'

describe('file 源 spec 的三种形态都要归一成宿主路径', () => {
  test('file:// URL 走 fileURLToPath', () => {
    const url = pathToFileURL('/tmp/aw-plugin-x').href
    expect(fileSpecToHostPath(url)).toBe('/tmp/aw-plugin-x')
  })

  test('file:<abs> 单冒号形态剥前缀（此前原样进 realpath ⇒ 必失败）', () => {
    expect(fileSpecToHostPath('file:/Users/x/aw-plugin')).toBe('/Users/x/aw-plugin')
  })

  test('file:<rel> 单冒号相对形态同样剥前缀', () => {
    expect(fileSpecToHostPath('file:./local-plugin')).toBe('./local-plugin')
  })

  test('裸路径原样', () => {
    expect(fileSpecToHostPath('/opt/aw-plugin')).toBe('/opt/aw-plugin')
  })

  test('分类器与安装器对 file: 前缀的判断一致', () => {
    expect(inferSourceKind('file:/Users/x/aw-plugin')).toBe('file')
    expect(inferSourceKind('file:///Users/x/aw-plugin')).toBe('file')
  })

  test('用 file:<abs> 装一个真实目录会成功（修复前恒定 plugin-file-not-found）', async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'aw-plugin-filespec-')))
    try {
      writeFileSync(join(dir, 'index.js'), 'export default async () => ({})\n')
      const result = await installPlugin('plugin-filespec-1', `file:${dir}`)
      expect(result.sourceKind).toBe('file')
      expect(result.cachedPath).toBe(dir)
      // file: 源不产生 generation 目录（它直接指向外部路径）。
      expect(result.generationDir).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('路径确实不存在时仍然报 plugin-file-not-found，且 spec 原样回带', async () => {
    await expect(installPlugin('plugin-filespec-2', 'file:/nope/aw-not-here')).rejects.toThrow(
      PluginFileNotFoundError,
    )
  })
})

describe('安装错误在抛出点就带 code/status/details（不再依赖路由私有翻译）', () => {
  const cases: Array<{ name: string; error: DomainError; code: string }> = [
    {
      name: 'PluginFileNotFoundError',
      error: new PluginFileNotFoundError('file:/nope'),
      code: 'plugin-file-not-found',
    },
    {
      name: 'PluginInstallFailedError',
      error: new PluginInstallFailedError('boom', 1),
      code: 'plugin-install-failed',
    },
    {
      name: 'PluginInstallTimeoutError',
      error: new PluginInstallTimeoutError(1234),
      code: 'plugin-install-timeout',
    },
    { name: 'NpmUnavailableError', error: new NpmUnavailableError(), code: 'npm-unavailable' },
  ]

  for (const c of cases) {
    test(`${c.name} 是 DomainError，422 + ${c.code}`, () => {
      expect(c.error).toBeInstanceOf(DomainError)
      expect(c.error.code).toBe(c.code)
      expect(c.error.status).toBe(422)
      // 错误载荷是 API 契约的一部分：意图提交 / 配置包导入现在直接透出它。
      expect(c.error.toPayload()).toMatchObject({ ok: false, code: c.code })
    })
  }

  test('details 里的可操作字段没丢（路由此前手工塞的那几个）', () => {
    const notFound = new PluginFileNotFoundError('file:/nope')
    expect(notFound.spec).toBe('file:/nope')
    expect(notFound.toPayload().details).toMatchObject({ spec: 'file:/nope' })

    const failed = new PluginInstallFailedError('stderr-tail', 7)
    expect(failed.stderr).toBe('stderr-tail')
    expect(failed.exitCode).toBe(7)
    expect(failed.toPayload().details).toMatchObject({ stderr: 'stderr-tail', exitCode: 7 })

    const timeout = new PluginInstallTimeoutError(999)
    expect(timeout.timeoutMs).toBe(999)
    expect(timeout.toPayload().details).toMatchObject({ timeoutMs: 999 })
  })
})
