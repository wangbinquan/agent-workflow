# RFC-252 · 技术设计

## §0 现有单点与本 RFC 的落点

| 关注点 | 现有单一事实源 | 本 RFC 的动作 |
| --- | --- | --- |
| daemon 侧 git 调用 | `util/git.ts:runGit`（`:132-158`）、`gitRepoCache.ts:spawnGit`（`:87-95`） | 两处共用新的 `util/gitHardening.ts`，不再各自拼 argv/env |
| 沙箱策略渲染 | `services/sandbox/policy.ts`（`computeSandboxPolicy` / `renderSeatbeltProfile` / `renderBwrapArgs`） | **不动**（G3 已移出本 RFC，见 §3） |
| child 边界渲染 | `runtime/opencode/sealedSubprocess.ts`（`renderNetlessSeatbeltProfile` / `renderNetlessBwrapArgs`） | macOS 改默认禁写；两平台加 egress 分支 |
| containment 准入 | `services/sandbox/containmentCoordinator.ts`（`CONTAINMENT_REQUIREMENT_PROFILES` + `admit()`） | 新增 1 档 profile + 1 个能力名 |
| profile 选择 | `runtime/opencode/driver.ts:businessContainmentProfile`（`:63-67`） | 接入 `agent.network` |
| 外层 ctx 组装 | `services/runner.ts:1373-1391` + `sandbox/index.ts:buildRunSandboxCtx` | **不动**（同上） |
| submodule 更新 | `services/gitSubmodule.ts:syncSubmodules` | argv 固定 `--checkout` |

**红线**：`SpawnPlan.cmd` 保持 pristine（`sandbox/index.ts:1-7` 的既有约定），沙箱仍在最后一刻包裹；
coordinator 仍是 topology 的唯一所有者，driver 只声明 profile。

---

## §1 G1 — daemon 侧 git 执行面收口

### 1.1 强制覆盖（enforce 层）

新模块 `packages/backend/src/util/gitHardening.ts`：

```ts
/** 平台自有的空 hooks 目录：daemon 启动时创建，0500，位于 appHome 沙箱拒绝区。 */
export function gitHooksVoidDir(appHome: string): string   // <appHome>/gitguard/empty-hooks

/** 每一次 daemon 侧 git 调用都必须前置的覆盖集。 */
export function hardenedGitLeadingArgs(appHome: string): string[] {
  return ['-c', `core.hooksPath=${gitHooksVoidDir(appHome)}`, '-c', 'core.fsmonitor=false']
}
```

`git` 命令行 `-c` 的优先级高于 repo-local config，因此这是**唯一**能压过
agent 写入 `.git/config` 的手段。`runGit` 组装为 `['git', ...hardenedGitLeadingArgs(appHome), '-C', cwd, ...args]`，
`spawnGit` 同理（它没有固定 cwd，`-c` 位置不变）。

**为什么不用 `GIT_CONFIG_NOSYSTEM` / `GIT_CONFIG_GLOBAL=/dev/null`（D2）**：威胁来自
repo-local config，这两个环境变量对 local 作用域**完全无效**；而它们会连带禁掉全局/系统
config 里的 `credential.helper`（macOS 的 osxkeychain 就在 system config），打断依赖本机
凭据助手的私有仓 fetch。二者是净负收益。

**子命令级修正（`-c` 压不住、但有等价的命令行开关）**：

- `diff.external` —— **不能**用 `-c diff.external=`：实测 git 会去执行空命令并报
  `cannot run : No such file or directory`，把 diff 直接搞坏。正解是给 `diff` 子命令补
  `--no-ext-diff`；实测它是**子命令的**选项，放在子命令之前是 `unknown option`，故
  `withExternalDiffDisabled` 插在子命令**紧后**。对没配 external diff 的仓库是 no-op，
  且 daemon 本来就要解析 unified diff（外部 diff 程序的输出根本不可解析）——这条既是
  安全修复也是正确性修复。
- `submodule.<name>.update = !cmd` —— 通配名，`-c` 压不住；改为在
  `syncSubmodules` 的 argv 固定 `--checkout`。`--checkout` 本就是 git 默认策略，
  只是拿掉 config 覆盖它的能力，对诚实仓库零行为变化。（`gitSubmodule.ts` 的另一个
  调用点早已传 `--checkout`，两处不得再漂移。）

**不覆盖的固定名键与理由**：

