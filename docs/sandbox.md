# 运行时 containment（RFC-205 / RFC-233）

agent 进程（opencode / claude-code）与 daemon 同 UID。没有 OS 边界时，一次提示注入
就能让 agent 读走 `~/.agent-workflow/secret.key`（解开全部封存凭据）、`db.sqlite`、
`backups/`，以及其它任务的 worktree。RFC-205 引入两层防线：

## 1. 凭据不落盘（无条件生效）

- 镜像仓库 `.git/config` 的 origin **不再含凭据**（clone 即用脱敏 URL；存量镜像在下次
  warm fetch 时幂等清洗）。
- daemon 侧的网络 git（clone / fetch / auto-push）凭据经 **一次性 askpass 租约**注入：
  秘密只存在于 `~/.agent-workflow/.gitcred-*`（0600、用完即删、位于沙箱拒绝区），
  argv 与 env 永不携带明文。
- 副作用（有意）：agent 在 worktree 里 `git push origin` 拿不到平台凭据——凭据只有
  daemon 能用。子模块远端凭据独立于主仓，不在本机制范围（已知限制）。

## 2. FS 沙箱（`sandboxMode`）

每次 spawn 先由 daemon-scoped `ContainmentCoordinator` 按明确 profile 做一次 fresh
admission，再把同一份不可变 plan 传给 runner、OpenCode launcher 和 child renderer。弱
discovery 只提供诊断，不能再把“bwrap 能启动”提升为“OpenCode 所需能力完整”。

按 provider capability 包装 agent 进程：内置 provider 是 macOS `sandbox-exec`
（Seatbelt，随系统自带）与 Linux `bwrap`（bubblewrap，需安装且允许非特权 user
namespaces——探测以真实试跑为准）。OpenCode 核心不按 OS 名称准入，provider id 与能力
schema 是开放的；未来 Windows Job Object/AppContainer provider 可复用同一合同。

策略：整体遮蔽 `~/.agent-workflow`，放行**本任务** worktree（读写）、本 run 目录
（读写）、镜像 `repos/`（读写——worktree 的 gitdir/对象库在镜像内，只读会废掉
`git commit`）。`$HOME` 其余部分（模型 auth、/tmp、工具链）不受影响。

`config.json` 的 `sandboxMode`（Settings→Runtime 可改）：

| 档位           | 必要 capability 完整  | provider 缺失或 capability 不完整                                             |
| -------------- | --------------------- | ----------------------------------------------------------------------------- |
| `enforce`      | 包装运行              | 仅拒绝需要该 profile 的执行，稳定码 `execution-identity-containment-required` |
| `warn`（默认） | 包装运行              | 无隔离降级运行 + 每任务一条 `sandbox-degraded` 告警                           |
| `off`          | 不启用 OS containment | 同左；这是管理员显式接受的策略，不会伪装成“安全执行”                          |

`warn` 资格失败的原子结果只能是 `none + degraded`，不会再进入 OpenCode core 后被第二套
判据阻断。`off` 不启动 provider qualification。状态可在 Settings→Runtime 查看
configured/effective mode、provider、profile、capability、reason code 和 probe/policy
generation；每次 spawn 的日志带 admission generation 与 `sandboxed=true/false`。macOS
Seatbelt 的文件系统/子进程网络基线为 strong，
但对子孙进程生命周期的回收如实标为 best-effort；这不会再被误报成“只能在 Linux 运行”。

## 3. 自检：`agent-workflow sandbox`（RFC-216）

一条**只读**子命令，回答「主机此刻能否满足 OpenCode 隔离 profile、不能用怎么修」。它**只探测、只
打印**——绝不跑包管理器、绝不改 sysctl、**不写任何文件**（连读 config 都走只读路径，缺
文件也不建目录/不落默认配置）。需要 root 的命令由它**打印**、你来执行；命令本身无需
sudo、无需 daemon 在跑。

```
agent-workflow sandbox                      # 打印机制 / 可用性 / 精确修复指引
agent-workflow sandbox --require-available   # 严格档：沙箱未实际生效即非零（CI/provisioning）
agent-workflow sandbox --help
```

- **macOS**：`sandbox-exec` 随系统自带，通常直接 ✅，无需安装。
- **Linux 未装 bwrap**：打印检测到的**发行版感知**安装命令（`Bun.which` 按
  apt>dnf>pacman>apk>zypper 取 PATH 首命中，如实标注「检测到 PATH 上的包管理器」）。
- **Linux 装了 bwrap 但试跑失败**：先给 `exit` 码 + stderr 证据，再**有条件**提示
  userns sysctl（⚠️ 放开会扩大全机攻击面，且为启发式推断、非确证）。
- 安装 provider / 调整内核策略后，下一次任务 admission 会重新精确检查，**无需重启
  daemon**。Settings 修改 `sandboxMode` 也会热生效；只有离线直接改配置文件时，运行中的
  daemon 才需要重启以载入该 mode。

退出码（可脚本化）：

