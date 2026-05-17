# OPENCODE_CONFIG.md — opencode 配置注入路径与优先级（项目权威参考）

> **用途**：固化 `agent-workflow` 框架向 opencode 子进程注入 agent / skill / MCP 三类资源时的**通道选择**与**与现有磁盘配置的优先级关系**。
> **校验依据**：opencode 1.x 源码（本机 `/Users/wangbinquan/Documents/code/opencode/`，所有行号锚点都指向该路径下的源文件）。
> **维护规则**：任何"换通道 / 改优先级 / 加新资源类型"的 RFC 必须先对照本表更新一次，再进入实现。改表的同时跑一遍 `grep` 验证锚点行号没漂。

---

## 1. 注入方式 × 资源类型 总表

列 = 我们能选的注入通道，行 = 资源类型。
单元格内容：**是否使用**｜**载体形态**｜**写入时机**｜**vs 已有同名的胜负**。

| 资源 ＼ 注入方式 | **A. `OPENCODE_CONFIG_CONTENT`**<br/>（env 内联 JSON，整条 config） | **B. `OPENCODE_CONFIG_DIR`**<br/>（env 指向 per-run 目录，opencode 自扫描） | **C. 现成磁盘扫描**<br/>（`~/.config/opencode` + repo `.opencode/` + `~/.opencode/` + `~/.claude/skills/` 等，opencode 自动加载，**不受框架控制**） |
|---|---|---|---|
| **Agent** | ✅ **主通道**<br/>载体：inline JSON 顶层 `agent.<name>: {...}` 字段<br/>时机：spawn opencode 子进程前，runner.ts 写入 env<br/>胜负：**胜**（merge 顺序第 6 步，覆盖所有目录扫描结果，字段级 deep merge） | ⚠️ **可用但不主用**<br/>opencode 也会扫 `<runDir>/opencode.json` 的 `agent:` 字段（`config.ts:583-590`），但同 inline 路径会重复管理，徒增复杂度。**我们目前不用** | ✅ **自然继承**<br/>路径：`~/.config/opencode/{config,opencode}.json`、repo `.opencode/agent/*.md`、`~/.opencode/agent/*.md`<br/>胜负：**我们的 inline 永远后写、字段级胜出**；非同名 agent 共存 |
| **Skill** | ⚠️ **不可用**（opencode 配置文件无 skill 内联字段，只能在 `skills.paths` / `skills.urls` 列路径或 URL） | ✅ **主通道**<br/>载体：物理 cp/symlink SKILL.md 到 `<runDir>/skills/<name>/SKILL.md`（runner.ts:481-497）<br/>时机：spawn 前<br/>胜负：**胜**（runDir 是 `config.directories()` 数组末尾元素 `paths.ts:39`，skill 扫描后写入覆盖同名 `skill/index.ts:116-122`） | ✅ **自然继承**<br/>路径：`{Global,~/.opencode,repo .opencode}/skill(s)/**/SKILL.md` + `~/.claude/skills/**` + `~/.agents/skills/**` + `cfg.skills.{paths,urls}`<br/>胜负：**我们的 runDir 后扫胜出**；非同名 skill 共存（repo 内业务 skill 仍被 agent 看到，故意保留） |
| **MCP** | ✅ **唯一通道**<br/>载体：inline JSON 顶层 `mcp.<name>: {...}` 字段<br/>时机：spawn 前（RFC-028 待实现）<br/>胜负：**胜**（同 agent 路径，第 6 步 deep merge） | ❌ **不可用**<br/>opencode **没有** `.opencode/mcp/` 目录扫描机制（mcp 只能来自配置文件顶层 `mcp:` 字段，没有 markdown / 目录形态） | ✅ **自然继承**<br/>路径：`~/.config/opencode/config.json` + repo `.opencode/opencode.json` 的 `mcp:` 段<br/>胜负：**我们的 inline 后写胜出**；非同名 MCP 共存（user repo 里其它 MCP 仍会启动，process-global 暴露给所有 agent） |

### 1.1 表格速记

- **只有一种 / 主用通道**：Agent → A、Skill → B、MCP → A。
- **A 与 B 都是我们注入的"最后一层"**：写入时机均晚于所有磁盘扫描，遇同名永远胜出。
- **C 列是我们不控的"基线层"**：故意保留，让用户的全局 / repo 资源仍能被 agent 自然看到（除非同名被我们 shadow）。

---

## 2. opencode 完整加载顺序（决定优先级的根因）

`config.ts:472-707` `loadInstanceState` 的实际代码顺序，**后写胜出**（`mergeConfigConcatArrays` / `mergeDeep` 语义，`config.ts:48,52`）：