- `core.sshCommand` —— `nonInteractiveGitEnv()` 恒设 `GIT_SSH_COMMAND`（`util/git.ts:34-40`），
  env 优先级高于 config，已被压过。
- `credential.helper` —— `-c credential.helper=` 会清空**全部**（含全局）helper 列表，
  打断合法凭据链。**本轮不处理**（检测层已移出），登记 backlog。
- `core.pager` / `core.editor` —— 非交互 + 管道输出，daemon 路径不触发。

**实现踩坑（已写进源码注释）**：`mkdirSync(dir, { recursive: true, mode: 0o500 })` 会把
`mode` 应用到**每一级**新建目录，父目录 `gitguard/` 随即不可写、叶子目录 EACCES 建不出来。
必须先按默认权限建全链、再单独 `chmod` 叶子。

### 1.1b `commit` 豁免——本 RFC 对功能面的零变更承诺

初版实现对**所有**子命令压制 hooksPath，全量测试立刻抓出两处真实回归，且它们都不是
「测试写得脆」，而是本仓**有意**依赖的既有行为：

1. `rfc165-scratch-space.test.ts` S4b 用 `GIT_TEMPLATE_DIR` 装一个 `exit 1` 的
   `pre-commit` 模拟「scratch 根提交失败」，压制后该提交转为成功 ⇒ 5 条用例连锁红。
2. `rfc210-publish-failure-hard-fails.test.ts` 锁的是 RFC-210 实现门 critical #1：
   子仓自动提交失败必须**硬失败**，否则父仓快照只记旧 gitlink、merge-back 报 clean、
   随后 `discardNodeIso` 把 agent 工作的**唯一副本**删掉。它的触发源正是「仓库
   `pre-commit` 拒绝平台的自动提交」，注释原文称之为 *an everyday setup*。

⇒ 「仓库钩子 gate 平台的自动提交」在本仓是被当作**正常生产场景**对待的。用户
2026-08-03 拍板：**`commit` 子命令豁免 hooksPath 压制**，功能面零变更，两个既有测试
一行不改。

| 子命令 | `core.hooksPath` | `core.fsmonitor` |
| --- | --- | --- |
| `commit` | **豁免**（仓库钩子照常跑） | 压制 |
| 其余全部（`worktree`/`status`/`diff`/`merge`/`checkout`/`stash`…） | 压制 | 压制 |

- `fsmonitor` **不豁免**：它是索引刷新助手，不是用户会依赖的 gate，压制它零功能影响。
- 实测的那条 `worktree add → post-checkout` 逃逸链**仍然堵死**（`worktree` 不在豁免集）。
- **代价（已登记 backlog）**：`pre-commit` / `commit-msg` / `post-commit` 仍以 daemon 身份
  在沙箱外执行，是本模块唯一留下的口子，且可达（agent 写 `.git/hooks/pre-commit`，
  等一次自动 commit&push）。**根治办法是把自动提交挪进沙箱内执行**——钩子照跑但在边界内，
  属独立切片。
- 豁免本身由 `rfc252-git-hardening.test.ts` 显式锁住（断言 `commit` 仍触发仓库
  `pre-commit`、且 `fsmonitor` 不触发），避免它被后人当成疏漏「顺手补上」。

### 1.2 检测层——本轮移出

原设计还有一层「hooks 与 exec 类 local config 基线指纹 + 漂移即拒绝」。**已整体移出**，
两个理由：

1. 用户定调「做安全不能把功能限制住」——误报一次就等于一次任务失败，而基线在真实仓库上
   （用户自己装 husky、自己改 config）必然产生误报。
2. 设计门 P0 指出我原本的「该仓无活跃任务时自动重封」还会**把上一个任务植入的恶意配置
   洗白**，并与新任务启动存在竞态。修好它需要引入 per-common-dir lease，复杂度和破坏面
   都远超收益。

覆盖层已经吸收了这一层的多数收益：`-c` 压过**所有** config 作用域，因此
`config.worktree` 与 `.git/modules/**/config` 这两个设计门单独点名的面**自动被覆盖**，
无需枚举。

### 1.3 覆盖不到的残留（登记 `docs/audit-backlog.md`）

- `filter.<n>.clean/smudge/process`、`diff.<n>.textconv`：通配名，`-c` 压不住，需要先
  枚举再逐名覆盖。无差别关闭会打断用户全局 git-lfs 配置——那是真实功能损害，故留作
  独立切片（正确形态：只中和 **local/worktree 作用域**的条目，system/global 不动）。
