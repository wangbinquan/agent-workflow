// RFC-284 T18（审计 N22 / design §3.5）——git 双生 spawn 点的双向源码文本锁。
//
// 为什么存在：`util/git.ts` runGit 与 `services/gitRepoCache.ts` spawnGit 是仅有的
// 两个生产 git spawn 点。RFC-252 G1 在 spawnGit 注释里口头约定「the two must not
// drift」，但二者的超时机器——组杀 timer、exit 先行 + 有界管道读（250ms）、
// SIGKILL 后 exitCode 0 重映射为 124、detached-iff-timeout——是同一段安全语义的
// 镜像拷贝，RFC-208/252 的历史修复每次都要人肉记得改两处。本测试把「不得漂移」
// 从注释升级为可执行锁：改动任一侧镜像段落而未同步另一侧即红。
//
// 若未来把双点收敛为单一 spawn 助手（审计 N22 曾议、RFC-284 D 账未采纳），
// 本测试连同镜像段落一起删除即可——它锁的是「双点并存期间的等价性」，
// 不是双点本身的存在。
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const gitTs = await Bun.file(join(ROOT, 'src/util/git.ts')).text()
const cacheTs = await Bun.file(join(ROOT, 'src/services/gitRepoCache.ts')).text()

/** 注释剥离 + 空白折叠 + 两侧合法命名差异归一（outPromise↔outP / errPromise↔errP）。 */
function normalize(seg: string): string {
  return seg
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\boutPromise\b/g, 'outP')
    .replace(/\berrPromise\b/g, 'errP')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从函数签名锚起，取 `let timedOut = false` 至首个 `clearTimeout(timer)`（含）
 * 的超时机器段。签名锚必须唯一——多于一处说明文件结构变了，测试须重新锚定
 * 而不是静默取错段落。
 */
function extractTimeoutBlock(src: string, fnAnchor: string, label: string): string {
  const fnCount = src.split(fnAnchor).length - 1
  expect(`${label}: ${fnCount} fn anchor(s)`).toBe(`${label}: 1 fn anchor(s)`)
  const body = src.slice(src.indexOf(fnAnchor))
  const start = body.indexOf('let timedOut = false')
  expect(start).toBeGreaterThan(-1)
  const endMarker = 'clearTimeout(timer)'
  const end = body.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return body.slice(start, end + endMarker.length)
}

describe('rfc284 T18: runGit ↔ spawnGit 镜像段落双向锁', () => {
  test('超时机器段（组杀 / exit 先行有界读 / 124 重映射）归一化后逐字相等', () => {
    const a = extractTimeoutBlock(gitTs, 'export async function runGit(', 'util/git.ts')
    const b = extractTimeoutBlock(cacheTs, 'async function spawnGit(', 'gitRepoCache.ts')
    expect(normalize(a)).toBe(normalize(b))
  })

  test('镜像语义要件在两侧同时在场（单侧删除/改写即红）', () => {
    const TWIN_FRAGMENTS = [
      // detached-iff-(timeout|signal)：带 deadline **或**可取消的 spawn 进独立进程组
      // （RFC-208 组杀前提）。RFC-287 T13 给两侧同时加了 AbortSignal——取消要真杀
      // 正在克隆的 git，而不是等它跑完；判据随之从「仅超时」扩到「超时或可取消」。
      '...(opts?.timeoutMs !== undefined || opts?.signal !== undefined ? { detached: true } : {})',
      // 组杀被抽成 killTree，超时与取消共用同一条（两侧必须同时抽，否则又漂移）。
      'const killTree = (): void => {',
      // 取消同样不能被误判成成功——与超时那条重映射对称。
      'exitCode === 0 ? GIT_ABORTED_EXIT_CODE : exitCode',
      // 组杀负 PGID + 单进程回退。
      "process.kill(-proc.pid, 'SIGKILL')",
      // RFC-252 G1：每个生产 git spawn 都必须过 hardenGitArgs。
      "cmd: ['git', ...hardenGitArgs(",
      // 非交互 env 守卫（ssh/https 提示挂死防护）。
      'nonInteractiveGitEnv()',
      // SIGKILL 后 exitCode 可能是 0——必须重映射，超时绝不能被当成成功。
      'exitCode === 0 ? GIT_TIMEOUT_EXIT_CODE : exitCode',
    ]
    for (const frag of TWIN_FRAGMENTS) {
      expect(gitTs).toContain(frag)
      expect(cacheTs).toContain(frag)
    }
  })

  test('无-deadline 快路径（历史扁平 spawn）两侧同形', () => {
    const flat = normalize(
      `const [stdout, stderr, exitCode] = await Promise.all([
         new Response(proc.stdout).text(),
         new Response(proc.stderr).text(),
         proc.exited,
       ])`,
    )
    expect(normalize(gitTs)).toContain(flat)
    expect(normalize(cacheTs)).toContain(flat)
  })
})
