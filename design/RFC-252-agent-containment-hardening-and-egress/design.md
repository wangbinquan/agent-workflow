# RFC-252 · 技术设计

## §0 现有单点与本 RFC 的落点

| 关注点 | 现有单一事实源 | 本 RFC 的动作 |
| --- | --- | --- |
| daemon 侧 git 调用 | `util/git.ts:runGit`（`:132-158`）、`gitRepoCache.ts:spawnGit`（`:87-95`） | 两处共用新的 `util/gitHardening.ts`，不再各自拼 argv/env |
| 沙箱策略渲染 | `services/sandbox/policy.ts`（`computeSandboxPolicy` / `renderSeatbeltProfile` / `renderBwrapArgs`） | 扩展输入输出，新增「遮读 + 全局禁写」档 |
| child 边界渲染 | `runtime/opencode/sealedSubprocess.ts`（`renderNetlessSeatbeltProfile` / `renderNetlessBwrapArgs`） | macOS 改默认禁写；两平台加 egress 分支 |
| containment 准入 | `services/sandbox/containmentCoordinator.ts`（`CONTAINMENT_REQUIREMENT_PROFILES` + `admit()`） | 新增 1 档 profile + 1 个能力名 |
| profile 选择 | `runtime/opencode/driver.ts:businessContainmentProfile`（`:63-67`） | 接入 `agent.network` |
| 外层 ctx 组装 | `services/runner.ts:1373-1391` + `sandbox/index.ts:buildRunSandboxCtx` | 增加 `gitCommonDirs` 与 hermetic 档位透传 |

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

**不覆盖的固定名键与理由**：

- `core.sshCommand` —— `nonInteractiveGitEnv()` 恒设 `GIT_SSH_COMMAND`（`util/git.ts:34-40`），
  env 优先级高于 config，已被压过。
- `credential.helper` —— `-c credential.helper=` 会清空**全部**（含全局）helper 列表，
  打断合法凭据链。改由 §1.2 检测。
- `core.pager` / `core.editor` —— 非交互 + 管道输出，daemon 路径不触发。

### 1.2 篡改基线（detect 层）

`-c` 压不住通配名族（`filter.<n>.clean/smudge/process`、`diff.<n>.command/textconv`、
`merge.<n>.driver`、`url.<n>.insteadOf`、`alias.*`），它们同样能在 checkout / merge /
diff 时执行代码。对这一族采用**基线 + 校验 + 拒绝**，不改写用户仓库（D1）。

```ts
export interface GitGuardBaseline {
  /** hooks 目录内每个常规文件的 sha256（含非可执行位，防止先放后 chmod）。 */
  hooks: Record<string, string>
  /** exec 能力 local config 的 `name=value` 全集，排序后逐条记录。 */
  execConfig: string[]
  sealedAt: number
}

export function execCapableConfigKey(name: string): boolean   // 纯函数，锁在单测
export async function sealGitGuard(gitCommonDir: string, appHome: string): Promise<void>
export async function assertGitGuard(gitCommonDir: string, appHome: string): Promise<void>
```

- **匹配集**（`execCapableConfigKey`，全部小写比较）：
  `core.(hooksPath|fsmonitor|sshCommand|pager|editor|askpass|externalDiff|gitProxy|alternateRefsCommand)`、
  `credential(\..+)?\.helper`、`filter\..+\.(clean|smudge|process)`、
  `diff\..+\.(command|textconv)`、`merge\..+\.driver`、`gpg(\..+)?\.program`、
  `ssh\.variant`、`url\..+\.insteadOf`、`protocol(\..+)?\.allow`、`init\.templateDir`、
  `alias\..+`、`uploadpack\.packObjectsHook`。
  **刻意不含**平台自己会写的键（`submodule.*.url`、`core.sparseCheckout`、
  `extensions.*`、`remote.*.url`）⇒ 平台的合法写入不会触发重封。
- **读取方式**：`git --local --list --null config`（同样带 §1.1 的 `-c` 前缀；
  `git config` 自身不跑 hook）。
