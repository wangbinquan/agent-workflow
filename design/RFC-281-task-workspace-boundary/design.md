# RFC-281 · 技术设计

> 阅读前提：`proposal.md`。opencode 行为断言均已按本机 checkout（1.18.4，`packages/core` + `packages/opencode`）读源核实并给出 file:line；claude 行为断言来自官方文档（code.claude.com/docs/en/{permissions,sandboxing,settings,permission-modes}.md），其中四项标注为「实现期必测」（§5）——按 `docs/dev-gotchas.md` 规则，接手复核时先重跑源引用再动代码。

## 1. 机制盘点（现状）

### 1.1 opencode（1.18.4）

- 权限 schema：`Action = ask|allow|deny`；`Rule = Action | Record<pattern, Action>`（opencode core `v1/config/permission.ts:5,8-12`）。已知键含 `external_directory`（`:17-36`）。
- **`external_directory` 是唯一的路径级权限键**：任何文件工具触碰 `containsPath` 之外的路径（cwd + 当前 git worktree 根，`project/instance-context.ts:18-24`）都会以「目标目录的绝对路径 glob」发起一次该键的权限判定（`tool/external-directory.ts:15-45`）。调用点覆盖 read/write/edit/apply_patch/glob/grep/lsp/shell（含 `workdir` 参数与 cd 类命令）。
- 规则求值：全部规则 flatten 后 **findLast 匹配者胜**（`permission/index.ts:28-38`）；`deny` 在发起 ask 之前**短路**（`:75-79`），因此 `--auto` 无法翻转 deny——这正是 RFC-276 AC-5 锁定的语义。
- 默认值：`external_directory: { "*": "ask", …whitelistedDirs→allow }`，whitelist 含 skill/reference 目录、`$TMPDIR/opencode/*`、tool-output 目录（`agent/agent.ts:108-136`）；用户/agent 配置在 defaults **之后**合并（`:138,151,293`），tool-output glob 在最终步再补一次 allow（`:296-309`）。
- headless：`opencode run` 无 `--auto` 时 ask→自动 reject；有 `--auto` 时 ask→自动 approve（`cli/cmd/run.ts:796-816`）。平台无条件传 `--auto`（本仓 `runtime/opencode/spawn.ts:94-109`）。
- 匹配陷阱：pattern 的 `*` 编译为跨 `/` 的 `.*`（core `util/wildcard.ts:3-14`），`~`/`$HOME` 前缀在 fromConfig 展开（`permission/index.ts:178-184`）。
- 子 agent 继承的真实语义（设计门 F1 纠正）：`deriveSubagentSessionPermission` 只把**父 session 级**的 `external_directory` 规则与 deny 规则传给 task 子会话（`agent/subagent-permissions.ts:14-27`），而 session 级规则仅来自 prompt 入参（`session/prompt.ts:1060-1067`）——**agent 条目级的 permission 不在其中**。子会话用的是子 agent 自己的定义（原生 `general`/`explore` 的 permission = defaults + 全局 `config.permission` + 其自身条目）。⇒ 只写在业务 agent 条目上的边界**够不着原生子代理**；边界必须同时落在**顶层 `config.permission`**（§3.1）。
- 已知洞：bash 只扫 12 个白名单命令的参数（`tool/shell.ts:28-50`），重定向节点被跳过（`:99`）、含 `$` 的参数放弃解析（`:174-179,372`）；`containsPath` 纯词法不 realpath（core `fs-util.ts:270-273`）。

### 1.2 claude code

