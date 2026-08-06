// Regression lock for RFC-252 G2 —— macOS child profile 从 `(allow default)` 改为
// **全局默认禁写**，与 Linux 的 `--ro-bind / /` 对齐。
//
// 为什么这个文件存在：改动前两平台的 child 边界是不对称的 ——
//   Linux：`--ro-bind / /` + tmpfs masks + 精确 rw bind ⇒ 全盘只读，只有 allow-back 可写
//   macOS：`(allow default)` + 仅遮 masks ⇒ **masks 之外一律可写**
// 本机实测 `/opt/homebrew/bin` 是 `drwxrwxrwx`，于是 macOS 上的 child 可以覆写任意 brew
// 二进制，等用户或 daemon 下次执行即在沙箱外获得执行 —— 这条通道在 Linux 上根本不存在。
//
// 本文件的核心是一张**两平台共用的可写/只读集合表**：两个渲染器都从
// `netlessWritableSubtrees` 派生同一组路径，因此「谁多放了一条」必须立刻可见。任何一天有人
// 只给一个平台加了可写根，跨平台一致性断言就会红。
//
// 平台差异只允许出现在本文件显式登记的两处（macOS 的写例外与多出来的 /private 别名），
// 其余一律必须一致。

import { describe, expect, test } from 'bun:test'
import {
  renderNetlessBwrapArgs,
  renderNetlessSeatbeltProfile,
  type NetlessSubprocessManifest,
} from '@/services/runtime/opencode/sealedSubprocess'

function manifest(patch: Partial<NetlessSubprocessManifest> = {}): NetlessSubprocessManifest {
  return {
    codec: 1,
    mode: 'shell',
    provider: { providerId: 'linux-bwrap', config: { bwrapPath: '/usr/bin/bwrap' } },
    worktreePath: '/home/operator/worktree',
    scratchPath: '/srv/agent-workflow/runs/run-a/scratch',
    appHome: '/srv/agent-workflow',
    realHome: '/home/operator',
    gitCommonDirs: ['/srv/agent-workflow/repos/project.git'],
    bindReadOnly: ['/srv/agent-workflow/runs/run-a/seal/skills/skill-a'],
    env: {
      HOME: '/srv/agent-workflow/stores/store-a/home',
      TMPDIR: '/srv/agent-workflow/stores/store-a/tmp',
      PATH: '/usr/bin:/bin',
    },
    command: ['/bin/sh'],
    ...patch,
  }
}

const seatbeltManifest = (patch: Partial<NetlessSubprocessManifest> = {}) =>
  manifest({
    provider: {
      providerId: 'macos-seatbelt',
      config: { sandboxExecPath: '/usr/bin/sandbox-exec' },
    },
    ...patch,
  })

/** `--bind SRC DST` 的 SRC 集合 = bwrap 渲染出的可写根。 */
function bwrapWritableRoots(args: readonly string[]): string[] {
  const roots: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--bind' && args[i + 1] !== undefined) roots.push(args[i + 1]!)
  }
  return roots.sort()
}

function bwrapReadOnlyRoots(args: readonly string[]): string[] {
  const roots: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    // 第一条 `--ro-bind / /` 是「全盘只读」基线，不是 allow-back。
    if (args[i] === '--ro-bind' && args[i + 1] !== undefined && args[i + 1] !== '/') {
      roots.push(args[i + 1]!)
    }
  }
  return roots.sort()
}

function bwrapMaskedRoots(args: readonly string[]): string[] {
  const roots: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--tmpfs' && args[i + 1] !== undefined) roots.push(args[i + 1]!)
  }
  return roots.sort()
}

function sbplMatches(profile: string, pattern: RegExp): string[] {
  return [...profile.matchAll(pattern)].map((m) => m[1]!).sort()
}