- `credential.helper` 的 local 作用域条目：同上，`-c` 清空会连带打断合法凭据链。
- 非 agent 触发的 daemon 侧执行面（runtime probe / MCP probe / 插件安装）：不属于本 RFC
  的「恶意 agent」威胁模型，但确实是 daemon 身份的无沙箱执行，单独登记。

## §3 G3 外层强档——本轮移出

原 §3 的「遮读真实 `$HOME` + appHome、全局默认禁写」**整项移出本 RFC**，理由见
proposal §非目标：它同时具备本 RFC 最大的破坏面（`systemAgentRun` / `memoryDistiller` /
`runtimeSmoke` 都经 `verifiedSystemPlan`，设计门 P1 指出我原本的消费者矩阵自相矛盾）
和最小的即时收益（verified 路径的业务 agent 没有进程内 FS 工具，故它只是纵深防御）。
设计门 P0-7 关于「`hermeticOuter` 走 plan 字段绕过 RFC-233 单一事实源」的争议也随之消失
——重做时必须走 coordinator-owned profile/capability，`userHomeIsolation` 只能由实际
admitted topology + renderer 结果产生。

`services/sandbox/policy.ts` 与 `runner.ts` 的 sandbox ctx 组装在本 RFC 内**零改动**。

## §4 G4 — 受控出网

### 4.1 资源模型

- shared `AgentSchema` 增 `network: z.enum(['deny','allow']).optional()`（缺省 = `deny`）。
- migration：`agents` 加 `network TEXT`（nullable，**不回填**）。编号实现期现取
  （RFC-248 设计门 G2 教训：文档不写死编号）。
- 前端 `AgentForm` 用既有 `<Switch>`（`components/Form.tsx`）+ `<Field>` hint 说明
  「允许该代理的 shell / 本地 MCP 子进程访问公网，仍禁止访问本机 localhost」；
  agent 详情/列表用既有 `<StatusChip>` 显示。i18n 中英对称新增 key。

### 4.2 准入档位

新增 **1 档** profile 与 **1 个**能力名：

```ts
'model-child-egress-v1': {
  id: 'model-child-egress-v1', revision: '1',
  required: ['platformHomeIsolation', 'immutableArtifactView', 'modelChildLoopbackDeny'],
  optional: ['descendantLifetimeBound', 'userHomeIsolation'],
  childBoundary: 'model-controlled',
}
```

它**不含** `modelChildNetworkDeny`（本就是要放开的），改为要求
`modelChildLoopbackDeny: 'strong'`——保证「放开公网」不等于「放开本机」。

`driver.businessContainmentProfile` 决策表：

| `agent.network` | 有模型可控子进程（bash≠deny 或 local MCP） | profile |
| --- | --- | --- |
| `deny`/缺省 | 是 | `model-child-netless-v1`（不变） |
| `deny`/缺省 | 否 | `runner-filesystem-v1`（不变） |
| `allow` | 是 | **`model-child-egress-v1`** |
| `allow` | 否 | `runner-filesystem-v1` + 一条「network 授权无效果」提示 |

**closure 级授权（设计门 P0-5）**：`businessContainmentProfile` 当前入参是
`Pick<BusinessNodeSpawnContext, 'agent' | 'mcps' | 'runtimeCmd'>`（`runtime/types.ts:643-645`），
**看不见 `dependsOn` 闭包**；而 RFC-251 之后整条 closure **共用同一个 shell wrapper**
（受控配置顶层 `shell: input.shellPath`），因此「按单个 agent 授权网络」在物理上不可实现。
本 RFC 据此把授权提升为**整条 execution closure 的属性**：

- 入参扩展为可见 `dependents`；「有模型可控子进程」按**整条 closure** 判定
  （顺带修掉一个既有缺口：root `bash: deny` + 成员 `bash: allow` 时今天会落
  `childBoundary:'none'`，模型可控的 shell 因此拿不到 netless 边界）。
- closure 内 `network` 声明**必须一致**，否则启动期显式失败；不取并集——并集等于静默提权。

### 4.2b 与 RFC-253 的分工（按其 `design.md:563` 的要求登记）

