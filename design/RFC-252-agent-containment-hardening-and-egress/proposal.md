# RFC-252 · Agent containment 加固与受控出网

## 背景

2026-08-03 对「一个恶意 agent 能否攻破进主机」做了一次实证审计。结论分两半：
**verified OpenCode 路径比预期紧得多，但仍有两条可直接利用的逃逸；同时用户提出了
一个当前设计明确禁止的合法需求（python 脚本访问公网）。**

### 现状实证（逐条有源码/实测依据）

**A. verified 路径的模型工具面比想象中窄。** 受控配置对每个 agent 条目无条件 deny
`read / edit / write / apply_patch / grep / glob / skill / task / webfetch / websearch / lsp`
（`hermetic.ts:573-585` 的 `DENIED_TOOLS` + `:697-699`），opencode 的
`visibleTools`/`disabled`（`permission/index.ts:204-219`）会把 `pattern='*'` 且 `deny`
的工具从模型的工具列表里摘掉。业务 agent 实际只有 `bash`（若 `permission.bash !== 'deny'`）
+ MCP 工具。`AW_GLOBAL_PERMISSION{'*':'allow'}` 只存在于 legacy/test 路径
（gate 见 `verifiedPlan.ts:369-373`、`driver.ts:112-118`），生产不可达。
⇒ 「模型用进程内 write 直接写 `~/.zshrc`」在 OpenCode 上**不成立**。

**B. 但 bash 子进程对 git 公共目录有合法写权限，而 daemon 侧 git 不设防。**
`gitCommonDirs` 是 netless child 的 rw allow-back（`sealedSubprocess.ts:991-997`，
commit 必需），`~/.agent-workflow/repos` 是外层 rw allow-back（`policy.ts:107`）。
daemon 侧 `runGit`（`util/git.ts:132-158`）与 `spawnGit`（`gitRepoCache.ts:87-95`）
用完整 `process.env` 跑 `worktree add / checkout / merge / commit / stash / status / diff`，
**全仓 grep 零 `core.hooksPath` / `core.fsmonitor` 处置**。本机 git 2.50.1 实测两条均触发：

```
--- post-checkout on worktree add ---   PWNED_AS_wangbinquan pid=61189
--- core.fsmonitor on git status ---    FSMONITOR_PWNED_AS_wangbinquan
```

⇒ agent 在**完全合法的写权限内**放一个 hook 或一条 repo-local config，下一次 daemon 侧
git 就以 daemon 身份、无沙箱、全 env 执行它——可读 `secret.key` / `db.sqlite`。
**这是当前唯一一条可直接利用、且绕过 Linux 强 child 边界的完整逃逸链。**

**C. macOS child 边界与 Linux 不对称。** Linux child 是 `--ro-bind / /`（全盘只读 +
allow-back 可写，`sealedSubprocess.ts:1032-1051`）；macOS child 却是 `(allow default)`
+ 仅遮 realHome/appHome/tmp（`:1110-1150`）⇒ masks 之外**可写**。本机
`/opt/homebrew/bin` 实测 `drwxrwxrwx wangbinquan`，可覆写任意 brew 二进制，等用户或
daemon 下次执行即在沙箱外获得执行。

**D. 外层边界按设计不是 jail。** `policy.ts:22` 原文 *"this is a targeted boundary,
not a jail"*：macOS `(allow default)` + 仅 deny appHome；Linux `--bind / /` **读写** +
仅 tmpfs 遮 appHome。它防的是 A1–A5（平台机密与跨任务读），不防主机沦陷。今天因为
A（无 FS 工具）这条面暂时无法被模型直接驱动，但它是纵深防御的空缺——RFC-224 的威胁
模型本就包含「运行时二进制本身不可信」。

**E. claude-code 运行时是另一回事。** 它保留真实 `HOME`、继承完整 `process.env`
（`claudeCode/spawn.ts:372-373`），且 Read/Edit/Write/WebFetch 在进程内执行
（`docs/audit-backlog.md:38` 已登记）。本 RFC **不处理它**（见非目标）。

### 新需求