- 文件工具路径规则：`permissions.allow/ask/deny` 支持 `//abs`、`~/`、相对等前缀；deny 在各配置层合并后最高优先；覆盖 Read/Edit/Write/Glob/Grep 与 Bash 中可识别的文件命令（cat/sed/head 等），**不覆盖任意子进程**。
- `dontAsk` 模式：cwd 内读自动放行；cwd 外与写操作仅显式 allow 者放行——平台声明 permission 的节点已在该模式（`runtime/claudeCode/spawn.ts:97-106`）。
- claude 自带 sandbox（settings `sandbox` 键）：macOS Seatbelt 内置；Linux 需 bubblewrap+socat。文件系统默认「写=cwd+tmp、读=全盘（凭据目录除外）」，支持 `filesystem.allowWrite/denyRead/denyWrite`；**对整个进程树（含 Bash 子进程）强制，且 `bypassPermissions` 下仍生效**。`failIfUnavailable`、`allowUnsandboxedCommands` 可控降级。
- 注入载体：`--settings <file>`（CLI 层，优先级高于项目/用户配置）；`--add-dir` / `permissions.additionalDirectories` 扩工作目录集。
- 平台现状：未声明 permission → `['--permission-mode','bypassPermissions']`（`claudeCode/spawn.ts:126`）；`external_directory` 在 permissionMap 中映射为空（`permissionMap.ts:58-59,74`）。

## 2. 边界模型

一次业务节点 run 的**合法工作区集合** `W(run)`：

| 成员 | 来源 | 备注 |
| --- | --- | --- |
| run cwd | `opts.worktreePath`（iso worktree 或 task worktree，`runner.ts:1005`） | opencode 的 containsPath 天然包含 cwd+其 worktree 根 |
| 本任务全部 mounts | scheduler 的 iso handle / task 多仓成员 | 多仓任务的其他成员目录；单仓任务为空集 |
| 本次 run 注入资源 | runDir（`runs/{taskId}/{nodeRunId}`）、staged skill 目录（含 sibling 文件） | opencode 需 read 它们；claude 的 skills 走 config dir 由 CLI 自读。**opencode 项目配置的 `references` 外部目录不在此列**——被基线遮蔽，归作者白名单（用户拍板 2026-08-11，设计门 F5；平台不解析 opencode 配置、不自动放行） |
| 临时目录 | `$TMPDIR/opencode/*`、tool-output 目录、claude 会话 tmp | opencode defaults 原样恢复；claude sandbox 默认含 |
| **git 元数据目录**（设计门 F4 补） | 每个 mount 的 `git rev-parse --git-common-dir` / linked-worktree admin 目录（`.git/worktrees/<id>`），取自 daemon 既有 git 结构 | iso/task worktree 是 linked worktree，`git add/commit` 要写 cwd 之外的 admin 目录与共享 `objects`；claude 官方文档称 sandbox 对 git worktree 共享 `.git` 有自动放行（§5-6 必测证实），不足则显式入 `allowWrite`；`denyWrite <appHome>` 的挖洞集合同步纳入（common dir 多在 appHome 的 `repos/` 缓存克隆内） |
| 作者白名单 | `agent.permission.external_directory` 中 action=allow 的 pattern | 跨 runtime 兑现（§3.3 / §4.3） |

**拒绝面按 runtime 如实分述（设计门 F6，用户 2026-08-11 确认接受不对称）**：

- **opencode**：文件工具对 W(run) 之外的**读与写**全部拒绝（`external_directory` 基线）。
- **claude**：**写面**全拒（sandbox 默认写=cwd+tmp，含 Bash 子进程）+ **读面**仅拒敏感清单（denyRead；默认读全盘保持——claude 工具链需要读系统库/全局工具，全域读拦在防误入定位下性价比差）。

两侧共同的重点覆盖：兄弟任务 worktree/iso、`~/.agent-workflow` 敏感文件（`db.sqlite*`、`secret.key`、`token`、`config.json`、`backups/`、其他任务 `runs/`）。

裁决行为：**工具级报错、run 继续**。opencode 给 DeniedError 文案（core `v1/permission.ts:24-26`）；claude sandbox 给 EPERM 类错误。不 fail 节点、不产生新任务状态。

## 3. opencode 渲染契约

### 3.1 合成点：两级注入

改动点在统一注入层 `services/execution/agentInjection.ts`（RFC-280 T1 建成），边界注入**两级**：

- **顶层 `OPENCODE_CONFIG_CONTENT.permission.external_directory`**（新增）：deny 基线 + 平台 re-allow 清单。全局 permission 参与**每个** agent 的合并（`agent/agent.ts` defaults → config.permission → agent 条目），因此原生 `general`/`explore` 子代理、dependsOn 闭包成员一并被覆盖（设计门 F1 的修复：agent 条目级注入够不着原生子代理，见 §1.1）。附带收益：原生子代理越界从「external_directory ask 悬挂或被 auto 放行」变为立即 DeniedError。
- **业务 agent 条目级**：仅当作者声明了 `external_directory` 时合成（作者条目殿后于顶层基线——agent 级在全局之后合并，作者显式白名单因此对自己的 agent 生效）。

