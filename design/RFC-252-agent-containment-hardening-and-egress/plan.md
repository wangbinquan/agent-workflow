# RFC-252 · 任务分解

四个 PR 按「先堵可直接利用的洞、再补纵深、最后加能力」排序。PR-1/PR-2 互不依赖，
可并行；PR-3 依赖 PR-2 的 writable 断言表；PR-4 依赖 PR-3 的嵌套不变量。

## PR-1 · G1 daemon 侧 git 执行面收口

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| **T1** | 新建 `util/gitHardening.ts`：`gitHooksVoidDir` / `hardenedGitLeadingArgs` / `execCapableConfigKey`（纯函数） | — | 正反例表全绿；空 hooks 目录在 daemon 启动时以 `0500` 创建（幂等） |
| **T2** | `util/git.ts:runGit` 与 `gitRepoCache.ts:spawnGit` 统一前置覆盖集 | T1 | argv 顺序断言；两处**零**各自拼装残留（源码层文本断言） |
| **T3** | 红→绿回归：真 git 仓复刻 proposal §背景 的 `post-checkout` + `core.fsmonitor` 实测 | T2 | 硬化前触发、硬化后不触发；文件顶端注明锁定意图 |
| **T4** | `sealGitGuard` / `assertGitGuard` + 进程内 stat 缓存 + 落盘 `<appHome>/gitguard/` | T1 | 篡改 hook / 加 `filter.x.smudge` / 基线缺失 / 平台自写键不误报，四类各一例 |
| **T5** | 封存时机接入 `createWorktree` / cold clone / warm fetch / `initScratchRepo`，并实现「有活跃任务则不重封」 | T4 | 并发任务场景不 laundering；无任务时用户改动被吸收 |
| **T6** | 失败语义：`GIT_GUARD_EXIT_CODE` + 任务告警 + `NODE_EVENT_KIND` 追加 `git-guard-tampered`（无 migration）+ i18n 双语 | T4 | 告警可见；`runGit` "never throws" 契约不破 |

## PR-2 · G2 macOS child 默认禁写

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| **T7** | `renderNetlessSeatbeltProfile` 改默认禁写 + `/dev` 例外白名单 | — | 渲染顺序断言（禁写在 allow-back 前、例外在后） |
| **T8** | 抽出两平台共用的 writable/deny **断言表**，Linux 与 macOS 用同一张表 | T7 | 两平台断言集合相同；差异只允许出现在显式登记的例外行 |
| **T9** | gated 集成（`RUN_SANDBOX_ITEST=1`）：写 `/opt/homebrew/bin/x`、`/Users/Shared/x` 失败；写 worktree / scratch / 私有 HOME / gitCommonDir 成功；`/opt/homebrew/bin/python3` 仍可执行 | T7 | 本机可稳定复现 |

## PR-3 · G3 外层「遮读 + 全局禁写」强档

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| **T10** | `SandboxPolicyInput`/`SandboxPolicy` 扩展（`hermetic` / `gitCommonDirs` / `writeDenyDefault` / `writeExceptions`） | — | **弱档渲染逐字节不变**的快照测试（防存量回归） |
| **T11** | 两平台渲染强档（Seatbelt 顺序、bwrap `--ro-bind /` + tmpfs + `--dir` 父链 + writeExceptions） | T10 | 顺序断言 + 路径集合断言 |
| **T12** | `SpawnPlan.hermeticOuter` / `gitCommonDirs` 透传：`verifiedPlan` / `verifiedSystemPlan` 置位，`runner.ts` 合入 ctx，`buildRunSandboxCtx` 加参 | T10 | claude / legacy / distiller / smoke 路径**不**置位（源码层断言） |
| **T13** | `assertNestedContainmentInvariant(outer, child)` 纯函数 + 装配期调用 | T11,T12 | 正反例；child 的 gitCommonDirs 不在 outer 允许集时装配期即失败 |
| **T14** | receipt 增 `userHomeIsolation` 强度 + Settings→Runtime 显示 + `docs/sandbox.md` / `docs/audit-backlog.md` 各记一条 macOS 失效面 | T12 | macOS bash 节点上必须报 `absent`，不得报 `strong` |

