# RFC-254 · 真机验收记录（2026-08-04）

> AC-28 要求的原始证据。按设计门 P1-8 的要求记录**机器版本、命令与原始结果**，
> 而不是「记录存在」本身。

## 环境

| 项     | 值                                                          |
| ------ | ----------------------------------------------------------- |
| 主机   | macOS / Apple Silicon，Parallels Desktop（标准版）          |
| 客户机 | Windows 11，build **10.0.26200.8655**，**ARM64**            |
| 访问   | OpenSSH Server over Parallels shared network，`10.211.55.3` |
| Bun    | **1.3.14**（`bun-windows-aarch64`）                         |
| git    | **2.55.0.windows.3**                                        |
| 仓库   | 从 `\\Mac\Home\...` robocopy 到本地盘 `C:\aw`（见「踩坑」） |

## 结果

| 验收项                       | 结果                                                                       |
| ---------------------------- | -------------------------------------------------------------------------- |
| RFC-254 平台套件（6 个文件） | **84 pass / 2 skip / 0 fail**                                              |
| 负向扫描守卫                 | 4 pass / 0 fail                                                            |
| e2e 编译缝锁                 | 5 pass / 0 fail                                                            |
| NUL 字节守卫                 | 6 pass / 0 fail                                                            |
| `bun run typecheck`（三包）  | 全部 exit 0                                                                |
| `bun run build:binary`       | **`dist\agent-workflow-windows-arm64.exe`，123.9 MiB**，`version` 冒烟通过 |
| `<binary> doctor`            | 见下                                                                       |

### doctor 输出（关键行，原文）

```
✓ git version: git version 2.55.0.windows.3 (>=2.38.0)
✓ app home: C:\Users\wangbinquan\.agent-workflow (will be created on first daemon start)
✓ migrations folder: 138 migrations embedded in binary
✓ sandbox: 必要隔离能力不可用（platform-unsupported,required-capability-missing）；
           warn 档任务将显式降级运行，安装指引见 `agent-workflow sandbox`
✗ opencode binary: 'opencode' not found or not executable
```

前四条逐条兑现了设计：**D1/D20 的诚实降级呈现**（sandbox 那行不是崩溃、也不是
声称有边界，而是指名缺失的能力）、**D7 的 `%USERPROFILE%` 布局**、git 探测可用、
产物命名 `windows-<arch>` + `.exe` 正确。唯一的 ✗ 是虚拟机未装 opencode，属预期。

## 真机抓到而 CI 与 macOS 都抓不到的三条

### 1. ⚠️ Windows ARM64 的 Bun 构建禁用了 TinyCC ⇒ `bun:ffi dlopen()` 不可用

直接跑 FFI 探针得到：

```
THREW: Error: bun:ffi dlopen() is not available in this build (TinyCC is disabled)
```

**这推翻了 Job Object 实现的一条隐含前提**。后果是 T4 在该平台整体降级：
`adoptSpawnedProcessTree` 返回 false、回退 `taskkill /T /F`，而按设计门 P0-D，
taskkill-only 的清理**不得**被当作 runtime store 可回收的证据——所以
`isProcessTreeAlive` 在此返回 `null`（「无法判定」）而非 `false`。

生产代码的 `try/catch` 本来就正确降级了；错的是**我的测试**，它断言 win32 上
Job Object 必然可用。已改为「可用性是 Bun **构建**的属性，不是 Windows 的属性」，
并在不可用时反过来断言降级的诚实性（`owned === null` 且 liveness 为 `null`）。

x64 的 Bun 构建带 dlopen，而 x64 正是 D6 的发行目标，所以发行产物仍保有强保证。
**若将来要支持 ARM64 发行，必须先解决这一条**——已同步进模块头注释与
`docs/audit-backlog.md`。

### 2. `new URL(...).pathname` 在 Windows 上产出 `/C:/...`，`Bun.file` 打不开

我的 git 测试用它定位源码文件，在 Windows 上直接失败。改用
`resolve(import.meta.dir, ...)`——分隔符正确且与 `docs/dev-gotchas.md` 里
「cwd 敏感的 source-lock」那条一致。

### 3. `bun install` 在 UNC 网络盘（`\\Mac\Home\...`）上崩溃

Bun 1.3.14 在网络盘执行 workspace 安装时崩溃（生成 crash report）。
**这不是本平台的缺陷**，但任何想用 Parallels 共享目录直接开发的人都会撞到：
必须把仓库复制到客户机本地盘。已记入本文件供后续验收参考。

## 未在本轮真机覆盖的项

- 真 opencode 的业务工作流端到端（虚拟机未安装 opencode）
- Job Object 的原子杀树证明（本机 ARM64 构建无 FFI；需 x64 机器或 CI
  windows runner，`scripts/verify-windows-job-object.ts` 已就绪，
  在无 FFI 时会明确 SKIP 而不是假装通过）