新增纯函数：

```ts
composeOpencodeBoundary(author: AgentPermission | undefined, ctx: BoundaryCtx): AgentPermission
// ctx = { taskMounts: string[], runDir: string, stagedSkillDirs: string[], tmpGlobs: string[] }
```

产出 `permission.external_directory` 的合成规则，**键序即规则序**（findLast 语义下后者胜）：

```jsonc
{
  "*": "deny",                       // ① 平台基线
  "<runDir>/*": "allow",             // ② 平台 re-allow：run 注入资源
  "<stagedSkillDir>/*": "allow",
  "<tmpdir>/opencode/*": "allow",
  "<mountA>/*": "allow",             // ③ 本任务其他 mounts
  "...author entries..."             // ④ 作者条目原样殿后（显式声明最高）
}
```

**键位纪律（RFC-251 已踩过的坑，`docs/dev-gotchas.md` §permission 追加定式）**：opencode 按**键序**flatten 规则再 findLast（`permission/index.ts:28-34`），而 JS 对已存在键重新赋值**不移动键位**。因此合成时必须：从作者 map 中**删除** `external_directory` 原键位，把合成后的整键**追加到 permission 记录末尾**——保证它排在作者顶层 `'*'` 通配键之后（作者 `'*': 'allow'` 是 opencode「allow-unless-denied」世界的常用写法，不得让它顺带溶解边界；只有作者**显式的** `external_directory` 条目才有放宽权，它们在合成键内部殿后）。判据测试必须**断言下标序**（边界键下标 > 作者 `'*'` 下标；作者 external_directory 条目下标 > 基线下标），光比对最终值看不出键位 bug。

- 作者写了 **scalar**（`external_directory: "allow" | "deny"`）→ 作者接管整键，平台不合成（显式声明优先；`"ask"` 在 `--auto` 下等效 allow，保存时告警，见 §3.3）。
- 作者未声明该键 → 只有 ①②③。
- agent.permission 的其余键继续 verbatim 透传，`renderOpencodeAgentEntry:201-203` 的 RFC-276 注释同步改写（本 RFC 对其的显式修订）。
- dependsOn 闭包：dependent 的 agent entry 同样经 `composeOpencodeBoundary`（上游还会把父会话 external_directory/deny 下传，双保险，`subagent-permissions.ts:21-23`）。

### 3.2 与 opencode 默认值的相互作用（易错点）

- 平台 `"*": "deny"` 位于 agent 级 permission，merge 在 defaults 之后 → **会遮蔽** defaults 里的 skill/tmp 白名单（findLast）。因此 ② 的 re-allow 是必需项，清单以「本次 run 实际 stage 的目录」为准，不抄 opencode 的推导逻辑。tool-output glob 由 opencode 在最终步自行 re-add（`agent.ts:296-309`），无需平台重复，但测试要锁「边界开启后 tool-output 仍可写」防上游改序。
- 顶层通配 `'*'` 键（作者 permission 里的 `'*': 'allow'`）与具体键的 flatten 顺序属实现期必测（§5-4）：若实测发现通配后置会盖掉 external_directory 基线，合成需相应调整插入位置。
- **配置来源合并顺序（已按 1.18.4 源码核实，`config/config.ts:396-535`）**：global → `OPENCODE_CONFIG` → 项目文件 → plugins → **`OPENCODE_CONFIG_CONTENT`（平台注入）** → active-org 远端配置 → managed 目录 → MDM managed preferences（"override everything"）。⇒ ①worktree 内 `opencode.json` 在 inline **之前**合并，**不能**反向放宽边界（原稿 §5-4 的担忧不成立，无需 `OPENCODE_DISABLE_PROJECT_CONFIG`）；②org/managed/MDM 在 inline **之后**合并，**可以**放宽——这是管理员/组织拥有的机器面（处置见 proposal 能力影响清单 B8）。
- pattern `*` 跨 `/`：所有平台生成的 allow 用 `<dir>/*` 形状即可覆盖整棵子树；**不要**试图表达「仅一层」。

