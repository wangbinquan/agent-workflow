// RFC-281 T1 — opencode 任务工作区边界的 permission 合成（纯函数）。
//
// 目标（RFC-281 §0 首要原则）：把 agent 的写/执行关进「本任务自己的工作
// 区」，越界读写被 opencode 原生 `external_directory` 权限键拒绝。只做这一维，
// 不过度加固；业务正常执行不被误伤。
//
// 载荷是 opencode 的 `permission.external_directory`（读源，非记忆）：
//  - `packages/core/src/v1/config/permission.ts`：Action=ask|allow|deny；
//    Rule=Action | Record<pattern, Action>；顶层键 '*' 通配所有 permission 名。
//  - `packages/opencode/src/permission/index.ts:28-38`：规则 flatten 后
//    **findLast 匹配者胜**；`deny` 在 ask 之前短路（`--auto` 翻不动）。
//  - `packages/opencode/src/tool/external-directory.ts`：任何文件工具触碰
//    cwd/worktree 之外的路径都以「目标目录绝对 glob」发起 external_directory 判定。
//
// 键位纪律（RFC-251 踩过的坑 + RFC-281 T0 实证 E4/M1）：opencode 按**键序**
// flatten 再 findLast，而 external_directory 判定会同时匹配作者的 `'*': 'allow'`
// （通配所有 permission 名）和平台的 `external_directory` 规则。谁胜取决于键序。
//  - E4：同一 map 内 `{'*':allow, external_directory:deny}` → deny 胜（越界拒）；
//        `{external_directory:deny, '*':allow}` → allow 胜（越界放行）。
//  - M1：把 deny 放在**顶层 config**、作者 `'*':allow` 在**agent 条目** → 条目
//        的 '*' 溶解顶层 deny（跨层键序不可控）。
// ⇒ 必须在**每个业务 agent 条目自己的 map 内**注入 external_directory，并把它
//    追加在作者所有其他键（尤其 '*'）之后。这就是本函数做的事。

import { readdirSync } from 'node:fs'
import { isLexicallyInsideForHost } from '@/util/platformExec'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { join } from 'node:path'
/**
 * 扫出「兄弟任务」的工作区目录：appHome 下 `iso` / `worktrees` / `runs` 的直接
 * 子目录（worktrees 再下一层是 per-repo slug 下的 taskId），排除本任务自己的
 * 任何 mount。
 *
 * 只读 `readdirSync`，不解析 DB —— 边界只需要「不是我的就别碰」，不需要知道对方
 * 是谁。目录不存在/不可读时返回空（§0：拿不到就少一条规则，绝不阻断业务）。
 */
export function scanSiblingTaskRoots(
  appHome: string,
  ownMounts: readonly string[],
  /**
   * 本任务 id。同一个任务在 `iso/` / `runs/` / `worktrees/<slug>/` 下各有一份
   * 目录，而 mounts 只含 iso（或 canonical）那一份——只按路径前缀排除会把自己
   * 任务在**其他容器**下的目录当成兄弟 deny 掉，直接打挂业务（本测试抓到）。
   */
  ownTaskId?: string,
  readDir: (dir: string) => string[] = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return []
    }
  },
): string[] {
  const isOwn = (candidate: string): boolean => {
    if (ownTaskId !== undefined && ownTaskId.length > 0 && basename(candidate) === ownTaskId) {
      return true
    }
    // candidate 是否是某个自有 mount 本身或其祖先（RFC-254：用平台感知比较，
    // `${x}/` 前缀在 Windows 永不匹配且忽略 NTFS 大小写折叠）。
    return ownMounts.some((own) => isLexicallyInsideForHost(candidate, own))
  }
  const out: string[] = []
  // 只枚举**任务工作区**容器。`runs/` 刻意不枚举（业务误伤检视 P1-1）：它按
  // taskId 无限累积且**没有 GC**（`services/gc.ts` 只回收 worktrees/iso），本机
  // 实测已 1406 个 → 单它就产出 2812 条规则、settings.json 264 KB，每个 claude
  // 节点都要落盘 + 逐条匹配，随部署寿命单调恶化。它由调用方用**一条祖先 deny**
  // 覆盖（`runs/` 不含任何 mount，不会盖死 cwd —— 与 appHome 祖先根不同）。
  for (const name of readDir(join(appHome, 'iso'))) {
    const dir = join(appHome, 'iso', name)
    if (!isOwn(dir)) out.push(dir)
  }
  // worktrees/<repo-slug>/<taskId>
  const wtRoot = join(appHome, 'worktrees')
  for (const slug of readDir(wtRoot)) {
    for (const task of readDir(join(wtRoot, slug))) {
      const dir = join(wtRoot, slug, task)
      if (!isOwn(dir)) out.push(dir)
    }
  }
  return out
}