- **落盘位置**：`<appHome>/gitguard/<sha256(realpath(gitCommonDir))>.json`，`0600`。
  位于 appHome ⇒ 在两层沙箱的拒绝区内，agent 不可写。
- **校验时机**：`assertGitGuard` 由 `runGit`/`spawnGit` 在 spawn 前调用。
  廉价预检：`stat` hooks 目录与 `config` 文件的 `(ino, size, mtimeNs)`，命中缓存直接放行；
  不命中才重新哈希。缓存为进程内 `Map<gitCommonDir, {stat, baseline}>`。
- **封存时机（关键：避免误报）**：只在**没有任何任务对该 gitdir 持有写权限**时封存/重封——
  即 `createWorktree` / cold clone / warm fetch 前，先查该仓是否有活跃任务
  （`tasks.status ∈ 非终态` 且 repo 命中）。有活跃任务则**不重封**，沿用旧基线。
  这样用户在两次任务之间对自己仓库做的合法改动会被自然吸收，而 agent 运行期的改动
  一定被判为篡改。
- **失败语义**：`assertGitGuard` 失败时**不抛**（保持 `runGit` "never throws" 契约），
  返回 `{stdout:'', stderr:'git-guard-tampered: <key|hook>', exitCode: GIT_GUARD_EXIT_CODE}`
  （与 `GIT_TIMEOUT_EXIT_CODE` 同一手法，`util/git.ts:195` 先例），并发一条任务级告警
  + 一条 node event（`NODE_EVENT_KIND` 追加 `git-guard-tampered`，TEXT 列**无需 migration**，
  RFC-034 先例）。调用方按既有 `exitCode !== 0` 路径失败，不需要逐点改。

### 1.3 覆盖不到的残留

`.gitattributes` 驱动的 filter/diff 若配合**全局**config 里已存在的 filter 定义仍可生效
（agent 只需改 `.gitattributes` 即可命中用户全局的 `filter.lfs.*`）。当前仓**零 LFS 支持**
（全仓 grep 无命中），故 v1 不处理，登记 `docs/audit-backlog.md`。

---

## §2 G2 — macOS child 默认禁写（对齐 Linux）

`renderNetlessSeatbeltProfile`（`sealedSubprocess.ts:1110-1150`）当前是
`(allow default)` + 遮 masks，masks 之外可写。改为：

```
(version 1)
(allow default)
(deny file-write* (subpath "/"))          ; ← 新增：全局默认禁写
(deny network*)                            ; egress 关时；开时见 §4
(deny file-read* file-write* <每个 mask>)
(allow file-read-metadata (literal <可穿越祖先>))
(allow file-read* file-write* (subpath <每个 writable>))
(allow file-write-data (literal "/dev/null"))
(allow file-write-data (literal "/dev/dtracehelper"))
(allow file-write* (subpath "/dev/fd"))    ; 具体白名单以 gated 实跑收敛
(allow file-read* (subpath <bindReadOnly>))
(deny file-write* (subpath <bindReadOnly>))
```

顺序是 SBPL last-match-wins 的：全局禁写必须在 allow-back **之前**，`/dev` 例外与
只读覆盖必须在其**之后**。Linux 侧 `renderNetlessBwrapArgs` 已经是 `--ro-bind / /` +
`--dev /dev`，本节不改 Linux —— 目的正是让两平台**同一组断言可以共用一张测试表**。

`/dev` 白名单以真实 `sandbox-exec` 跑通 `python3 -c` / `/bin/sh` 常见写法为准
（gated `RUN_SANDBOX_ITEST=1`），设计不预先固化全集。

---

## §3 G3 — 外层「遮读 + 全局禁写」强档

### 3.1 policy 接口扩展