### 3.3 作者白名单语义（保存面）

- 校验落点：agent 保存路径已有 permission 透传校验（`shared/schemas/agent.ts:196-198` 开放 record 不变）。新增**保存时告警**（不阻断）：`external_directory` 值为 `ask`（headless+`--auto` 下无意义）、scalar `allow`（放弃整个边界）时提示。
- 平台不改写作者条目、不持久化合成结果——合成只发生在 spawn 时渲染，DB 里永远是作者原文。

## 4. claude 渲染契约

### 4.1 载体：per-run settings 文件

`buildClaudeSpawn`（`claudeCode/spawn.ts:108-151`）新增：在 `attemptDir` 落 `settings.json`（与 `system.md` 同模式），argv 追加 `--settings <file>`。`CLAUDE_PLATFORM_OWNED_FLAGS`（`:52-76`）补 `--settings`、`--add-dir`、`--allow-dir`（如上游有别名，实现期以 `claude --help` 为准）。

settings 内容（两类节点共用骨架）：

```jsonc
{
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "filesystem": {
      "allowWrite": ["<mountA>", "<mountB>", "<作者白名单目录>"],
      "denyRead": ["<appHome 敏感清单>"],
      "denyWrite": ["<appHome>"]
    }
  },
  "permissions": {
    "deny": ["Read(//<appHome>/worktrees/**)", "Edit(//<appHome>/**)", "Write(//<appHome>/**)", …],
    "additionalDirectories": ["<mountA>", "<作者白名单目录>"]
  }
}
```

> 写边界主体由 sandbox 默认「写=cwd+tmp」承担；`allowWrite` 只加本任务 mounts 与作者白名单。deny 列表**不含**本任务自己的 worktree/iso/runDir——生成器负责从敏感清单中挖去自身路径（见 §7 失败模式 F2）。`permissions.deny` 的路径规则同时挡 dontAsk 与（若实测有效）bypassPermissions 下的文件工具与可识别 bash 文件命令，作为 sandbox 之上/之外的第二层。

**键面钉死（设计门 F3）**：`--settings` 是**逐键合并**层，不是封闭替换层——project/user/managed settings 仍然加载，per-run 文件未声明的键保留低层值，数组键还可能跨层合并（官方 settings 文档）。因此 per-run settings 必须**显式钉死全部安全相关键**：`sandbox.enabled`、`allowUnsandboxedCommands: false`、`excludedCommands: []`、`filesystem` 全三表、`network` 默认、`permissions.additionalDirectories` 完整值。§5-8 必测「CLI 层对这些键（尤其数组键）是覆盖还是拼接」；若数组键实测为拼接且无法覆盖，worktree 内 `.claude/settings.json` 即构成一条**仓库内容级的放宽面**，与 opencode 的 org/managed 面同归 B8 披露，不静默。未来新增的未知安全键无法预钉——同样落入 B8 残留清单。

### 4.2 两类节点

- **未声明 permission（今天 `bypassPermissions`）**：argv 与工具面完全不动，仅新增 `--settings`。sandbox 承担边界（bypassPermissions 下仍强制）。
- **声明 permission（今天 `dontAsk` + `--tools`）**：同样注入 settings；另把本任务其他 mounts 与作者白名单目录写入 `permissions.additionalDirectories`（修复 B4：dontAsk 下 cwd 外即拒导致多仓 mounts 不可达）。工具载入集映射（RFC-242 permissionMap）零变化。

### 4.3 作者白名单在 claude 的兑现

`external_directory` 中 action=allow 的 pattern：