const seatbeltWritableRoots = (profile: string): string[] =>
  sbplMatches(profile, /\(allow file-read\* file-write\* \(subpath "([^"]+)"\)\)/g)
const seatbeltReadOnlyRoots = (profile: string): string[] =>
  sbplMatches(profile, /\(allow file-read\* \(subpath "([^"]+)"\)\)/g)
const seatbeltMaskedRoots = (profile: string): string[] =>
  sbplMatches(profile, /\(deny file-read\* file-write\* \(subpath "([^"]+)"\)\)/g)
const seatbeltWriteExceptions = (profile: string): string[] =>
  sbplMatches(profile, /\(allow file-write\* \(subpath "([^"]+)"\)\)/g)

/**
 * 有效写权限判定：没有全局禁写基线时 `(allow default)` 让**一切**可写，此时任何
 * 「不在显式可写列表里」的断言都是假绿。这个 helper 把语义claim 直接表达出来。
 */
function seatbeltWriteAllowed(profile: string, path: string): boolean {
  if (!profile.includes('(deny file-write* (subpath "/"))')) return true
  const allows = [...seatbeltWritableRoots(profile), ...seatbeltWriteExceptions(profile)]
  return allows.some((root) => path === root || path.startsWith(`${root}/`))
}

// RFC-254: both describes render the POSIX sandbox specs (renderNetlessSeatbeltProfile
// = macOS SBPL, renderNetlessBwrapArgs = Linux bwrap) — POSIX-mechanism never produced
// on Windows v1 (D1: no sandbox provider; validatePolicyPath rejects the POSIX fixture
// paths). Same class as rfc205-sandbox-policy / rfc251-linux-plugin-visibility. (The
// second describe calls the renderers at describe-body level, so it must skip at
// collection time too.)
describe.skipIf(process.platform === 'win32')('RFC-252 G2 · macOS child 默认禁写', () => {
  test('基线是全局禁写，且排在所有 allow-back 之前（SBPL last-match-wins）', () => {
    const profile = renderNetlessSeatbeltProfile(seatbeltManifest())
    const lines = profile.split('\n')
    expect(lines[0]).toBe('(version 1)')
    expect(lines[1]).toBe('(allow default)')
    // 改动前这里是 `(deny network*)`，masks 之外一律可写。
    expect(lines[2]).toBe('(deny file-write* (subpath "/"))')

    const denyAll = lines.indexOf('(deny file-write* (subpath "/"))')
    const firstWritableAllow = lines.findIndex((l) =>
      l.startsWith('(allow file-read* file-write* (subpath'),
    )
    const lastReadOnlyDeny = lines.reduce(
      (acc, l, i) => (l.startsWith('(deny file-write* (subpath') && i > 0 ? i : acc),
      -1,
    )
    expect(denyAll).toBeLessThan(firstWritableAllow)
    // 只读覆盖必须排在可写 allow-back 之后，否则它所在的可写子树会把它盖掉。
    expect(lastReadOnlyDeny).toBeGreaterThan(firstWritableAllow)
  })

  test('写例外只有 /dev 与 macOS per-user 临时目录，且排在全局禁写之后', () => {
    const profile = renderNetlessSeatbeltProfile(seatbeltManifest())
    expect(seatbeltWriteExceptions(profile)).toEqual([
      '/dev',
      '/private/var/folders',
      '/var/folders',
    ])
    const lines = profile.split('\n')
    expect(lines.indexOf('(allow file-write* (subpath "/dev"))')).toBeGreaterThan(
      lines.indexOf('(deny file-write* (subpath "/"))'),
    )
  })

  test('masks 之外不再可写：/opt/homebrew、/usr/local、/Users/Shared 都没有写授权', () => {
    const profile = renderNetlessSeatbeltProfile(seatbeltManifest())
    for (const hostile of [
      '/opt/homebrew',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/Users/Shared',
    ]) {
      // 断言**有效策略**而不是「不在显式可写列表里」—— 后者在没有全局禁写基线时
      // 依然为真（`(allow default)` 让一切可写却没有任何显式条目），是个假绿断言。
      expect(seatbeltWriteAllowed(profile, hostile)).toBe(false)
    }
    // 但仍**可读可执行** —— 只读而非遮蔽，`/opt/homebrew/bin/python3` 照样能跑。
    expect(profile).not.toContain('(deny file-read* file-write* (subpath "/opt/homebrew"))')
  })

  test('网络仍然拒绝（G2 不碰 egress）', () => {
    expect(renderNetlessSeatbeltProfile(seatbeltManifest())).toContain('(deny network*)')
  })
})

describe.skipIf(process.platform === 'win32')('RFC-252 G2 · 两平台可写/只读集合必须一致', () => {
  // RFC-254: describe.skipIf still RUNS the describe body (only the tests skip), so
  // these body-level renderer calls execute even on win32 — where they throw (POSIX
  // sandbox spec + validatePolicyPath). Guard them; the tests that consume them are
  // skipped on win32 anyway.
  const bwrapArgs = process.platform === 'win32' ? [] : renderNetlessBwrapArgs(manifest(), [])
  const profile =
    process.platform === 'win32' ? '' : renderNetlessSeatbeltProfile(seatbeltManifest())

  test('可写根集合逐条相同（两边都派生自 netlessWritableSubtrees）', () => {
    expect(seatbeltWritableRoots(profile)).toEqual(bwrapWritableRoots(bwrapArgs))
    // sanity：这组集合非空且确实是本任务的工作面，不是空断言。
    expect(bwrapWritableRoots(bwrapArgs)).toContain('/home/operator/worktree')
    expect(bwrapWritableRoots(bwrapArgs)).toContain('/srv/agent-workflow/repos/project.git')
  })

  test('只读 allow-back 集合逐条相同', () => {
    expect(seatbeltReadOnlyRoots(profile)).toEqual(bwrapReadOnlyRoots(bwrapArgs))
    expect(bwrapReadOnlyRoots(bwrapArgs)).toContain(
      '/srv/agent-workflow/runs/run-a/seal/skills/skill-a',
    )
  })

  test('遮蔽根只差 macOS 的 /private 别名——差异是显式登记的，不是漂移', () => {
    const linux = bwrapMaskedRoots(bwrapArgs)
    const mac = seatbeltMaskedRoots(profile)
    expect(linux).toEqual(['/home/operator', '/srv/agent-workflow', '/tmp', '/var/tmp'])
    expect(mac).toEqual([
      '/home/operator',
      '/private/tmp',
      '/private/var/tmp',
      '/srv/agent-workflow',
      '/tmp',
      '/var/tmp',
    ])
    // 唯一允许的差异：macOS 上 /tmp 与 /var/tmp 各自还有 /private 前缀的真身。
    expect(mac.filter((p) => !linux.includes(p))).toEqual(['/private/tmp', '/private/var/tmp'])
  })

  test('平台差异清单是穷尽的：除写例外与 /private 别名外，两边渲染不得再有第三处分歧', () => {
    // 这条是防漂移的总闸：任何一天有人只给一个平台加了可写/只读根，上面三条会红；
    // 若有人加了新的平台专属写例外，这条会红。
    expect(seatbeltWriteExceptions(profile)).toEqual([
      '/dev',
      '/private/var/folders',
      '/var/folders',
    ])
    expect(bwrapWritableRoots(bwrapArgs).filter((p) => p.startsWith('/dev'))).toEqual([])
  })
})
