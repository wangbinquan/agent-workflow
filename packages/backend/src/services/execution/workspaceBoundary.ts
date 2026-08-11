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

import type { AgentPermission } from '@agent-workflow/shared'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * opencode 的 XDG data 目录（`Global.Path.data`）。
 *
 * 读源不靠猜：opencode `packages/core/src/global.ts:11` = `path.join(xdgData, 'opencode')`，
 * 而 `xdg-basedir` 的 `xdgData` = `$XDG_DATA_HOME` 或 `~/.local/share`（macOS 同样如此，
 * 该包不按平台分叉）。它下面的 `tool-output/` 存放被截断的工具输出，agent 之后会读回来
 * ——不放行就会在读大文件时踩边界（§0 误伤面）。
 */
export function opencodeDataDir(home: string = homedir()): string {
  const xdgData = process.env['XDG_DATA_HOME']
  const base = xdgData !== undefined && xdgData.length > 0 ? xdgData : join(home, '.local', 'share')
  return join(base, 'opencode')
}

/**
 * opencode 自己会发现的**机器级 skill 根**（实现门 P1-2）。
 *
 * opencode 的 `external_directory` 默认白名单含 `skill.dirs()`（`agent/agent.ts:108-113`
 * @1.18.4），其来源是 home 下的 `.claude` / `.agents` 外部技能根
 * （`skill/index.ts:185-195`，`CLAUDE_EXTERNAL_DIR='.claude'` / `AGENTS_EXTERNAL_DIR='.agents'`）
 * 以及 `ConfigPaths.directories` 的 `{skill,skills}` 目录。平台的 deny 基线合并在
 * defaults **之后**，会把这张白名单一起遮蔽——技能的 SKILL.md 仍会被装进 prompt
 * （配置层读取不过权限），但模型按其指示去读同目录的脚本/参考文件就会被拒，
 * 表现为「技能一半能用一半报错」。
 *
 * 因此按 opencode 的同一口径把这些根 re-allow 回来（只放行，不新增可达面：
 * 这些目录在 RFC-281 之前本就是 allow 的）。
 */
export function machineSkillRoots(home: string = homedir()): string[] {
  const xdgConfig = process.env['XDG_CONFIG_HOME']
  const configBase =
    xdgConfig !== undefined && xdgConfig.length > 0 ? xdgConfig : join(home, '.config')
  return [
    join(home, '.claude', 'skills'),
    join(home, '.agents', 'skills'),
    join(configBase, 'opencode', 'skill'),
    join(configBase, 'opencode', 'skills'),
    join(home, '.opencode', 'skill'),
    join(home, '.opencode', 'skills'),
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
   * **当前两个 driver 都不填**（实现门 P3-10 登记）：T0 §5-6 实测 claude sandbox
   * 对 linked worktree 的共享 `.git` 自动放行，opencode 侧 `git` 走 bash 而非
   * 文件工具、不经 `external_directory`。保留该入口是为「common dir 落在 appHome
   * 缓存克隆 / fusion iso-of-iso」这类尚未实测的布局留兜底——**接线前不要假定
   * 兜底已生效**；真遇到 EPERM/DeniedError 时从 `git rev-parse --git-common-dir`
   * 取值填入即可。
   */
  readonly gitMetaDirs?: readonly string[]
}

type ExternalDirRule = Record<string, 'allow' | 'deny' | 'ask'>

const isAction = (v: unknown): v is 'allow' | 'deny' | 'ask' =>
  v === 'allow' || v === 'deny' || v === 'ask'

/** 目录 → `<dir>/*`（opencode 的 `*` 跨 `/`，一条即覆盖整棵子树）。 */
function boundaryAllowGlobs(ctx: BoundaryCtx): string[] {
  const dirs = [
    ctx.runDir,
    ...ctx.stagedSkillDirs,
    ...ctx.taskMounts,
    ...(ctx.gitMetaDirs ?? []),
  ].filter((d) => d.length > 0)
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of dirs) {
    const glob = `${d.replace(/\/+$/, '')}/*`
    if (!seen.has(glob)) {
      seen.add(glob)
      out.push(glob)
    }
  }
  for (const g of ctx.tmpGlobs) {
    if (g.length > 0 && !seen.has(g)) {
      seen.add(g)
      out.push(g)
    }
  }
  return out
}

/**
 * 把工作区边界合成进一个 agent 的 permission map。
 *
 * 用于两处（同一契约）：顶层 `config.permission`（`author=undefined`，覆盖原生
 * 子代理）与每个业务 agent 条目（`author=agent.permission`）。
 *
 * 规则（键序即优先序，findLast 后者胜）：
 *   external_directory = { '*': 'deny', <boundary allow globs...>, <作者 record 白名单...> }
 * 该键整体追加在作者其他键之后 → 作者 `'*':'allow'` 无法溶解它（E4/M1）。
 *
 * 作者若把 external_directory 写成 scalar（'allow'/'deny'/'ask'）视为显式接管整键，
 * 平台不合成（`'allow'` 等于放弃边界——保存面负责告警，见 design §3.3）。
 */