- console 弹窗观察、长路径仓、Prism 仿真
- e2e / 视觉基线

## 复跑方式

```powershell
# 在 Windows 上，仓库位于本地盘
bun install --frozen-lockfile
./scripts/verify-windows-platform.ps1
```

## 续 2026-08-07：真 opencode 1.18.13 + glm-5.2 的 verified 执行端到端验收（T38）

用户在 Windows 11 **ARM64** 验收机（`reference_windows_vm`，`wangbinquan@10.211.55.3`）
部署了 **opencode 1.18.13** 并接上模型 **`alibaba-cn/glm-5.2`**，从而解锁上一轮「未覆盖」
清单里的「真 opencode 业务工作流端到端」。

**方法**：直接调 `services/runner.ts:runNode`（**无 `opencodeCmd` = 生产 verified 路径**，
非 legacy/mock），`runtimeParams.model=alibaba-cn/glm-5.2`、`ContainmentCoordinator`
mode `off`（Windows v1 无 provider，D1）、native `AGENT_WORKFLOW_HOME`、真 git worktree、
ambient auth 由 verified 路径镜像。跑一整条业务节点。

**结果 —— `STATUS=done`（首次在 Windows 确认 verified 执行成立）**：
`projectID`＝真 hash（非 `global`）、`session.path=""`、`validateSessionIdentity` 通过、
模型真实执行、node 完成并收下 workflow-output 信封。传输层（`direct API` 建会话+发消息+
真 LLM 响应+token 计量）此前已在续三十三单证；本轮是**整条生产 launcher 胶水层**首次
端到端跑通。

**过程中揪出并修复 3 处 win32 生产缺陷（提交 `c4a5ea4a`，qualification 簇 1033/0）**：

1. **关键**：`GIT_CONFIG_GLOBAL=NUL` 打死 git-for-Windows（MSYS2 只认 `/dev/null`）⇒
   opencode worktree 探测失败落 `global`/worktree=`/` ⇒ session `path` 不匹配 ⇒ 身份校验
   在 `/path` 拒。**这是 Windows verified 路径此前彻底不可用的元凶**。修＝host 无关的
   `GIT_NULL_CONFIG_PATH='/dev/null'`（3 站点）。
2. bootstrap 逐请求 `Math.min(2_000,…)` 太紧（首个 `/config/providers` 冷初始化 ~1.9s）⇒
   请求被 abort 且被 `stableFailureCode` 兜底成误导性 `mismatch`。修＝用 `bootstrapTimeoutMs`。
3. `verifiedInventory` 写入的 `0o600` mode 断言 win32 恒假。修＝`statMetadataIsAuthoritative` 门。

**唯一已知残留：verified 服务端 flaky 冷启动**（`bootstrap-failed`，统一 exit
`5=ACCESS_DENIED`）——真机确证是 Windows Defender 对每次运行新拷的 175MB 密封二进制的
实时扫描竞争，在启动期（image-map 与运行期访问都算）杀进程。**exec 层挡不住**（`--version`
预热 + 有界重生 spawn 组合紧循环压测只到 ~50%，故未落地、已回退，防脏敏感 launcher）。
**正解**：①ops —— 对 `~/.agent-workflow` 密封根加 Windows Defender 排除目录（零代码、彻底，
提交 `a4b9ea43` 已写入 `docs/sandbox.md` 部署要求）。**～～②架构：内容摘要缓存复用～～
续 2026-08-07（T41）真机证伪并撤销**：按源 digest 缓存复用密封二进制（每次 exec 前 + spawn 前
重哈希＝安全等价，已实现、四门全绿、POSIX 逐字零影响、win32-gated）**不解本缺陷**——反复 exec
**同一份已落盘缓存 `.exe`** 仍 ~⅕–⅓ 零输出秒退（8 次探针 5 listen / 3 `EXITED-NO-LISTEN
lines=0`；**密封目录 vs 未密封目录 4/5 vs 4/5 同率** ⇒ DACL/位置/名皆非因），即 Defender 每次
加载期都拦杀、非「首次扫净后免扫」；有界 respawn 4 次也只到 ~90%（连杀漏网）。**故唯一确定解
只剩 ①ops Defender 排除**（已在 `docs/sandbox.md`）。紧循环压测会
高估生产失败率（生产任务间隔拉开，模型调用本身数十秒）。详录见 `docs/dev-gotchas.md` +
`docs/audit-backlog.md`。

**本轮更新的「未覆盖」项**：「真 opencode 的业务工作流端到端」✅ 已覆盖（本条）。仍未覆盖：
Job Object 原子杀树（本机 ARM64 无 FFI）、console 弹窗、长路径仓、e2e/视觉基线（T33–T35，
CI-pipeline 产物）。
