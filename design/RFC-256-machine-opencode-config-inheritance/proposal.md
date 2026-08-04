# RFC-256 · 恢复对机器自有 OpenCode 配置的读取 — proposal

状态：**In Progress**（2026-08-04，用户已直接拍板方案 B，见下「决策」）

## 1. 背景：这是一次回归修复，不是新功能

用户报告：「opencode 在过去我自己配在 opencode.json 里的模型用的都好好的，为什么从某天开始
探测功能就出问题了？」

考古结论——**同一个提交同时打断了探测面与执行面**：

- **`b4b3e082`（2026-07-24，RFC-224）之前**：平台跑 `opencode models` 探测模型时
  `Bun.spawn` **不传 env**（`b4b3e082^:packages/backend/src/util/opencode-models.ts:94`），
  子进程完整继承 daemon 环境 ⇒ opencode 正常读取操作者的
  `~/.config/opencode/opencode.json`，其中声明的模型出现在所有模型下拉里，Test 可用，
  发起任务也能跑。
- **之后**：env 被整体替换为私有沙箱（`HOME` / 四个 `XDG_*` / `OPENCODE_CONFIG_DIR` 全部
  指向临时私有目录，见 `services/runtime/opencode/models.ts` 与
  `hermetic.ts:buildHermeticServerEnv`）⇒ opencode 看到的是**空配置**：
  - **探测面**：模型下拉里操作者自己配的模型全部消失，Test 失效；
  - **执行面**：对这些 provider 发起任务以 `execution-identity-auth-invalid` 失败
    （平台的三条凭据通道对该 provider id 全部落空）。

RFC-255 曾以「平台内录入网关」的形式解决执行面，但那要求操作者把已有配置**再抄一遍**到
平台里，并没有回答「我机器上配好的东西为什么平台不认了」。本 RFC 才是该问题的正解。

## 2. 决策（用户 2026-08-04 直接选定）

给出的两档中用户选 **B**：

- **A（未采纳）**：只修探测面。模型能显示，但发起任务仍会失败——半修，反而更迷惑。
- **B（采纳）**：**探测面 + 执行面都恢复**读取操作者自有的全局 OpenCode 配置，回到
  7-24 之前的使用体验；**仓库内配置继续屏蔽**。

## 3. 能力影响清单（按 `CLAUDE.md` RFC workflow 第 7 条呈报）

本 RFC 是**扩张**能力（恢复），但它移动了 RFC-224 建立的安全边界，故同样逐项列明：

### 3.1 重新开放

| 面                                                                               | 恢复后       | 风险                                                                                                                      |
| -------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/opencode/`（含 `opencode.json`、`agent/`、`skill/`、`plugin` 声明等） | 密封进程可读 | **能修改那台机器上该目录的人，即可改变平台里 agent 的执行行为**（模型、端点、agent 定义、插件）。这是本次交换的核心代价。 |
| `$HOME/.opencode/`                                                               | 同上         | 同上                                                                                                                      |

**范围修正（实现期自查）**：初版实现顺手在继承档剔除了 `OPENCODE_PURE`，那等于把「加载机器
配置里声明的插件」也一并打开——插件在 OpenCode server 进程内执行、不受 containment 约束，
是比「读一段 provider 声明」大得多的一步，**超出用户批准的范围**（用户要的是模型），且撞红了
RFC-251 的既有锁。已收回：`OPENCODE_PURE` 保持置位，**机器配置里的插件仍然不加载**。
代价是「读了你的配置却忽略其中一部分」，故补 `machineConfigDeclaredPluginCount` 把被忽略的
数量报进运行诊断，让这条限制可见而不是静默。若日后确实需要，另立 RFC 单独决策。

### 3.2 继续保持关闭（未受影响）

| 面                                                                                         | 依据                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **仓库内 `.opencode/` 与 `opencode.json`**                                                 | `scanOpencodeProjectSurface` 仍拒绝 + `OPENCODE_DISABLE_PROJECT_CONFIG=1` 保留。clone 一个仓库即可向 agent 注入配置——这才是 RFC-224 真正针对的攻击面 |
| 会话存储 / 状态 / 缓存（`XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` / `TMPDIR`） | 保持每链私有；会话归属、store 锁与 resume 全建立在此                                                                                                 |
| 外部 skills（`~/.claude`、`~/.agents`）、Claude Code 提示与 skills                         | `OPENCODE_DISABLE_EXTERNAL_SKILLS` / `OPENCODE_DISABLE_CLAUDE_CODE` 保留                                                                             |
| **机器配置里声明的插件**                                                                   | `OPENCODE_PURE` 保持置位（见上「范围修正」）；被忽略的数量进运行诊断                                                                                 |
| 二进制冻结、containment 准入、源指纹、模型/skill 准入校验                                  | 全部不变                                                                                                                                             |

### 3.3 需要操作者知情的语义变化

- **执行身份不覆盖机器配置**：identity digest 仍只哈希平台受控 config，机器配置可在两次
  运行之间被改动而不体现为身份变更 ⇒ resume 不会因此被拒。这是「继承」的必然含义。
- **凭据解析**：平台三通道找不到凭据时不再硬失败，而是**交给 OpenCode 自行解析**
  （典型：`opencode.json` 里 `options.apiKey`）。关闭继承后仍为硬失败。

## 4. 目标

1. 模型探测（`/api/runtime/models` → 所有模型下拉）重新列出操作者机器上配置的模型。
2. Runtime **Test**、system agent、MCP-test 与业务运行全部恢复可用。
3. 提供 `inheritMachineOpencodeConfig` 开关（默认 **true** = 7-24 前行为），需要完全密封
   姿态的部署可置 false 回到 RFC-224 状态。
4. RFC-255 的平台内录入面保留，作为「不想改机器文件」的部署备选，二者可共存。

## 5. 非目标

- 重新开放仓库内配置面（明确不做）。
- 把会话存储改回全局共享（会破坏会话归属与 resume）。
- 让机器配置进入 execution identity（见 §3.3）。

## 6. 验收标准

- **AC-1**：`inheritMachineOpencodeConfig` 默认 true；env 覆盖恰好为
  `HOME` / `OPENCODE_TEST_HOME` / `XDG_CONFIG_HOME` 三项。
- **AC-2**：继承档下 `OPENCODE_DISABLE_PROJECT_CONFIG` 仍为 `1`；数据/状态/缓存/tmp/
  显式 config dir 仍指向私有布局。
- **AC-3**：继承档下 `OPENCODE_PURE` 不置位；密封档下仍置位。
- **AC-4**：继承档允许无 `OPENCODE_AUTH_CONTENT`；密封档缺凭据仍 `auth-invalid`。
- **AC-5**：平台已有凭据时仍以冻结单 provider 条目下发（继承是兜底而非替代）。
- **AC-6**：置 false 后，环境与本 RFC 之前逐字节相同。