- **字面目录形**（`/abs/dir`、`/abs/dir/*`、`~/dir/*`——无 `*`/`?` 于中段）→ 目录加入 `additionalDirectories` + `sandbox.filesystem.allowWrite`（读写语义对齐 opencode「allowed 目录继承 workspace 同等默认」）。
- **非字面 glob**（如 `/a/*/b`）→ 无法表达，保存时告警粒度损失（延续 `permissionMap.ts` 的披露风格；不静默丢弃）。
- scalar `allow` → claude 侧等效「不启用文件系统边界」（sandbox 保持 enabled 但 filesystem 不加 deny？不——为语义一致，scalar allow 时 claude 侧**不注入 filesystem deny/额外 allow，只保留 sandbox 默认**并告警：cwd 外写仍受 sandbox 默认限制，与 opencode 的完全放开存在不可消除的形状差，必须披露）。

### 4.4 可用性与降级阶梯（B3）

1. sandbox 可用（macOS；Linux 有 bubblewrap+socat）→ 全量边界。
2. sandbox 不可用 → settings 仅保留 `permissions.deny` + `additionalDirectories`；若实测证明 deny 在 bypassPermissions 下**不**生效（§5-1），未声明节点降为第 3 级。
3. 无可用机制 → 结构化告警日志（每 run 一条，含原因），行为与今天一致。

探测方式：不自建探测器——`sandbox.enabled=true` + `failIfUnavailable: false` 时 claude 自行降级；平台从 stream-json init/事件面读取实际状态（实现期核实事件形状，§5-3），据此打告警。**不引入平台自己的 OS 能力探测代码**。

## 5. 实现期必测清单（不测不合）

1. `permissions.deny` 路径规则在 `--permission-mode bypassPermissions` 下是否生效（官方文档未直陈；决定 §4.4 阶梯第 2 级对未声明节点的形态）。
2. `sandbox.filesystem` allow/deny 同路径重叠时的优先级（决定敏感清单是「denyRead appHome 根 + allow 挖洞」还是「逐项列敏感子路径」）。
3. `--settings` 与 `-p` stream-json 的组合、sandbox 降级状态在事件流里的可观测形状（claude 2.1.x 实测）。
4. opencode 顶层 `'*'` 通配键与具体键 flatten 后的先后（§3.2）；顶层 `config.permission` 边界对**原生子代理**（`general`/`explore`）会话的实效（真 runtime：业务 agent 派生 task 子代理读兄弟目录 → DeniedError 而非悬挂/放行）。项目配置的 merge 先后已按源码核实为 inline 之前（§3.2），改为一条源码引用回归锁即可，无需行为实验。
5. `--add-dir` / `additionalDirectories` 在 headless -p 下的实效（read+edit 是否等同 cwd 待遇）；以及作者白名单目录经 `sandbox.filesystem.allowWrite` 的**写**实效（Bash `echo > 白名单目录/文件` 成功，设计门 F9）。
6. claude sandbox 对 git linked-worktree 共享 `.git`/admin 目录的自动放行是否覆盖本仓 iso 布局（`git add/commit` 在 iso worktree 内全链成功）；不足则 `gitMetaDirs` 显式入 `allowWrite`（§2）。
7. resume 路径边界重注入：opencode `--session` / claude `--resume` 的续跑 attempt 是新进程、重新吃本次 env/config/settings——验证续跑会话不残留旧 session 级权限、边界在续跑中依然生效（设计门 F8）。
8. `--settings` 对安全键的逐键覆盖语义（尤其数组键 `excludedCommands` 是覆盖还是拼接，§4.1 键面钉死的前提）。

## 6. 耦合点与时序

- **RFC-280 在途**：本 RFC 的 opencode 合成落在其 T1 注入层（`agentInjection.ts`）；claude settings 落在 spawn 装配（T4 将收编为统一执行器）。**实施排程在 RFC-280 当批任务（T4-T7）落地后 rebase 再动工**，避免与 5 条并行链路收编互相踩；若 280 收编先完成，本 RFC 的 settings 物化改挂到 `AgentProcessRequest.files` 契约上（`design/RFC-280-unified-agent-spawn/design.md:167-186`）。
- **DeclaredManifest / 观测面分工（设计门 F7 修正）**：`workspaceBoundary` 进 DeclaredManifest 的只有**声明**（期望机制 opencode-permission / claude-sandbox / claude-deny-rules、mounts、作者白名单）；**实际降级级别**是运行后观测，落 RFC-280 T3 的 startup verification 记录（观测侧），不塞进 declared。接线时必须同步扩两处判据：`startupVerification.ts` 的 `declaredHasContent`（纯边界 run 也要落库）与前端 banner 的展示条件（降级=warn 级条目）——否则无 MCP/skill 的 Linux 缺 bwrap run 整条记录不落库、UI 无从显示降级。
- **反向守卫**：命名规避 §见 proposal §6；新文件建议 `services/execution/workspaceBoundary.ts`。
- **permissionMap（RFC-242 契约）**：`external_directory: []` 行保留（它描述 `--tools` 载入集，仍然正确）；新语义在独立映射函数中实现，不改 `mapAgentPermissionToClaudeTools`。
- **runtime fork 兼容**：自定义 claude fork（CodeAgent/GLM 网关）同样吃 `--settings`；opencode fork 同样吃 config content——无 per-fork 分叉。