```ts
export interface SandboxPolicyInput {
  appHome: string
  taskWorktrees: readonly string[]
  runDir: string
  readOnlySubtrees?: readonly string[]
  /** RFC-252：env-hermetic 运行时才提供；提供即进入强档。 */
  hermetic?: { realHome: string }
  /** RFC-252：git 公共目录。path 模式仓库的 .git 在 $HOME 下，遮蔽后必须允许回来。 */
  gitCommonDirs?: readonly string[]
}

export interface SandboxPolicy {
  denySubtrees: string[]        // 强档下 = [appHome, realHome]
  denyFiles: string[]
  allowSubtrees: string[]       // + gitCommonDirs
  allowMetadataFiles: string[]
  readOnlySubtrees: string[]
  /** RFC-252：true ⇒ 全局默认禁写，仅 allowSubtrees + writeExceptions 可写。 */
  writeDenyDefault: boolean
  /** RFC-252：临时目录与 /dev 例外（D3：本轮不私有化 /tmp）。 */
  writeExceptions: string[]
}
```

弱档（`hermetic` 缺省）渲染结果与今天**逐字节不变**——存量调用方（claude、legacy、
system agent、distiller、smoke）零行为变化，这是 D4 的实现方式。

### 3.2 渲染

- **Seatbelt**：`(allow default)` → `(deny file-write* (subpath "/"))` →
  `(deny file-read* file-write* (subpath appHome|realHome))` → allow-back 读写 →
  metadata 祖先 → `writeExceptions` → RO 覆盖。
- **bwrap**：`--die-with-parent --unshare-pid --ro-bind / / --proc /proc --dev /dev`
  → `--tmpfs realHome` `--tmpfs appHome` → 对每个 allow-back 先 `--dir <被遮 mask 下的父链>`
  再 `--bind`（沿用 `sealedSubprocess.ts:1044-1051` 的 `parentDirs`/`--dir` 手法）
  → `--bind /tmp /tmp` `--bind /var/tmp /var/tmp`（writeExceptions）
  → `--ro-bind` readOnlySubtrees。

  bwrap 的 `--bind` 源路径按**原始根**解析，故「先 tmpfs 遮蔽、再 bind 其下子树」成立——
  这正是现网 `policy.ts:195-201`（tmpfs appHome 后 bind 其下 worktree）已在用的形态。

### 3.3 嵌套不变量（AC-4 的硬约束）

Linux 上 child bwrap 运行在 outer bwrap **内部**，child 的 `--bind <gitCommonDir>` 源路径
必须在 outer 的视图里存在。因此：

```
child.writable ∪ child.bindReadOnly  ⊆  outer.allowSubtrees ∪ outer.readable
```

实现上由 `verifiedPlan` 把 `gitCommonDirs`（它本来就要算给 netless manifest，
`verifiedPlan.ts:684`）一并放进 `SpawnPlan`，runner 合入 sandbox ctx。
加一条**纯函数断言** `assertNestedContainmentInvariant(outer, child)` 并在计划装配处调用，
测试直接对它下断言（不依赖真跑 bwrap）。

### 3.4 档位传递

`SpawnPlan` 增两个可选字段（与既有 `readOnlySubtrees` / `sessionStore` 同一 seam）：

```ts
hermeticOuter?: boolean          // 仅 buildVerifiedOpencode{Business,System}Plan 置 true
gitCommonDirs?: readonly string[]
```

`runner.ts:1373-1391` 合入 ctx；`buildRunSandboxCtx` 增加对应可选入参。
**不新增 requirement profile**：G3 不改变准入判据，只改变同一 profile 下策略的**内容**。
但 receipt 必须如实报告 —— `ContainmentRuntimeProjection.capabilities` 增补
`userHomeIsolation: 'strong' | 'absent'`，由 plan 的 `hermeticOuter` 决定，
供 Settings→Runtime 与任务告警显示。

### 3.5 macOS 的已知失效面（D5）