export function composeOpencodeBoundary(
  author: AgentPermission | undefined,
  ctx: BoundaryCtx,
): AgentPermission {
  const src = author ?? {}
  const authorExt = src['external_directory']

  // 作者 scalar external_directory → 显式接管，原样返回（不注入基线）。
  if (isAction(authorExt)) return { ...src }

  const composed: ExternalDirRule = { '*': 'deny' }
  for (const glob of boundaryAllowGlobs(ctx)) composed[glob] = 'allow'
  // 作者 record 白名单殿后（在 deny 基线之后，findLast 让作者显式 allow 胜）。
  if (authorExt !== null && typeof authorExt === 'object' && !Array.isArray(authorExt)) {
    for (const [pattern, action] of Object.entries(authorExt as Record<string, unknown>)) {
      if (isAction(action)) composed[pattern] = action
    }
  }

  // 保序重建：作者其余键原位，external_directory 作为新键追加到**末尾**。
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(src)) {
    if (key !== 'external_directory') out[key] = value
  }
  out['external_directory'] = composed
  return out
}

// ---------------------------------------------------------------------------
// RFC-281 T2/T3 — claude 侧：per-run settings 的**写**边界
// ---------------------------------------------------------------------------
//
// 与 opencode 的差异（design §2，用户 2026-08-11 拍板接受不对称）：claude 只做
// **写**边界，读面保持默认。载体是 `--settings <file>`（逐键合并层）。
//
// T0 实测定型（design §5-2，两条都是「过度加固会打挂业务」的实证）：
//  - sandbox 默认「写 = cwd + tmp + allowWrite」。生产 appHome 在 home 下（非
//    tmp），所以兄弟任务 worktree 与 appHome 敏感文件的写**默认即被拒**，平台
//    什么都不用加。
//  - `denyWrite` 一旦列 appHome 祖先根，会连 agent **自己的 cwd** 一起盖死
//    （实测：cwd 内 `echo > ./mine.txt` 也 operation not permitted）⇒ 平台
//    **绝不下发 denyWrite**。
//  - 读面若用宽 glob deny（如 `appHome/**`）会误伤自己 cwd，且 allow 挖不回
//    ⇒ v1 不做读面（§0 首要原则：业务不误伤 > 防护强度）。

/** claude per-run settings 的最小形状（只含平台需要钉的键）。 */
export interface ClaudeBoundarySettings {
  sandbox: {
    enabled: true
    // 刻意**不发** `allowUnsandboxedCommands`（实现门 P1-3）：claude 的 schema 原文
    // 是「false 时 `dangerouslyDisableSandbox` 参数被完全忽略、所有命令必须沙箱化」
    // ——那是模型在 headless 下**唯一**的自救路径。典型 build 节点（`bun install` /
    // `npm ci` / `cargo build` 写 `~/.bun/cache` 等 cwd 外缓存）一旦撞 EPERM，焊死它
    // 就等于让节点烂在那里、无人可救。防误入不需要这一层（真正的写边界是
    // filesystem 默认 cwd+tmp+allowWrite），故沿用上游默认 `true`（§0）。
    filesystem: { allowWrite: string[] }
  }
  permissions?: { additionalDirectories: string[]; allow?: string[] }
}

export interface ClaudeBoundaryCtx {
  /** 本任务全部 mount 的绝对路径（cwd 恒在内；单仓 = [cwd]）。 */
  readonly taskMounts: readonly string[]
  /** linked-worktree 的 git 元数据目录兜底（T0 §5-6：claude 通常自动放行）。 */
  readonly gitMetaDirs?: readonly string[]
  /** 作者 external_directory 白名单里可字面表达的目录（§4.3）。 */
  readonly authorAllowDirs?: readonly string[]
  /**
   * 该节点是否声明了 permission（= claude 走 `dontAsk`）。dontAsk 下 cwd 之外
   * 即拒，多仓 mounts 需要 additionalDirectories 才可达（B4 修复）。
   */
  readonly explicitPermission: boolean
}

/**
 * 生成 claude per-run settings。**不含 denyWrite / 不含读面 deny**——见上方
 * 实测说明；写边界由 sandbox 默认承担，平台只把「本任务合法可写目录」加进
 * allowWrite。
 */
