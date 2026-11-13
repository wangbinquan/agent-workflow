// RFC-282 C4 (§2.5) — the CLAUDE-side workspace-boundary synthesis, moved
// verbatim from services/execution/workspaceBoundary.ts: sandbox settings
// field shapes, dontAsk rule spellings, host availability probing and the
// author-literal expressibility filter. Behavior is byte-identical; RFC-281's
// behavior locks change import paths only (RFC-282 golden table).

import type { AgentPermission } from '@agent-workflow/shared'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isLexicallyInsideForHost } from '@/util/platformExec'

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
    /**
     * 必须钉 false（第二轮实现门 P1-2，本机 claude 2.1.227 红绿实测）。
     *
     * claude 的 `autoAllowBashIfSandboxed` **默认 true**：sandbox 一开，Bash 调用
     * 就被自动放行、不再过 permission 判定。实测同一 `dontAsk` 节点：带 sandbox
     * ⇒ `cat <兄弟任务>/secret.txt` **读到了**；不带 sandbox（RFC-281 之前）
     * ⇒ 被拒。即「开启边界」反而**放宽**了声明 permission 节点的越界读，方向与
     * 本 RFC 相反，且是未披露的能力扩张。
     *
     * 钉 false 零误伤：bypassPermissions 节点本就不过 permission 层不受影响；
     * dontAsk 节点回到 RFC-281 之前的行为。
     */
    autoAllowBashIfSandboxed: false
    // 刻意**不发** `allowUnsandboxedCommands`（实现门 P1-3）：claude 的 schema 原文
    // 是「false 时 `dangerouslyDisableSandbox` 参数被完全忽略、所有命令必须沙箱化」
    // ——那是模型在 headless 下**唯一**的自救路径。典型 build 节点（`bun install` /
    // `npm ci` / `cargo build` 写 `~/.bun/cache` 等 cwd 外缓存）一旦撞 EPERM，焊死它
    // 就等于让节点烂在那里、无人可救。防误入不需要这一层（真正的写边界是
    // filesystem 默认 cwd+tmp+allowWrite），故沿用上游默认 `true`（§0）。
    filesystem: { allowWrite: string[] }
  }
  permissions?: { additionalDirectories?: string[]; allow?: string[]; deny?: string[] }
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
  /**
   * 兄弟任务的工作区根（`<appHome>/iso`、`<appHome>/worktrees`、`<appHome>/runs`
   * 之下**不属于本任务**的具体目录）。用于 claude 侧的 Edit/Read deny 规则。
   *
   * 为什么需要（第二轮实现门 P1-1，本机 claude 2.1.227 实测复现）：claude 的
   * sandbox 是**命令级**围栏，只管 Bash/子进程；Edit/Write/NotebookEdit 是进程内
   * 工具，只由 `permissions` 层裁决。而未声明 permission 的节点走
   * `bypassPermissions`，把那层整个跳过 ⇒ **默认形态下 Write 工具可以直接写兄弟
   * 任务目录**（RFC 起因的事故形态原样可复现）。
   *
   * 修法实测（用户 2026-08-11 授权「自己决策，前提是绝不影响功能」）：deny 只列
   * 兄弟任务的**具体**目录、绝不含本任务 cwd（T0 §5-2 证明祖先根 deny 会盖死
   * 自己）。实测：越界 Write 被拒、cwd 内 Write 照常。
   */
  readonly siblingTaskRoots?: readonly string[]
}

/**
 * 生成 claude per-run settings。**不含 denyWrite / 不含读面 deny**——见上方
 * 实测说明；写边界由 sandbox 默认承担，平台只把「本任务合法可写目录」加进
 * allowWrite。
 */
export interface ClaudeBoundaryRender {
  settings: ClaudeBoundarySettings
  /**
   * mounts whose PATH cannot be expressed as a gitignore-style rule (see
   * `claudeEditRuleFor`). They still get sandbox `allowWrite` (a plain path
   * list), so writes work in the unconstrained/bypass shape; under `dontAsk`
   * the tool layer may still refuse them — the caller warns rather than
   * emitting a rule that parses wrong.
   */
  unexpressibleDirs: string[]
}

export function composeClaudeBoundarySettings(ctx: ClaudeBoundaryCtx): ClaudeBoundarySettings {
  return renderClaudeBoundary(ctx).settings
}