用户需要 agent 的 **python 脚本访问外部网络**。当前 child 无网是硬性的：
`model-child-netless-v1` 把 `modelChildNetworkDeny: 'strong'` 写进 `required`
（`containmentCoordinator.ts:36-42`），Linux `--unshare-net`、macOS `(deny network*)`。
`webfetch`/`websearch` 也被 deny ⇒ 今天 agent 的**唯一**出网通道是 remote MCP。

## 目标

1. **G1 — 关闭 daemon 侧 git 执行面**：agent 无法通过 hook / repo-local config 让
   daemon 在沙箱外执行代码。
2. **G2 — macOS child 与 Linux 对齐**：默认禁写 + 显式 allow-back，消除 `(allow default)`
   带来的「改写主机上任意 user-writable 二进制」通道。
3. **G3 — 外层对 env-hermetic 运行时收紧**：遮蔽真实 `$HOME` 与 appHome 的读、全局默认
   禁写，仅 allow-back 可写。按能力分档，只作用于声明了 env-hermetic 的运行时。
4. **G4 — 受控出网**：agent 可显式声明 `network: 'allow'`，其模型可控子进程获得**任意公网**
   访问，但**不得**触达 loopback。默认 `deny`，存量 agent 行为字节不变。

## 非目标

- **域名白名单 / 出网代理**（原审计 ③ 的完整形态）。本轮只做「放行公网 + 拒 loopback」，
  代理白名单作为后续切片，profile 契约留好升级位。
- **翻转 macOS 的 topology 取舍**（`provider-child-only` ⇒ server 进程不被外层包裹）。
  用户明确本次不翻；G3 因此在 macOS 上只对「禁用 bash 且无 local MCP」的节点生效，
  Linux 全量生效。此限制在 design §4.5 显式记录并登记 backlog。
- **claude-code 运行时的 env hermetic 化**。用户明确不做：claude 节点维持现状，
  不进 G3 强档，按能力分档天然排除，并保留既有 `claude-mcp-netless-outer-dropped` 告警。
- **修改 `sandboxMode` 默认档**（保持 `warn`）。
- **收窄 `DENIED_TOOLS`/放开 read/write 工具**——与本 RFC 正交。

## 用户故事

- **运维**：我不接受「agent 往仓库里放个 hook，我的 daemon 就替它在主机上跑代码」。
  加固后，daemon 侧 git 不再执行仓库提供的任何可执行配置；一旦检测到有人往里放，
  该次操作直接拒绝并告警。
- **开发者**：我有一个 agent 需要用 python 调用外部 API。我在 agent 定义里打开
  「允许访问网络」，它就能出公网；但它**碰不到**我本机 `localhost:5432` 的数据库和
  daemon 自己的 API。
- **管理员**：我在 agent 列表/详情上一眼看得出哪些 agent 被授予了出网，任务回执里
  也记录了本次执行的实际 containment 档位。

## 验收标准

- **AC-1**：daemon 侧任一 git 调用都携带固定的 `-c` 覆盖集；仓库内放置
  `hooks/post-checkout`、`core.fsmonitor` 后，`worktree add` / `status` / `commit`
  **不再**执行它（红→绿回归测试直接复刻本 RFC 背景里的实测脚本）。
- **AC-2**：worktree/镜像创建时记录 hooks 与 exec 类 local config 基线；事后被改动时，
  daemon 侧 git 操作**拒绝执行**并产生一条任务级告警，且**不修改用户仓库**任何内容。
- **AC-3**：macOS child profile 默认禁写；child 内写 `/opt/homebrew/bin/x`、
  `/Users/Shared/x` 失败，写 worktree / scratch / 私有 HOME / gitCommonDir 成功。
  与 Linux 同一组断言共用测试表。
- **AC-4**：G3 生效时，外层内读 `$HOME/.ssh/id_rsa`、写 `$HOME/.zshrc` 均失败；
  worktree / runDir / store / repos / gitCommonDirs 读写正常；
  **嵌套不变量**：child 的全部 writable 与 bindReadOnly 均是外层允许集的子集
  （否则 Linux 上 child 的 bind 源路径不存在，spawn 直接失败）。
