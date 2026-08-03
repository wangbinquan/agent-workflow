# RFC-252 · 任务分解

**总纲**：每个 PR 都必须对正常 agent 行为零影响；凡「为安全而可能让任务失败」的手段
一律不进（原 G1 检测层、原 G3 外层强档已据此移出，见 proposal §非目标）。

三个 PR，按「先堵已实证的洞、再补对称性、最后加能力」排序。

## PR-1 · G1 daemon 侧 git 执行面收口 —— ✅ 已交付

| ID | 任务 | 状态 |
| --- | --- | --- |
| **T1** | 新建 `util/gitHardening.ts`：`gitHooksVoidDir` / `ensureGitHooksVoidDir` / `hardenedGitLeadingArgs` / `gitSubcommandIndex` / `withExternalDiffDisabled` / `hardenGitArgs` | ✅ |
| **T2** | `util/git.ts:runGit` 与 `gitRepoCache.ts:spawnGit` 两处生产 git spawn 统一接入 | ✅ |
| **T3** | `gitSubmodule.ts:syncSubmodules` argv 固定 `--checkout` | ✅ |
| **T4** | `rfc252-git-hardening.test.ts`：3 纯函数用例 + 4 成对回归用例 + 1 submodule argv 用例 | ✅ 8/8 |
| **T5** | 变异验证（摘掉修复即变红） | ✅ 覆盖集→`[]` 5 红；`withExternalDiffDisabled`→恒等 2 红；还原 8 绿 |
| **T6** | 受影响面回归：git-noninteractive-env / git-repo-cache{,-submodule} / worktree-submodule-init / worktree-working-branch（42 pass 9 skip 0 fail）、RFC-210 五套（22/22）、diff 五套（22/22） | ✅ |

**交付说明**：`-c` 优先级高于**所有** config 作用域，因此顺带覆盖了 `config.worktree` 与
`.git/modules/**/config`，无需枚举（设计门 P0-3 由此消解）。未覆盖的通配名族
（`filter.*` / `diff.*.textconv` / local `credential.helper`）见 design §1.3，登记 backlog。

## PR-2 · G2 macOS child 默认禁写

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| **T7** | `renderNetlessSeatbeltProfile` 从 `(allow default)` 改为默认禁写 + 显式 allow-back + `/dev` 例外白名单 | — | 渲染顺序断言（禁写在 allow-back 前、例外与只读覆盖在后） |
| **T8** | 抽出两平台共用的 writable/deny **断言表**，Linux 与 macOS 共用 | T7 | 两平台断言集合相同；差异只允许出现在显式登记的例外行 |
| **T9** | gated 集成（`RUN_SANDBOX_ITEST=1`）：写 `/opt/homebrew/bin/x`、`/Users/Shared/x` 失败；写 worktree / scratch / 私有 HOME / gitCommonDir 成功；`/opt/homebrew/bin/python3` **仍可执行**（只读而非遮蔽） | T7 | 本机稳定复现 |

## PR-3 · G4 受控出网（closure 级）

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| **T10** | shared `AgentSchema.network` + migration（编号实现期现取）+ 路由序列化 + `agent.md` round-trip + service mapper（DB `NULL` 必须在 mapper 省略，运行期只认精确 `'allow'`） | — | 存量行行为字节不变 |
| **T11** | coordinator 新增 `model-child-egress-v1` + 能力 `modelChildLoopbackDeny`；既有两档 profile 定义**零改动** | — | 既有 profile digest 快照锁 |
| **T12** | egress fail-closed：**复用 RFC-253 交付的 `failClosed: true` profile 字段**（不再自建 `#evaluate` 例外），只在 `model-child-egress-v1` 上声明 + 新错误码 `execution-identity-egress-unavailable` | T11、**RFC-253 的 `failClosed` 字段先落地** | 三档各一例；含 mode 在 qualification 期间切换的用例。若 RFC-253 延期，退路是本 RFC 自建同形逻辑并在其落地后合并 |
| **T13** | `businessContainmentProfile` 入参扩展到可见 `dependents`；按整条 closure 判定「有模型可控子进程」与 network 一致性（不一致 ⇒ 启动期显式失败） | T10,T11 | §4.2 矩阵逐行 + closure 正反例；顺带锁住「root bash deny + 成员 bash allow」不再落 `childBoundary:'none'` |
| **T14** | manifest `egress` 字段；`codec` 升 2 且 **reader 兼容 v1**（v1 归一化为 `egress:'deny'`）——wrapper 会再次 exec 产品入口，原位升级/恢复旧任务时 v1 manifest 仍会被读到（设计门 P1） | T11 | v1/v2 双向读取用例 |
| **T15** | macOS egress 渲染（`network-outbound` 放行 + localhost 拒 + mDNSResponder unix socket） | T14 | 渲染断言 + gated 实跑 |
| **T16** | Linux egress 网络栈选型定稿（pasta / slirp4netns）+ 嵌套可行性 gated 实测 | T14 | 外部 TCP 通 + 宿主 loopback 不通；**均不可行则停下回设计门** |
| **T17** | `qualifyLoopbackDenyProvider()` 资格探测（比照 `requireRootOwnedBwrap` 形态：canonical 路径 + root 属主 + 祖先链 + 真实双向试跑） | T16 | 缺 provider ⇒ 能力 `absent` ⇒ T12 的 blocked 路径 |
| **T18** | `agent-workflow sandbox` / `doctor` 增只读 egress 检查项 + 发行版感知安装命令 | T17 | 退出码语义不变 |
| **T19** | 前端：`AgentForm` `<Switch>` + 详情/列表 chip + receipt/告警可见 + i18n 双语 + 文档（`pip install --user` 在同一业务链持久；venv 不要建在 worktree 内否则进 diff/快照） | T10,T12,T17 | 复用既有公共组件，零自写 chrome |

## 依赖图

```
PR-1: T1 → T2 → T4 → T5 → T6
        └→ T3 ──┘
PR-2: T7 → T8 → T9
PR-3: T10 ┐
      T11 ┼→ T12 → T19
          ├→ T13
          └→ T14 → T15
                 └→ T16 → T17 → T18 → T19
```

## 交付前必过门禁

- `bun run typecheck && bun run lint && bun run test && bun run format:check && bun run depcheck` 全绿
- gated 集成：本机 macOS `RUN_SANDBOX_ITEST=1`；Linux 侧 T16/T17 至少在一台 Linux 机或 CI 上跑过
- Codex **实现门**（分离 worktree，pin 到自己的 commit）
- push 后按 exact SHA 查 CI

## 验收清单（对应 proposal AC）

- [x] AC-1 / AC-2 / AC-2b → T1–T6（含变异验证与「功能未被搞坏」同批断言）
- [ ] AC-3 → T7, T8, T9
- [ ] AC-6 / AC-7 → T15, T16
- [ ] AC-8 → T12, T17, T18
- [ ] AC-9 → T12, T17, T19
- [ ] AC-10 → T10（migration 不回填）、T11（既有 profile 快照）

## 未决（见 design §7）

1. Linux egress 网络栈选型与嵌套可行性（T16 给结论）。
2. mixed closure 取显式失败（当前设计）还是并集——已定为显式失败，实现期不得改判。
3. G3 重做时必须走 coordinator-owned profile/capability。