## 7. 失败模式

- **F1 · 白名单漏路径** → 表现为 agent 合法操作被拒（响亮、可诊断，DeniedError 文案含 pattern）。缓解：`W(run)` 的装配数据全部来自 scheduler/runner 已有结构（iso handle、stagedSkills、runDir），不从路径形状猜（吸取 audit-backlog「放行集靠猜」四条事故根因 1 的教训）。
- **F2 · 敏感清单误伤自身** → claude denyWrite `<appHome>` 必须挖去本 run 的 cwd/iso/runDir/mounts；生成器单元测试锁「自身路径永不出现在 deny 集」。
- **F3 · 上游语义漂移**（opencode 改 findLast/默认白名单；claude 改 sandbox 键形）→ 集成测试用真 runtime 锁行为而非只锁渲染字节；opencode 版本记录在 design 头。
- **F4 · 越界拒绝改变既有工作流产出**（B1 的行为收缩本身）→ 保存面告警 + `docs/OPENCODE_CONFIG.md` 迁移指引（作者白名单写法）；不提供全局关闭开关（能力收缩一次到位，避免 RFC-276 批判过的双路径）。
- **F5 · resume 会话**：resume 沿用同一注入渲染（opencode `--session` / claude `--resume` 的续跑 attempt 是新进程、重新吃本次 env/config/settings），边界在续跑时不丢失；残留风险是**会话内持久化的 session 级权限**盖过新注入——§5-7 必测，plan T1/T3 各承接一条 resume 回归。

## 8. 测试策略

- **纯函数层**（必写）：`composeOpencodeBoundary` 键序/接管/告警全分支；claude settings 生成器（含 F2 挖洞、字面目录判定、scalar/glob 告警）；`CLAUDE_PLATFORM_OWNED_FLAGS` 扩展锁。
- **渲染层源码锁**：`renderOpencodeAgentEntry` 产出含 `external_directory` 基线；`buildClaudeSpawn` argv 含 `--settings`（未声明节点其余 argv 逐字节不变——防 RFC-242「探测面回退」类回归）。
- **真 runtime 集成**（gated，随 integration-opencode 腿 / macOS shard）：AC-1/2/3/5 的红绿对（mutation：去掉 deny 基线→越界放行）；**原生子代理**越界拒绝（AC-1 扩，§5-4）；claude Seatbelt 下 Bash 写兄弟目录 EPERM、写 cwd 成功、`git add/commit` 在 iso worktree 全链成功（§5-6）；作者白名单目录 claude 侧真实写成功（§5-5）；resume 续跑边界仍在（§5-7）；降级告警路径。
- **AC-8 敏感面归属**：opencode 侧用例归 T1（read `db.sqlite`/`secret.key`/`token`/其他任务 `runs/` 逐项 DeniedError），claude 侧归 T3（denyRead 同清单）；清单以 `util/paths.ts:16-32,54-71` 为单一事实源生成，测试遍历而非手抄。
- **回归命名**：`rfc281-workspace-boundary-*.test.ts`，文件头注明锁的事故（本次跨任务越界事件 + file:line 根因链）。
- **拒绝分支全覆盖**（CLAUDE.md 能力收缩条款）：B1/B3 的每条拒绝分支、B3 的每级降级、AC-8 的敏感面各至少一条测试。