- **AC-5**：claude-code 节点与未声明 hermetic 的运行时**不进入** G3 强档，行为字节不变。
- **AC-6**：`network: 'allow'` 的 agent，其 bash 子进程内 `python3` 能完成一次真实
  HTTPS 请求（gated 集成测试）；`network` 缺省/`'deny'` 的 agent 仍然 100% 无网。
- **AC-7**：`network: 'allow'` 时，child 内访问 `127.0.0.1:<daemon port>` 与
  `localhost` 上任意端口**失败**。
- **AC-8**：Linux 上 loopback-deny 能力不可用（未装 pasta/slirp4netns 或探测失败）时，
  `network: 'allow'` 的节点**fail closed**（不降级为「有网且能打 loopback」），
  错误码稳定、`agent-workflow sandbox` 打印发行版感知的安装命令。
- **AC-9**：containment receipt / Settings→Runtime / 任务告警如实反映本次档位与
  `modelChildLoopbackDeny` 能力强度；不得出现「receipt 报 contained 但边界未施加」。
- **AC-10**：存量 agent（无 `network` 字段）行为与升级前字节一致；migration 不回填、
  不改变任何既有 profile 的 `required` 集合。

## 决策清单（用户拍板）

| 编号 | 决策 | 取舍 |
| --- | --- | --- |
| **D1** | git 硬化 = `-c` 覆盖 **+** 篡改检测拒绝 | 不采用「剥除用户仓 config 键」（会改写用户真实仓库） |
| **D2** | 不用 `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL` 做主手段 | 威胁来自 repo-local；而全局/系统 config 恰是 `credential.helper`（macOS osxkeychain 在 system config）的所在，一刀切会打断私有仓 HTTPS fetch |
| **D3** | 外层强度 = 遮读（真实 `$HOME` + appHome）+ 全局禁写 | 不选「只禁写保留读」（`~/.ssh` 仍可读）；不选「/tmp 一并私有化」（Bun/macOS `/private/var/folders` 兼容风险） |
| **D4** | 按能力分档，只给 env-hermetic 运行时 | claude 不动；不按 OS/厂商名分叉（RFC-227） |
| **D5** | macOS topology 本次不翻 | G3 在 mac 上只覆盖无 bash/local-MCP 的节点，登记后续 |
| **D6** | 出网范围 = 任意公网 + 拒 loopback | 不做域名白名单代理（后续切片） |
| **D7** | 出网开关粒度 = 按 agent 声明，默认 `deny` | 不做全局开关，不做节点级 override |
| **D8** | ④ 的做法从「遮蔽 homebrew」升级为「默认禁写」 | 单点遮蔽治标；默认禁写与 Linux `--ro-bind /` 对齐，且 Linux 侧已长期证明可用。只读而非遮蔽 ⇒ `/opt/homebrew/bin/python3` 仍可执行 |

## 影响面

- **对 agent 执行能力的影响**：G1/G2 对 agent 干活零影响（G2 挡的写路径今天也没有合法用途）；
  G3 只影响「读写 worktree 之外的用户文件」——而 verified 路径的模型今天连 FS 工具都没有，
  因此 G3 是纵深防御，不是能力收窄；G4 是**净增能力**。
- **python 生态实操**：child PATH = `<seal>/toolchain:/usr/bin:/bin`（`verifiedPlan.ts:152,196`），
  `/usr/bin/python3` 可用。child 的 `$HOME`/`$TMPDIR` 在 `storeRoot/{home,tmp}`
  （`hermetic.ts:388,396`）⇒ **同一条业务链持久**，`pip install --user` 可跨 run 复用；
  `scratchPath = runRoot/opencode-scratch`（`verifiedPlan.ts:445`）是每 run 新建。
  venv 建在 worktree 内会进 git diff / 快照，文档需给出建议。
- **残留风险（显式登记）**：G4 开启后 child 可外传数据、可访问局域网；G3 在 macOS 上
  对 bash 节点不生效；`filter.*`/`diff.*.textconv` 只被检测、不被覆盖；`warn` 档缺
  provider 时仍降级裸跑。