macOS 上凡 `agent.permission.bash !== 'deny'` 或有 local MCP 的节点，topology 是
`provider-child-only`（`containmentCoordinator.ts:755-758`），外层根本不被应用
（`sandbox/index.ts:132-134`）⇒ **G3 在这些节点上不生效**。这是本 RFC 明示接受的限制，
必须同时：(a) 在 `diagnostics` 里保留既有 `runnerSandboxed=false`；(b) 在
`docs/sandbox.md` 与 `docs/audit-backlog.md` 各记一条；(c) 不得让 receipt 声称
`userHomeIsolation: strong`（此时应为 `absent`）。

---

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
| hooks/config 被改后 daemon 跑 git | 该次 git 返回 `GIT_GUARD_EXIT_CODE`，调用方按既有失败路径处理 | 任务告警 + node event `git-guard-tampered` |
| gitguard 基线文件缺失/损坏 | 视为「无基线」⇒ 若无活跃任务则重封；有活跃任务则**拒绝**（fail closed） | 同上，理由码区分 |
| 强档下 child bind 源不存在 | 由 `assertNestedContainmentInvariant` 在装配期拦截 | `execution-identity-store-unsafe` |
| egress 能力不可用 | blocked（所有 mode） | `execution-identity-egress-unavailable` + Settings→Runtime 显示 |
| `network:'allow'` 但无模型子进程 | 正常运行，profile 退回 `runner-filesystem-v1` | 一条 info 级提示 |
| macOS bash 节点 + G3 | 外层不生效，`userHomeIsolation: 'absent'` | receipt / Settings 如实显示 |

## §6 测试策略

**必写（design 门要求全绿才算交付）**：

1. `gitHardening` 纯函数：`execCapableConfigKey` 正反例表（含大小写、通配名、
   平台自写键必须不命中）；`hardenedGitLeadingArgs` argv 顺序。
2. **红→绿回归**（直接复刻 proposal §背景 的实测脚本）：真 git 仓 + hook + fsmonitor，
   断言硬化前触发、硬化后不触发。文件顶端注明「锁 RFC-252 G1」。
3. `sealGitGuard`/`assertGitGuard`：篡改 hook / 加 `filter.x.smudge` / 删基线 /
   有活跃任务时不得重封 / 平台自写 `submodule.*.url` 不触发。
4. `computeSandboxPolicy` 强弱两档快照：弱档必须**与今天逐字节相同**（防回归）；
   强档断言 `writeDenyDefault` + realHome 进 deny + gitCommonDirs 进 allow。
5. `renderSeatbeltProfile` / `renderBwrapArgs` 强档渲染顺序断言（禁写在 allow-back 前、
   例外与 RO 在后）。
6. `assertNestedContainmentInvariant` 正反例。
7. `renderNetlessSeatbeltProfile` 默认禁写（G2）+ 与 Linux 共用的 writable/deny 断言表。
8. coordinator：新 profile 的 required 集合、egress fail-closed 三档（enforce/warn/off 全 blocked）、
   既有两档 profile 决策**零变化**。
9. driver profile 选择矩阵（§4.2 四行）。
10. shared schema + migration + 路由序列化 + 前端 AgentForm/chip + i18n 双语对称。
11. **gated 集成**（`RUN_SANDBOX_ITEST=1`）：macOS 真 `sandbox-exec` 跑 G2/G3/egress 三组；
    Linux 真 bwrap 跑强档 + egress（含 `python3` 真实 HTTPS + loopback 被拒）。

**不允许**：以「重跑就过了」作为通过依据（CLAUDE.md）。gated 用例必须能在本机稳定复现。

## §7 未决 / 交设计门复核

1. G3 的档位用 **plan 字段**（`hermeticOuter`）而非新增 requirement profile ——
   理由是它不改变准入判据只改变策略内容，且 `readOnlySubtrees`/`sessionStore` 已是同一 seam。
   若设计门认为必须进 capability registry，改动集中在 §3.4 一处。
2. Linux egress 的用户态网络栈选型与嵌套可行性（§4.4）。
3. `alias.*` 是否纳入 exec 键集：daemon 全部使用显式子命令，alias 不会被触发，
   纳入只增误报面；当前**纳入**是保守选择，设计门可要求剔除。