```
1. 远端 well-known 配置（仅当 auth.json 有 wellknown 条目；通常无）             config.ts:513-553
2. 全局 ~/.config/opencode/{config,opencode}.json/jsonc                       config.ts:417-419
3. OPENCODE_CONFIG（单文件指针 env；我们不用）                                  config.ts:558-561
4. 项目链（!OPENCODE_DISABLE_PROJECT_CONFIG 时）：
   afs.up({ targets: ["opencode.json","opencode.jsonc"], start: cwd,
            stop: worktree }).toReversed()
   — 越靠近 cwd 越晚写、越胜出                                                config.ts:563-567 + paths.ts:10-21
5. 目录扫描 config.directories():                                              config.ts:573-625 + paths.ts:23-41
     a. Global.Path.config (~/.config/opencode)
     b. !OPENCODE_DISABLE_PROJECT_CONFIG 时：afs.up(.opencode) cwd→worktree
     c. afs.up(.opencode) home→home（用户 home 链）
     d. OPENCODE_CONFIG_DIR (我们的 runDir，append 在最末)
   每个 dir 都会跑：
     - 加载 opencode.{json,jsonc}（agent / mcp 字段也在这）
     - ConfigAgent.load(dir)（扫 {agent,agents}/**/*.md）
     - ConfigCommand.load(dir) / ConfigPlugin.load(dir)
6. OPENCODE_CONFIG_CONTENT（我们的 inline JSON）                                config.ts:627-635
7. 账号 org config（仅当 auth 里有 active_org_id；通常无）                       config.ts:637-674
8. macOS MDM managed preferences（仅企业部署；通常无）                          config.ts:676-696
9. OPENCODE_PERMISSION（permission map 末次覆盖）                              config.ts:706
```

**核心结论**：`agent-workflow` 注入的两路写入点在第 5(d) 与第 6 步，永远后于 1–5(c) 的任何磁盘扫描；只有第 7、8 两个企业部署场景能压过我们，普通开发者环境可忽略。

---

## 3. 三类资源的策略与设计取舍

### 3.1 Agent —— inline JSON（A 通道）

- **为什么不走 B（OPENCODE_CONFIG_DIR）**：A 通道在第 6 步深合并，比目录扫描第 5(d) 更晚写、字段级胜出；inline 也方便闭包合并多个 dependsOn agent（RFC-022 已落地，`runner.ts:531-545 buildInlineConfig`）。
- **合并语义**：`mergeDeep` —— inline 同字段胜出，未覆盖字段保留磁盘扫描值。要完全 shadow 同名 agent，inline 必须把所有相关字段都写明。
- **进程级作用域**：inline 注入的 dependsOn 闭包内每个 agent 都被 opencode 视为可用 subagent（`agent.ts` 的 task 工具会查询 `cfg.agent` map）。

### 3.2 Skill —— per-run 目录（B 通道）

- **为什么不走 A**：opencode 配置 schema 里没有 `skills.<name>: {bodyMd, files...}` 这种内联形态；skill 必须以"文件系统目录 + SKILL.md"形态存在。
- **runDir 末尾扫描**：`paths.ts:39` 把 `Flag.OPENCODE_CONFIG_DIR` 追加在 `config.directories()` 数组末尾；`skill/index.ts:195-198` 按数组顺序扫描，`skill/index.ts:116-122` 同名后扫到的覆盖前者（只 log warn 不报错）。
- **managed vs external**：
  - managed → `cpSync` 复制（避免用户改动 ~/.agent-workflow/skills/<name>/ 时影响正在跑的 task）
  - external → `symlinkSync(externalPath, runDir/skills/<name>, 'dir')`（不复制，IO 经济）
- **不屏蔽 inherited skill**：repo `.opencode/skills/` 与 `~/.claude/skills/` / `~/.agents/skills/` 里**非同名**的 skill 仍被 agent 看到，**故意保留**（让用户能在 repo 里自带业务 skill；与 RFC-017 source-dir 模式自洽）。

### 3.3 MCP —— inline JSON（A 通道，RFC-028 提议）

- **为什么不走 B**：opencode 没有 `.opencode/mcp/` 目录扫描机制（`mcp/index.ts:513-549` 只从 `cfg.mcp` 顶层 record 读取）；MCP 必须以"配置文件 `mcp:` 顶层字段"形态存在。可选的间接路径是把 `mcp:` 写进 `<runDir>/opencode.json` 让目录扫描捡到 —— 但效果与 inline 等价、还多一个文件 IO 步骤，**不选**。
- **opencode 进程内 MCP 是全局的**（`mcp/index.ts:524-549` 启动时全量 spawn，工具池暴露给该进程内**所有** agent）。框架层"agent X 依赖 MCP Y"语义由**每节点一个独立 opencode 子进程**承担（runner 的 spawn 隔离），不是靠 opencode 内部 scope。
- **字段名翻译**（必须按 opencode 端命名写 inline）：
  - Local：`type:"local"`, `command: string[]`, `environment?: Record<string,string>`（注意不是 `env`）, `enabled?: boolean`, `timeout?: number`（毫秒，不是 `timeoutMs`）。**无 `cwd` 字段**（mcp/index.ts:417 取 `InstanceState.directory` 作 stdio 子进程 cwd）。
  - Remote：`type:"remote"`, `url: string`, `headers?: Record<string,string>`, `oauth?: object | false`, `enabled?: boolean`, `timeout?: number`。