| 情形                     | 默认 | `--require-available`               |
| ------------------------ | ---- | ----------------------------------- |
| 机制可用                 | 0    | 0（`mode≠off` 时）/ 1（`mode=off`） |
| `mode=off`               | 0    | 1（off ⇒ 沙箱未实际生效）           |
| 机制不可用（`mode≠off`） | 1    | 1                                   |
| config 不可读（损坏）    | 2    | 2                                   |
| 参数错误（未知 flag 等） | 2    | 2                                   |

`doctor` 也含一条只读隔离检查项：仅 **`enforce` 且必要能力不可用**判 fail，
`warn`/`off`/可用一律 informational——warn 机器缺 bwrap 不会让 `doctor` 变红。

## 已知限制

- 通用 RFC-205 外层边界不隔离网络；verified OpenCode 的 shell/local-MCP 子进程另有
  provider 级 no-network 边界。daemon 自身不在沙箱内。
- Windows **有**发行二进制（x64，RFC-254）与 Job Object 进程树治理，但**没有
  containment provider**：`enforce` 档拒绝启动、`warn` 档原子降级到无边界并出
  告警、`off` 档不做合格判定。provider 合同按**能力**而非 OS 名写，未来的
  Job Object / AppContainer provider 可直接接入而不动核心准入。真机实测的
  `doctor` 输出见 `design/RFC-254-windows-native-execution/acceptance-real-machine-2026-08-04.md`；
  未决项逐条见 `docs/audit-backlog.md` 的「Windows 平台的四条未决项」。

  **win32 v1 相对 POSIX 的语义降级清单（D20）**——唯一事实源是
  `design/RFC-254-windows-native-execution/design.md` §10，此处是它的运维视角摘要，
  两处不一致时以 design.md 为准：
  1. **零隔离**：业务 agent / 系统 agent / 脚本 / 安装器都以 daemon 用户权限直跑，
     等价于 POSIX 上把 sandboxMode 设成 off/warn 且无机制可用；`enforce` 与脚本节点
     的 failClosed 档**拒绝执行**而不是降级。
  2. **seal 的写保护**走 owner+DACL 断言，不是「跳过 chmod」；digest 复验仍是
     TOCTOU 的主防线。
  3. **秘密文件**（token / secret.key / db.sqlite / 一次性凭据 / shutdown nonce）
     在 win32 由 owner+DACL 承担保护，`doctor` 如实呈现当前是哪一档；DPAPI 加固仍在
     backlog。**注意 `stat` 的 mode 位在 Windows 上不是事实**——它对每个文件都报
     0o666，所以「mode 600」既不能作为保证也不该被报成发现项。
  4. **git 硬化的写保护弱化**：`hooksPath` 指向空目录仍能防 hook 执行，但该目录本身
     可写（chmod 是 no-op）。
  5. **杀树语义**：设计主档是 Job Object 的 kill-on-close（原子）。**v1 尚未接线**
     ——原语已实现并有测试，但还没有任何 spawn 进入 job，实际回退到 `taskkill /T /F`
     枚举，因此**进程树回收是 best-effort，不支撑运行时 store 的回收证明**。
  6. **daemon 硬杀**：`stop` 在 win32 走 loopback 控制通道请求优雅关停；请求投递不了
     时才强杀，且**明确输出「这不是优雅关停」**（`SIGTERM` 在 Windows 等同强杀，旧
     行为会一边硬杀一边报告 stopped）。跨 daemon 重启的残留由 boot reaper 兜底。
  7. **上游弱项**：opencode 在 win32 的 MCP 子孙清理是 no-op，FFF 默认关闭。
  8. **env 名的大小写折叠是新增安全面**：Windows 环境变量名大小写不敏感，所有黑白
     名单都经单点折叠，混合大小写绕过在三平台都有测试锁定。
  9. **部署要求 —— 给密封根加 Windows Defender 排除目录**：verified 路径每次运行把
     ~175MB 的 opencode 二进制新拷进 `~/.agent-workflow/…/opencode-stores/…` 再执行，
     Defender 实时扫描会与「拷完即 exec」竞争，间歇把服务端进程杀在启动期（exit
     `5=ACCESS_DENIED`、零输出 → `bootstrap-failed`；真机紧循环压测下可达约半数）。这是
     AV 与构建产物的标准冲突，**部署时对 `~/.agent-workflow` 加 Defender 排除目录**即可
     根除（`Add-MpPreference -ExclusionPath`，需管理员）。代码侧的治本方向是按内容摘要
     缓存复用密封二进制、不每次重拷（Defender 只扫一次），属 RFC-227「per-run seal」不
     变量的设计级变更，见 `docs/audit-backlog.md` 与 `docs/dev-gotchas.md` 详录；exec 层
     的预热/重生 spawn 实测只到 ~50%（Defender 也杀运行期访问，非只 image-map），不采纳。

- 进程侧信道（ps / /proc）不遮蔽——凭据已不入 argv/env，残余为低敏路径信息。
- `off` / 降级态与 RFC-205 之前等同（威胁未消除，仅可见）。
- bwrap 缺失的发行版需装 bubblewrap（跑 `agent-workflow sandbox` 拿发行版感知的精确
  命令，见 §3）；受限容器里即使安装也可能因禁用非特权 userns 而探测为不可用。