RFC-253（脚本执行节点）并发交付**外层进程无网**的通用围栏：能力 `outerNetworkDeny`、
profile `outer-netless-v1`（`childBoundary:'none'`）、以及**`failClosed: true` 作为 profile
注册表字段** + coordinator `#evaluate` 的三档统一改判。其 profile id 刻意不带 `script-`
前缀，正是为了让本 RFC 复用。

- **本 RFC 不重建**上述任何一项。§4.3 的 fail-closed 由「声明 `failClosed: true`」实现，
  coordinator 里只保留 RFC-253 那一处逻辑。**依赖顺序：RFC-253 的该字段先落地，本 RFC 的
  PR-3（T12）才能消费**。
- **本 RFC 仍需自建** `model-child-egress-v1` 与 `modelChildLoopbackDeny`：需求与 RFC-253
  真正不同（一个是「完全无网」，一个是「有网但不得触达本机 loopback」），按注册表契约
  （`containmentCoordinator.ts:13-26`）应当并列而非合并。RFC-253 `design.md:563` 也明确把
  loopback deny 划出其范围。
- 完整接口约定、三条待回应问题（其中 Q1：RFC-253 的 `network:'allow'` 默认档走宿主 netns
  ⇒ 脚本可达 loopback，与本 RFC 的「拒 loopback」不对称）见
  `rfc253-egress-interface-2026-08-03.md`。

### 4.3 fail-closed 例外（AC-8）

`warn` 档的既有语义是「资格不足 ⇒ 原子降级为 none + 告警」。对 egress profile 这条**不适用**：
降级会变成「有网且 loopback 可达」，是**提权**而非降级。故：

> `model-child-egress-v1` 在 `modelChildLoopbackDeny` 非 `strong` 时，
> **无论 mode 为 enforce 还是 warn 一律 blocked**，错误码
> `execution-identity-egress-unavailable`（新增，permanent）。`off` 档不申请该 profile
> （无 containment 时谈不上 egress 边界）——此时 `network:'allow'` 的节点同样 blocked，
> 理由码相同，避免「关沙箱反而更容易拿到网络」。

这条是对 coordinator 决策表的**唯一**例外，必须在 `#evaluate` 里显式表达并单测锁定。

### 4.4 渲染

`NetlessSubprocessManifest` 增 `egress: 'deny' | 'public-no-loopback'`，`codec` 由 `1` 升到 `2`
（manifest 只在同一次运行内写读，无跨版本兼容问题）。

- **macOS**（`renderNetlessSeatbeltProfile`）：`egress==='deny'` 保持 `(deny network*)`；
  `public-no-loopback` 改为
  ```
  (deny network-inbound)
  (allow network-outbound)
  (deny network-outbound (remote ip "localhost:*"))
  (allow network-outbound (literal "/private/var/run/mDNSResponder"))
  ```
  最后一条是 macOS DNS 的必要条件（解析走 mDNSResponder 的 unix socket）。
  精确语法与是否还需放行 `/var/run/mDNSResponder`（非 `/private` 前缀）以 gated 实跑收敛。
- **Linux**（`renderNetlessBwrapArgs`）：`public-no-loopback` 时**不能**只是去掉
  `--unshare-net`（那样直接落进宿主 netns，loopback 敞开）。需要一个用户态网络栈把
  child 放进**独立 netns 并做 NAT**：候选 `pasta`（passt，`--config-net --no-map-gw`）
  与 `slirp4netns`。二者在 outer bwrap **嵌套**下的可行性必须在实现期用 gated 集成测试
  定稿（T-14）；若嵌套下均不可行，退路是把 egress child 提到 outer 之外由 launcher 直接以
  pasta 启动——**属拓扑变更，须回设计门复核，不得在实现期自行决定**。
  资格探测复用 `requireRootOwnedBwrap` 的形态（canonical 路径 + root 属主 + 祖先链 + 真实试跑），
  新增 `qualifyLoopbackDenyProvider()`，试跑判据两条：外部 TCP 通 + 宿主 loopback 不通。
- `agent-workflow sandbox`（RFC-216）增加一条只读检查项：egress 能力是否可用，
  不可用时打印发行版感知的安装命令（复用 `sandbox/guidance.ts:PACKAGE_MANAGERS`）。

### 4.5 残留风险（显式登记，不得隐瞒）