- **工具命名**：`mcp/index.ts:684` `${sanitize(mcpName)}_${sanitize(toolName)}`，`sanitize = s => s.replace(/[^a-zA-Z0-9_-]/g, "_")`。我们的 MCP name regex `^[a-z0-9][a-z0-9_-]*$` 全部命中白名单 → 名字在 opencode 工具池里保持不变。用户在 `agent.permission` 里点名某工具写法：`permission: { "postgres-prod_query": "ask" }`。
- **shadow inherited MCP**：opencode schema 接受 `mcp.<name> = { enabled: false }` 半结构（`config.ts:211-215`），可用来逐条关闭 repo 已有的同名 MCP。RFC-028 v1 不实现这个屏蔽语义，但 schema 与代码都预留好了。

---

## 4. 优先级速查 —— "已有 X 的情况下，我们注入 Y 会怎样"

| 已有位置 | 同名时 | 不同名时 |
|---|---|---|
| `~/.config/opencode/config.json` 的 `agent.<X>` / `mcp.<X>` | **我们 inline 胜出**（字段级 deep merge，未覆盖字段保留） | 都生效，opencode 看合集 |
| `~/.opencode/agent/*.md` / `~/.opencode/skills/<X>` | **我们 inline / runDir 胜出** | 都生效 |
| `<repo>/.opencode/opencode.json` 的 `agent.<X>` / `mcp.<X>` | **我们 inline 胜出** | 都生效 |
| `<repo>/.opencode/agent/*.md` | **我们 inline 胜出** | 都生效 |
| `<repo>/.opencode/skills/<X>/SKILL.md` | **我们 runDir 胜出**（runDir 在 directories 末尾，scan 顺序最后） | 都生效（repo 业务 skill 仍被 agent 看到 —— 设计保留） |
| `~/.claude/skills/**/SKILL.md`（claude code 互通） | 我们 runDir 胜出 | 都生效 |
| `~/.agents/skills/**/SKILL.md` | 我们 runDir 胜出 | 都生效 |
| Anthropic 远端 org-managed config（auth.json `wellknown` + active_org_id） | ⚠️ **它胜过我们**（`config.ts:637-674` 在 inline 之后写入） | — |
| macOS MDM `.mobileconfig` managed preferences | ⚠️ **它胜过我们**（`config.ts:687-696` 也在 inline 之后） | — |

最后两行属企业部署场景，绝大多数用户环境为空。RFC 文档里出现"我们 100% 胜出"的简写时，默认排除这两个边角。

---

## 5. spawn 时的 env 写入清单（runner.ts 实际形态）

```ts
// packages/backend/src/services/runner.ts:249-262
const env: Record<string, string> = {
  ...process.env,
  OPENCODE_CONFIG_DIR: runDir,                       // → 第 5(d) 步目录扫描捡 skills + opencode.json
  OPENCODE_CONFIG_CONTENT: JSON.stringify(inline),   // → 第 6 步 inline JSON 覆盖性合并
  // 不设：OPENCODE_DISABLE_PROJECT_CONFIG / OPENCODE_DISABLE_EXTERNAL_SKILLS / OPENCODE_PERMISSION
  // —— 故意保留 repo .opencode/ 与 ~/.opencode/ 的自然继承
}

// runDir 物理布局
// ~/.agent-workflow/runs/<taskId>/<nodeRunId>/.opencode/
//   skills/
//     <skill-name-1>/SKILL.md  (cp or symlink)
//     <skill-name-2>/SKILL.md
//     ...

// inline JSON 形态（RFC-022 现状 + RFC-028 落地后）
{
  "agent": {
    "<primary-agent>": { ...frontmatter, prompt: bodyMd, ...overrides },
    "<dependsOn-1>":    { ...frontmatter, prompt: bodyMd },
    "<dependsOn-2>":    { ...frontmatter, prompt: bodyMd },
    ...
  },
  "mcp": {                       // RFC-028 待落地
    "<mcp-name-1>": { type: "local",  command: [...], environment: {...}, timeout: 5000 },
    "<mcp-name-2>": { type: "remote", url: "...", headers: {...} },
    ...
  }
}
```

cwd 为 `<worktree>`（保留 git diff 自然行为，opencode 端 `InstanceState.directory` 也由此而来）。