## PR-4 · G4 受控出网

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| **T15** | shared `AgentSchema.network` + migration（编号实现期现取）+ 路由序列化 | — | 存量行 `null` ⇒ 行为等同 `deny`；migration 后 `foreign_key_check` 与行数校验 |
| **T16** | coordinator 新增 `model-child-egress-v1` + 能力名 `modelChildLoopbackDeny` | — | 既有两档 profile 的 `required` 集合**零变化**（快照锁） |
| **T17** | egress fail-closed 例外：enforce / warn / off 三档全 blocked + 新错误码 `execution-identity-egress-unavailable` | T16 | 三档各一例；错误码进 shared 码表 + i18n 双语 |
| **T18** | `driver.businessContainmentProfile` 接入 `agent.network`（§4.2 四行矩阵） | T15,T16 | 矩阵逐行断言；`network:'allow'` 且无模型子进程时给 info 提示 |
| **T19** | manifest `egress` 字段 + `codec` 升 2 | T16 | 旧 codec 被拒（`execution-identity-store-unsafe`） |
| **T20** | macOS egress 渲染（`network-outbound` 放行 + localhost 拒 + mDNSResponder） | T19 | 渲染断言 + gated 实跑：`python3` HTTPS 成功、`127.0.0.1` 失败 |
| **T21** | Linux egress 网络栈选型定稿（pasta / slirp4netns）+ 嵌套可行性 gated 实测 | T19 | 两条判据：外部 TCP 通 + 宿主 loopback 不通；**若嵌套均不可行则停下回设计门**，不得自行改拓扑 |
| **T22** | `qualifyLoopbackDenyProvider()` 资格探测（比照 `requireRootOwnedBwrap` 形态） | T21 | 缺 provider ⇒ 能力 `absent` ⇒ T17 的 blocked 路径 |
| **T23** | `agent-workflow sandbox` / `doctor` 增只读 egress 检查项 + 发行版感知安装命令 | T22 | 退出码语义不变；`warn`/可用一律 informational |
| **T24** | 前端：`AgentForm` `<Switch>` + agent 详情/列表 chip + 任务告警可见 + i18n 双语 + 文档（含 `pip install --user` 持久化与 venv 不要建在 worktree 的建议） | T15 | 复用既有公共组件，零自写 chrome |

## 依赖图

```
T1 → T2 → T3
 └→ T4 → T5
      └→ T6
T7 → T8 → T9
T10 → T11 → T13
 └→ T12 ──┘  → T14
T15 ┐
T16 ┼→ T18
T16 → T17
T16 → T19 → T20
          └→ T21 → T22 → T23
T15 → T24
```

## 交付前必过门禁

- `bun run typecheck && bun run lint && bun run test && bun run format:check && bun run depcheck` 全绿
- gated 集成：本机 macOS `RUN_SANDBOX_ITEST=1` 三组；Linux 侧至少在 CI 或一台 Linux 机上跑过 T21/T22
- Codex **实现门**（`docs/dev-gotchas.md` §Codex：从 pin 到自己 commit 的分离 worktree 跑）
- push 后按 exact SHA 查 CI

## 验收清单（对应 proposal AC）

- [ ] AC-1 / AC-2 → T3, T4, T5, T6
- [ ] AC-3 → T7, T8, T9
- [ ] AC-4 → T10, T11, T13
- [ ] AC-5 → T12（源码层断言 claude/legacy 不置位）
- [ ] AC-6 / AC-7 → T20, T21
- [ ] AC-8 → T17, T22, T23
- [ ] AC-9 → T14, T24
- [ ] AC-10 → T10（弱档字节不变快照）、T15（migration 不回填）、T16（既有 profile 快照）

## 未决（须在实现前由设计门或用户拍板）

1. design §7-1：G3 档位走 plan 字段还是 capability registry。
2. design §7-2：Linux egress 网络栈选型（T21 会给出实测结论）。
3. design §7-3：`alias.*` 是否留在 exec 键集。
