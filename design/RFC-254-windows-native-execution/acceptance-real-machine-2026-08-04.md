# RFC-254 · 真机验收记录（2026-08-04）

> AC-28 要求的原始证据。按设计门 P1-8 的要求记录**机器版本、命令与原始结果**，
> 而不是「记录存在」本身。

## 环境

| 项 | 值 |
|---|---|
| 主机 | macOS / Apple Silicon，Parallels Desktop（标准版） |
| 客户机 | Windows 11，build **10.0.26200.8655**，**ARM64** |
| 访问 | OpenSSH Server over Parallels shared network，`10.211.55.3` |
| Bun | **1.3.14**（`bun-windows-aarch64`） |
| git | **2.55.0.windows.3** |
| 仓库 | 从 `\\Mac\Home\...` robocopy 到本地盘 `C:\aw`（见「踩坑」） |

## 结果

| 验收项 | 结果 |
|---|---|
| RFC-254 平台套件（6 个文件） | **84 pass / 2 skip / 0 fail** |
| 负向扫描守卫 | 4 pass / 0 fail |
| e2e 编译缝锁 | 5 pass / 0 fail |
| NUL 字节守卫 | 6 pass / 0 fail |
| `bun run typecheck`（三包） | 全部 exit 0 |
| `bun run build:binary` | **`dist\agent-workflow-windows-arm64.exe`，123.9 MiB**，`version` 冒烟通过 |
| `<binary> doctor` | 见下 |

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