export function renderClaudeBoundary(ctx: ClaudeBoundaryCtx): ClaudeBoundaryRender {
  const allowWrite = dedupeNonEmpty([
    ...ctx.taskMounts,
    ...(ctx.gitMetaDirs ?? []),
    ...(ctx.authorAllowDirs ?? []),
  ])
  const settings: ClaudeBoundarySettings = {
    sandbox: { enabled: true, autoAllowBashIfSandboxed: false, filesystem: { allowWrite } },
  }
  const unexpressibleDirs: string[] = []
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
      const expressible = dirs.filter(isClaudeRuleExpressible)
      unexpressibleDirs.push(...dirs.filter((d) => !isClaudeRuleExpressible(d)))
      settings.permissions = {
        // additionalDirectories is a plain path list (no glob parsing), so every
        // dir goes here regardless of its characters.
        additionalDirectories: dirs,
        ...(expressible.length > 0 ? { allow: expressible.map(claudeEditRuleFor) } : {}),
      }
    }
  }
  // 兄弟任务目录的 Edit/Read deny —— 覆盖 claude 的**所有** permission-mode
  // （deny 在 bypassPermissions 下同样生效，T0 §5-1 已实测），因此这是默认形态
  // 唯一能挡住 Edit/Write 工具越界的手段。只列具体兄弟目录，不含本任务任何路径。
  const siblings = dedupeNonEmpty([...(ctx.siblingTaskRoots ?? [])]).filter(
    (dir) => !allowWrite.some((own) => isLexicallyInsideForHost(dir, own)),
  )
  const denyable = siblings.filter(isClaudeRuleExpressible)
  unexpressibleDirs.push(...siblings.filter((d) => !isClaudeRuleExpressible(d)))
  if (denyable.length > 0) {
    const deny = denyable.flatMap((dir) => [claudeEditRuleFor(dir), claudeReadRuleFor(dir)])
    settings.permissions = { ...(settings.permissions ?? {}), deny }
  }
  return { settings, unexpressibleDirs }
}

/** 目录 → `Read(//dir/**)`（同 `claudeEditRuleFor` 的路径编码规则）。 */
function claudeReadRuleFor(dir: string): string {
  return `Read(//${dir.replace(/^\/+/, '')}/**)`
}

/**
 * Can this directory be written as a gitignore-style rule body?
 *
 * Rules are `Tool(pattern)` and the pattern is gitignore syntax (official
 * permissions doc). Two hazards, both confirmed by a local probe:
 *  - `)` closes the rule early → the rule parses wrong (silently mis-scoped);
 *  - `*` / `?` / `[` / `]` inside a REAL directory name are read as wildcards →
 *    the rule matches MORE than the directory (a boundary widening).
 * The doc states rules you write yourself are not escaped and documents no
 * escape syntax for `)`, so the platform refuses to guess: such a dir keeps its
 * sandbox `allowWrite` + `additionalDirectories` entry (both plain paths) and
 * the caller warns. §0: never emit a rule whose meaning we cannot predict.
 */
export function isClaudeRuleExpressible(dir: string): boolean {
  return !/[()*?[\]\\]/.test(dir)
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
/** `~/x` 与 `$HOME/x` → 绝对路径（opencode 同口径；claude 自己不展开）。 */
function expandHomePrefix(pattern: string, home: string = homedir()): string {
  if (pattern === '~' || pattern.startsWith('~/')) return join(home, pattern.slice(1))
  if (pattern === '$HOME' || pattern.startsWith('$HOME/')) return join(home, pattern.slice(5))
  return pattern
}

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
    // 2nd impl-gate P3: opencode 会展开 `~/` 与 `$HOME/`
    // （`permission/index.ts:178-184`），claude 不会——原实现把 `~/refrepo` 原样
    // 塞进 allowWrite 与 `Edit(//~/refrepo/**)`，claude 解成 `/~/refrepo`（一个
    // 不存在的路径），而 `lossy` 为空 ⇒ 作者以为跨 runtime 兑现了，实际静默失效。
    // 同口径展开；仍非绝对路径的（`../shared` 之类）进 lossy 走告警面。
    const expanded = expandHomePrefix(trimmed)
    if (!expanded.startsWith('/')) {
      lossy.push(pattern)
      continue
    }
    dirs.push(expanded)
  }
  return { dirs: dedupeNonEmpty(dirs), lossy }
}