export function composeClaudeBoundarySettings(ctx: ClaudeBoundaryCtx): ClaudeBoundarySettings {
  const allowWrite = dedupeNonEmpty([
    ...ctx.taskMounts,
    ...(ctx.gitMetaDirs ?? []),
    ...(ctx.authorAllowDirs ?? []),
  ])
  const settings: ClaudeBoundarySettings = {
    sandbox: { enabled: true, filesystem: { allowWrite } },
  }
  // dontAsk 下 cwd 外的读写都要显式放行，否则多仓任务的其他 mount 够不着
  // （B4：这是能力恢复，不是加固）。未声明 permission 的节点走 bypassPermissions，
  // 本就不受限，不需要这条。
  //
  // 实现门 P1-1 补齐：`additionalDirectories` 只解决**读**——T0 §5-5 实测
  // `dontAsk` + `--tools …,Write` 下写 additionalDirectory 仍报「Write tool access
  // not available in current mode」。写必须由 `permissions.allow` 的
  // `Edit(//<dir>/**)` / `Write(//<dir>/**)` 规则放行（官方对 sandbox
  // `allowWrite` 的描述也是「与 Edit(...) allow 规则合并」，两者本就配套）。
  if (ctx.explicitPermission) {
    const dirs = dedupeNonEmpty([...ctx.taskMounts, ...(ctx.authorAllowDirs ?? [])])
    if (dirs.length > 0) {
      settings.permissions = { additionalDirectories: dirs, allow: dirs.map(claudeEditRuleFor) }
    }
  }
  return settings
}

/**
 * 一个绝对目录 → claude 的 `Edit(...)` allow 规则（官方 permissions 文档核实）：
 *  - **`//` 前缀才是文件系统根**；单个 `/` 是「相对 settings 文件所在处」，
 *    写成 `Edit(/mnt/a/**)` 会被解成 `<项目根>/mnt/a`。故 `/mnt/a` → `//mnt/a/**`
 *    （前缀 `//` + 去掉开头的那个斜杠），**不是** `///mnt/a/**`。
 *  - **只发 `Edit(...)`**：它覆盖所有会改文件的内置工具（含 Write / NotebookEdit）；
 *    单独写 `Write(...)` 规则 claude 会接受但**从不查询**，等于无效行。
 */
function claudeEditRuleFor(dir: string): string {
  return `Edit(//${dir.replace(/^\/+/, '')}/**)`
}

/**
 * claude 自带 sandbox 在**本机**是否可用（§4.4）。
 *
 * macOS 恒有内置 Seatbelt 支持；Linux 需要外部依赖（bwrap + socat），缺了就
 * 只能降级。**判定只用于打告警 + 落观测，不改变 claude 行为、绝不阻断业务**
 * （§0：宁可漏防不可误伤）。
 *
 * 这不是平台自建的隔离机制，也不复用任何已废弃的加固链——只是「上游功能在这
 * 台机器上能不能用」的只读探测。
 */
export function claudeWriteBoundaryAvailability(
  platform: NodeJS.Platform,
  hasExecutable: (name: string) => boolean,
): { available: boolean; reason?: string } {
  if (platform === 'darwin') return { available: true }
  if (platform === 'linux') {
    const missing = ['bwrap', 'socat'].filter((bin) => !hasExecutable(bin))
    if (missing.length === 0) return { available: true }
    return { available: false, reason: `missing-dependencies:${missing.join(',')}` }
  }
  return { available: false, reason: `unsupported-platform:${platform}` }
}

function dedupeNonEmpty(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (p.length === 0) continue
    const normalized = p.length > 1 ? p.replace(/\/+$/, '') : p
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/**
 * 作者 `external_directory` 白名单里能在 claude 上**字面兑现**的目录（§4.3）。
 * 只取 action=allow 且 pattern 是字面目录形（结尾 `/*` 可去掉）的条目；中段带
 * `*`/`?` 的 glob 无法表达 → 调用方负责告警披露粒度损失，不静默丢弃。
 */
export function claudeExpressibleAuthorDirs(author: AgentPermission | undefined): {
  dirs: string[]
  lossy: string[]
} {
  const ext = (author ?? {})['external_directory']
  if (ext === null || typeof ext !== 'object' || Array.isArray(ext)) return { dirs: [], lossy: [] }
  const dirs: string[] = []
  const lossy: string[] = []
  for (const [pattern, action] of Object.entries(ext as Record<string, unknown>)) {
    if (action !== 'allow') continue
    if (pattern === '*') continue // 通配全盘：不是一个可加进 allowWrite 的目录
    const trimmed = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern
    if (trimmed.includes('*') || trimmed.includes('?')) {
      lossy.push(pattern)
      continue
    }
    dirs.push(trimmed)
  }
  return { dirs: dedupeNonEmpty(dirs), lossy }
}