/**
 * 常见工具链的**缓存/状态目录**（业务误伤检视 P2-2，用户 2026-08-11 拍板放行）。
 *
 * 为什么必须放行：声明了 permission 的 claude 节点走 `dontAsk`，跑 `bun install`
 * / `npm ci` / `cargo build` / `pip install` 时要写这些目录 → 不在 allowWrite 就
 * EPERM；而 `dangerouslyDisableSandbox` 那条逃生阀在 `dontAsk` 下需要过权限门、
 * headless 无人应答 ⇒ **节点直接烂在那里、无自救路径**。Code→Audit→Fix 主线里
 * 的构建/测试节点是常见形态，这属于 §0 明令要避免的误伤。
 *
 * 放行它们不违背本 RFC 目标：它们是工具链缓存，不是**任何任务的工作区**——
 * RFC-281 要防的是「串到别的任务去」，不是把 agent 关进无菌室。
 *
 * 只列缓存/状态，不列凭据：`~/.npmrc`（含 token）、`~/.cargo/credentials`、
 * `~/.docker/config.json` 一律不在内。
 */
export function toolchainCacheDirs(home: string = homedir()): string[] {
  const xdgCache = process.env['XDG_CACHE_HOME']
  const cacheBase = xdgCache !== undefined && xdgCache.length > 0 ? xdgCache : join(home, '.cache')
  return [
    join(home, '.bun', 'install', 'cache'),
    join(home, '.npm', '_cacache'),
    join(home, '.npm', '_logs'),
    join(home, '.cargo', 'registry'),
    join(home, '.cargo', 'git'),
    join(home, '.pnpm-store'),
    join(home, '.yarn', 'berry', 'cache'),
    join(cacheBase, 'pip'),
    join(cacheBase, 'uv'),
    join(cacheBase, 'go-build'),
    join(home, 'go', 'pkg', 'mod'),
  ]
}

/**
 * 本次 run 的边界 mounts（runner 用）。
 *
 * 数据源是 scheduler 已填的 per-repo worktree 路径；**无论元数据说什么，进程
 * cwd 恒在其中**——否则 agent 会被挡在自己的工作树外（§0 最忌）。提成纯函数是
 * 为了让这条不变量有真正锁得住的断言面（实现门 P3-7：原先测试手抄了 runner 里
 * 的表达式，改 runner 测试照样绿）。
 */
export function resolveBoundaryMounts(
  worktreePath: string,
  repoWorktreePaths: readonly string[],
): string[] {
  const fromRepos = repoWorktreePaths.filter((p) => p.length > 0)
  const withCwd = fromRepos.includes(worktreePath) ? fromRepos : [worktreePath, ...fromRepos]
  return withCwd.length > 0 ? withCwd : [worktreePath]
}

/** 本次 run 的合法工作区数据源（全部取自 scheduler/runner 既有结构，不从路径形状猜）。 */
export interface BoundaryCtx {
  /** 本任务全部 mount 的 cwd/iso 路径（单仓 = [cwd]，多仓 = 每个成员）。 */
  readonly taskMounts: readonly string[]
  /** 本次 run 的 config/注入资源目录 `runs/{taskId}/{nodeRunId}`。 */
  readonly runDir: string
  /** 平台 stage 的 managed skill 目录（含 sibling 文件）。 */
  readonly stagedSkillDirs: readonly string[]
  /** 已是 glob 形态的临时目录放行项（如 `<tmpdir>/opencode/*`）——原样使用，不追加 `/*`。 */
  readonly tmpGlobs: readonly string[]
  /**
   * linked-worktree 的 git common/admin 目录（在 worktree 外，git 操作需放行）。
   *
   * **当前两个 driver 都已接线填充**（RFC-281 业务误伤检视批修多仓 git EPERM：
   * opencode 经 boundary 合成、claude 经 sandbox settings，各自 driver 内取
   * `git rev-parse --git-common-dir` 类来源填入——见 runtime/opencode/driver.ts
   * 与 runtime/claudeCode/driver.ts 的 gitMetaDirs 消费点）。
   * （2026-08-12 审计对账：此注释原先写「当前两个 driver 都不填」，是实现门
   * P3-10 时代的旧状态，与现实相反，已修正。）
   */
  readonly gitMetaDirs?: readonly string[]
}

export type ExternalDirRule = Record<string, 'allow' | 'deny' | 'ask'>
