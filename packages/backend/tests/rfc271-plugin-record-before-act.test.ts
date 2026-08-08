// RFC-271 T11 —— 插件安装的 **record-before-act**（承重不变量 I14）。
//
// 规则：**任何外部副作用之前，先把「足以精确补偿它」的信息持久化进 journal。**
//
// 现有 intent 路径只做到「先 record `{pluginId}`」——**不含 generation id**，因为
// 那个 id 在 `installPlugin` 内部才生成。于是崩溃后：
//   · 启动收敛不知道该删哪个 generation 目录；
//   · 粗粒度 GC（`pluginGenerationGc`）又被任一非终态 node run 完全挡住
//   ⇒ 目录永久残留，且 journal 无法证明补偿完成。
//
// 只把目录挂在**抛出的错误**上不够：进程可能在 mkdir 之后、返回/抛错之前被
// SIGKILL —— 那一瞬间没有任何异常对象存在过。
//
// 所以调用方要**预铸** generation id，先把精确路径写进 artifacts，再动手安装。
// 本文件锁的就是这条链的两端能对上：`plannedGenerationDir` 预告的路径，必须**就是**
// installer 实际创建的那个目录。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { installPlugin, plannedGenerationDir } from '../src/services/pluginInstaller'

const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.ts')

let pluginsDir = ''

beforeEach(async () => {
  pluginsDir = await mkdtemp(join(tmpdir(), 'rfc271-plugin-'))
  process.env.FAKE_NPM_MODE = 'success'
})

afterEach(async () => {
  delete process.env.FAKE_NPM_MODE
  await rm(pluginsDir, { recursive: true, force: true })
})

describe('plannedGenerationDir —— 安装前就能算出精确路径', () => {
  test('npm 源：路径是 <pluginsDir>/<pluginId>/generations/<generationId>', () => {
    const dir = plannedGenerationDir('01PLUG', 'left-pad@1.0.0', '01GEN', pluginsDir)
    expect(dir).toBe(join(pluginsDir, '01PLUG', 'generations', '01GEN'))
  })

  test('file: 源不产生 generation 目录 ⇒ null（它直接指向外部路径，没有可删的东西）', () => {
    expect(plannedGenerationDir('01PLUG', 'file:/tmp/x', '01GEN', pluginsDir)).toBeNull()
  })

  test('不同的预铸 id 给出不同目录（补偿要能精确到这一代）', () => {
    const a = plannedGenerationDir('01PLUG', 'left-pad', '01GEN-A', pluginsDir)
    const b = plannedGenerationDir('01PLUG', 'left-pad', '01GEN-B', pluginsDir)
    expect(a).not.toBe(b)
  })
})

describe('两端必须对得上 —— 预告的路径就是 installer 真的创建的那个', () => {
  test('传入预铸 generationId ⇒ result.generationDir === plannedGenerationDir(...)', async () => {
    const pluginId = ulid()
    const generationId = ulid()
    const planned = plannedGenerationDir(pluginId, 'left-pad@1.0.0', generationId, pluginsDir)
    expect(planned).not.toBeNull()
    // record-before-act：真实调用方在这一行之前把 `planned` 写进 journal artifacts。
    expect(existsSync(planned!)).toBe(false)

    const result = await installPlugin(pluginId, 'left-pad@1.0.0', {
      pluginsDir,
      npmBin: FAKE_NPM,
      generationId,
    })

    expect(result.generationDir).toBe(planned)
    expect(existsSync(planned!)).toBe(true)
  })

  test('不传 generationId 时 installer 自己铸一个 —— 单条路径行为逐字不变', async () => {
    const pluginId = ulid()
    const result = await installPlugin(pluginId, 'left-pad@1.0.0', {
      pluginsDir,
      npmBin: FAKE_NPM,
    })
    expect(result.generationDir).not.toBeNull()
    // 仍在同一个 generations 根下，只是这一代的 id 事前不可知（所以批量路径不能用它）。
    expect(result.generationDir!.startsWith(join(pluginsDir, pluginId, 'generations'))).toBe(true)
  })

  test('安装失败时**目录已经存在**——正是「只靠异常对象记录路径不够」的证据', async () => {
    const pluginId = ulid()
    const generationId = ulid()
    const planned = plannedGenerationDir(pluginId, 'left-pad@1.0.0', generationId, pluginsDir)!
    process.env.FAKE_NPM_MODE = 'fail'
    await expect(
      installPlugin(pluginId, 'left-pad@1.0.0', {
        pluginsDir,
        npmBin: FAKE_NPM,
        generationId,
      }),
    ).rejects.toBeDefined()
    // mkdir 已经发生。如果进程在这一刻被 SIGKILL，没有任何异常对象留存过——
    // 能救场的只有事先落库的这条 artifact。
    expect(existsSync(planned)).toBe(true)
  })
})
