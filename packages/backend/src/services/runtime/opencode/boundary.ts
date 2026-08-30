// RFC-282 C4 (§2.5) — the OPENCODE-side workspace-boundary synthesis, moved
// verbatim from services/execution/workspaceBoundary.ts. These encode pure
// opencode knowledge: its XDG data layout, machine-level skill discovery
// roots (function comments cite opencode source lines) and the
// external_directory permission-key order discipline (RFC-281 M1). The
// runtime-neutral parts (BoundaryCtx / resolveBoundaryMounts /
// scanSiblingTaskRoots) stay in the unified layer.

import { OPENCODE_PERMISSION_KEYS, type AgentPermission } from '@agent-workflow/shared'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type BoundaryCtx, type ExternalDirRule } from '@/services/execution/workspaceBoundary'

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
  //
  // 2nd impl-gate P2：光靠键序不够。opencode 的配置层用 remeda `mergeDeep`
  // （`config/config.ts:7,42`），而 mergeDeep 对**已存在的键保持 target 原位置**
  // ⇒ worktree 内 `.opencode/opencode.json` 只要先声明一次
  // `agent.<name>.permission.external_directory`（哪怕空对象），就能把平台合成的
  // 整键**抬到作者 `'*'` 之前**，findLast 再取到 `'*': 'allow'` ⇒ 边界溶解
  // （已用 mergeDeep 语义复算确认）。项目配置在 inline 之前合并，所以这是仓库
  // 内容就能做到的。
  //
  // 因此不再依赖键序独占：把作者的顶层 `'*': X` **展开成具体 permission 名**
  // （opencode 已知键集，`core/src/v1/config/permission.ts:17-36`），`'*'` 本身
  // 不再出现 ⇒ 没有任何通配键能压过 external_directory，无论它被抬到哪里。
  // 语义等价：展开后的每个具体键与原 `'*'` 同值。
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(src)) {
    if (key === 'external_directory') continue
    if (key === '*') {
      for (const known of OPENCODE_PERMISSION_KEYS) {
        // 作者若同时写了具体键，具体键在后面原位覆盖（下一轮迭代会写上）
        if (!(known in src)) out[known] = value
      }
      continue
    }
    out[key] = value
  }
  out['external_directory'] = composed
  return out
}

/**
 * opencode 的已知 permission 键（`packages/core/src/v1/config/permission.ts:17-36`
 * @1.18.4，读源非记忆）。`external_directory` 刻意不在这里——它由平台独占，
 * 作者的 `'*'` 展开时绝不覆盖它。
 */
// RFC-348 D5d: the key list moved to `@agent-workflow/shared` (OPENCODE_PERMISSION_KEYS)
// so the intent builder teaches exactly the vocabulary this composer expands.
