# 运行时沙箱（RFC-205）

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

按 provider capability 包装 agent 进程：内置 provider 是 macOS `sandbox-exec`
（Seatbelt，随系统自带）与 Linux `bwrap`（bubblewrap，需安装且允许非特权 user
namespaces——探测以真实试跑为准）。OpenCode 核心不按 OS 名称准入，provider id 与能力
schema 是开放的；未来 Windows Job Object/AppContainer provider 可复用同一合同。

策略：整体遮蔽 `~/.agent-workflow`，放行**本任务** worktree（读写）、本 run 目录
（读写）、镜像 `repos/`（读写——worktree 的 gitdir/对象库在镜像内，只读会废掉
`git commit`）。`$HOME` 其余部分（模型 auth、/tmp、工具链）不受影响。

`config.json` 的 `sandboxMode`（Settings→Runtime 可改）：

| 档位           | 必要 capability 完整  | provider 缺失或 capability 不完整                          |
| -------------- | --------------------- | ---------------------------------------------------------- |
| `enforce`      | 包装运行              | **拒绝 OpenCode 执行**；daemon 与其它可用 runtime 照常运行 |
| `warn`（默认） | 包装运行              | 无隔离降级运行 + 每任务一条 `sandbox-degraded` 告警        |
| `off`          | 不启用 OS containment | 同左；这是管理员显式接受的策略，不会伪装成“安全执行”       |

状态可在 Settings→Runtime 查看 provider、capability、降级原因与档位；每次 spawn 的
日志带 `sandboxed=true/false`。macOS Seatbelt 的文件系统/子进程网络基线为 strong，
但对子孙进程生命周期的回收如实标为 best-effort；这不会再被误报成“只能在 Linux 运行”。

## 3. 自检：`agent-workflow sandbox`（RFC-216）

一条**只读**子命令，回答「主机此刻的沙箱机制能不能用、不能用怎么修」。它**只探测、只
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
- 装完 / 改完后**须重启 daemon** 生效——机制在开机时探测一次并缓存（`agent-workflow
stop && agent-workflow start`）。

退出码（可脚本化）：

| 情形                     | 默认 | `--require-available`               |
| ------------------------ | ---- | ----------------------------------- |
| 机制可用                 | 0    | 0（`mode≠off` 时）/ 1（`mode=off`） |
| `mode=off`               | 0    | 1（off ⇒ 沙箱未实际生效）           |
| 机制不可用（`mode≠off`） | 1    | 1                                   |
| config 不可读（损坏）    | 2    | 2                                   |
| 参数错误（未知 flag 等） | 2    | 2                                   |

`doctor` 也含一条只读沙箱检查项：仅 **`enforce` 且机制不可用**判 fail（镜像 launch 门），
`warn`/`off`/可用一律 informational——warn 机器缺 bwrap 不会让 `doctor` 变红。

## 已知限制

- 通用 RFC-205 外层边界不隔离网络；verified OpenCode 的 shell/local-MCP 子进程另有
  provider 级 no-network 边界。daemon 自身不在沙箱内。
- Windows 尚无发行二进制和真实 Job Object/AppContainer provider；当前交付的是开放
  provider/renderer 合同，不宣称 Windows 产品已完成。
- 进程侧信道（ps / /proc）不遮蔽——凭据已不入 argv/env，残余为低敏路径信息。
- `off` / 降级态与 RFC-205 之前等同（威胁未消除，仅可见）。
- bwrap 缺失的发行版需装 bubblewrap（跑 `agent-workflow sandbox` 拿发行版感知的精确
  命令，见 §3）；受限容器里即使安装也可能因禁用非特权 userns 而探测为不可用。