---

## 6. 边角与坑

1. **`mergeDeep` 对数组的行为**：`remeda.mergeDeep` 把数组视作"叶值"整体替换，不做元素级 merge。所以 `command: [...]` / `headers.X: ["a","b"]` 这种数组**不会与 repo 同字段拼接**，inline 完全胜出。`tools` / `permission` 是 record 不是 array，正常深合并。
2. **plugins / commands 不在本表范围**：`commands` / `plugins` 也是按目录扫描的，但我们框架目前不主动注入；它们仍按 §2 的 1–5 步从用户环境加载。
3. **`opencode --session` resume**：RFC-026 inline-session 重跑时**仍会重新跑 §2 全套加载**（opencode 不缓存上次 config）；inline 不变 → 行为不变。
4. **dependsOn 闭包之外的 agent**：如果 opencode 进程通过 `task` 工具想 spawn 一个 inline 没注入、磁盘上也没有的 agent，会直接 fail；这就是 RFC-022 闭包验证存在的原因（避免运行期才发现）。
5. **MCP 失败不阻塞 agent**：`mcp/index.ts:412-444` 的 `connectLocal` 失败只把该 MCP status=failed，agent 继续无 MCP 运行 —— **不会让 node 失败**。要"MCP 失败即 node 失败"的策略要在框架层加二次校验。
6. **OAuth token 持久化路径不在 runDir**：Remote MCP 的 OAuth token 落 `~/.opencode/auth/`（`McpAuth.Service`），跨子进程共享、跨 task 共享。我们的 per-run 隔离**不隔 OAuth**，这是有意的（让用户 `opencode mcp auth <name>` 一次后所有 task 都能用）。

---

## 7. 参考文件锚点（opencode 1.x 源码）

| 主题 | 文件 | 关键行 |
|---|---|---|
| config 加载主入口 | `packages/opencode/src/config/config.ts` | `loadInstanceState` 472-707 |
| mergeConfig / mergeDeep 实现 | `packages/opencode/src/config/config.ts` | 48-56 |
| OPENCODE_CONFIG_CONTENT 注入点 | `packages/opencode/src/config/config.ts` | 627-635 |
| `config.directories()` 顺序 | `packages/opencode/src/config/paths.ts` | 23-41 |
| `config.files()` 顺序 | `packages/opencode/src/config/paths.ts` | 10-21 |
| Agent schema | `packages/opencode/src/config/agent.ts` | 22-51 |
| Agent 目录扫描 | `packages/opencode/src/config/agent.ts` | `load()` 107-137 |
| Skill 发现 | `packages/opencode/src/skill/index.ts` | `discoverSkills` 163-223 |
| Skill 同名覆盖 | `packages/opencode/src/skill/index.ts` | `add()` 94-131 |
| MCP schema | `packages/opencode/src/config/mcp.ts` | 全文 |
| MCP 启动 / 工具暴露 | `packages/opencode/src/mcp/index.ts` | 412-549 / 657-690 |
| MCP 工具命名 | `packages/opencode/src/mcp/index.ts` | 684（`sanitize_` + `_sanitize`） |

我方关键代码：

| 主题 | 文件 | 关键函数 / 行 |
|---|---|---|
| spawn 主流程 | `packages/backend/src/services/runner.ts` | `runNode` 184-260 |
| inline JSON 构造 | `packages/backend/src/services/runner.ts` | `buildInlineConfig` 531-545 |
| skill cp/symlink | `packages/backend/src/services/runner.ts` | `prepareSkills` 481-497 |
| dependsOn 闭包 | `packages/backend/src/services/agentDeps.ts` | `computeClosure` |
| MCP 闭包（RFC-028 待加） | `packages/backend/src/services/mcpClosure.ts` | TBD |

---

## 8. 何时需要更新本文档

只要满足下列任一条件，**就必须先改本文档再改实现**：

- 新增一个不在 §1 表格里的资源类型（如 commands / plugins / formatter）需要被框架注入。
- 改了 `runner.ts` 的 spawn env 集合（增删任一 `OPENCODE_*` 环境变量）。
- opencode 升级到一个改动 `loadInstanceState` 顺序、或新增 `mergeXxx` 函数行为的版本 —— 必须重新跑一遍 §7 锚点 verify。
- 决定开启 / 关闭 `OPENCODE_DISABLE_PROJECT_CONFIG` 或类似 disable flag（会改 §2 第 4-5 步行为）。
- RFC 引入"屏蔽 inherited X"语义（如 inline 写 `{enabled:false}` 关闭 repo MCP），需要在 §3 / §4 加新条目。

每次 verify 完成后，把 §7 锚点行号刷新一遍并在 commit message 注明 "verified against opencode <version> at <sha>"。