开启 egress 的 agent 可外传任意它能读到的内容、可访问局域网与内网服务（SSRF）。
`network` 授权必须在 UI、receipt、任务告警三处可见。文档写明：**授予 egress 等价于
信任该 agent 的提示词与它读到的一切内容**。

---

## §5 失败模式

| 场景 | 行为 | 可观测 |
| --- | --- | --- |
| 仓库里存在 hook / `core.hooksPath` / `core.fsmonitor` / `diff.external` | daemon 侧 git **照常成功**，只是不执行它们 | 无（刻意不告警：告警等于把用户自己的 husky 也当攻击） |
| `submodule.<n>.update = !cmd` | `--checkout` 固定策略，配置被忽略 | 无 |
| egress 能力不可用 | blocked（所有 mode） | `execution-identity-egress-unavailable` + Settings→Runtime 显示 |
| `network:'allow'` 但整条 closure 无模型子进程 | 正常运行，profile 退回 `runner-filesystem-v1` | 一条 info 级提示 |
| closure 内 network 声明不一致 | 启动期显式失败，不静默取其一 | 明确错误信息指出冲突成员 |

**刻意没有的失败模式**：G1 不引入任何新的「拒绝执行」路径。这是本 RFC 与初版设计最大的
差别——初版的基线检测层会在误报时让任务失败，违反「做安全不能把功能限制住」。

## §6 测试策略

**G1（已交付，`packages/backend/tests/rfc252-git-hardening.test.ts`，8 用例全绿）**：

1. 纯函数：`gitSubcommandIndex`（跳过 `-c`/`-C`，覆盖生产里真实存在的
   `-c core.quotepath=false diff …` 形态）、`withExternalDiffDisabled`（只改 diff、插在
   子命令紧后、非 diff 原样、幂等）、`hardenedGitLeadingArgs`（argv 顺序 + 空 hooks 目录
   落在 appHome 内 + `core.fsmonitor` 必须是布尔字面量）。
2. **成对回归**：一个装好四类陷阱（`.git/hooks/`、repo-local `core.hooksPath` 指向
   worktree 内、`core.fsmonitor`、`diff.external`）的真 git 仓，每个用例都跑
   「裸 git 必须触发（对照组）+ 生产 `runGit` 必须不触发」。没有对照组的用例是恒绿空断言。
3. **功能未被搞坏**同批断言：worktree 建得出来、`status` 仍报告改动文件、`diff` 仍输出
   可解析 unified diff（含 `-one`/`+two`）、`commit` 仍成功。
4. `syncSubmodules` 经 `runGitImpl` seam 断言 argv 含 `--checkout`。
5. **变异验证**（已实跑）：`hardenedGitLeadingArgs` 返回 `[]` ⇒ 5 红；
   `withExternalDiffDisabled` 变恒等 ⇒ 2 红；还原 ⇒ 8 绿。

**G2 / G4（待实现）**：

6. `renderNetlessSeatbeltProfile` 默认禁写 + 与 Linux 共用的 writable/deny 断言表。
7. coordinator：新 profile 的 required 集合、egress fail-closed 三档
   （enforce/warn/off 全 blocked）、既有两档 profile 决策**零变化**（快照锁）。
8. driver profile 选择矩阵（§4.2，含 closure 一致性校验的正反例）。
9. shared schema + migration + 路由序列化 + agent.md round-trip + 前端 AgentForm/chip
   + i18n 双语对称。
10. **gated 集成**（`RUN_SANDBOX_ITEST=1`）：macOS 真 `sandbox-exec` 跑 G2 与 egress；
    Linux 真 bwrap 跑 egress（`python3` 真实 HTTPS 成功 + loopback 被拒，覆盖 `127/8`、
    `::1`、IPv4-mapped IPv6）。

**不允许**：以「重跑就过了」作为通过依据（CLAUDE.md）。gated 用例必须能在本机稳定复现。

## §7 未决

1. Linux egress 的用户态网络栈选型与嵌套可行性（§4.4）——实现期 gated 实测定稿；
   若嵌套下 pasta / slirp4netns 均不可行，**停下回设计门**，不得自行改拓扑。
2. G4 的 closure 一致性：mixed closure（root 与成员 network 声明不同）一律启动期失败，
   还是取「全 closure 并集」？当前设计取**显式失败**，因为并集等于静默提权。
3. G3（外层强档）重做时的档位形态：必须是 coordinator-owned profile/capability，
   不得再走 plan 字段（设计门 P0-7）。
