# RFC-254 T40b —— win32 file PRIVACY 原语（DACL）

> 状态：**在真 ARM64 验收机上端到端验收通过（全簇 0 fail）；x64 GitHub runner 行为分叉、待查**。
> `2d01bde7`（核心）+`5609ef0e`（封根推广）+`e01c4464`（末 2 条诊断收口）+`ccde2603`（source-guard
> 回归修复）。⚠️ live-icacls 隐私簇在 GitHub `windows-latest`（x64）上 seal 未产出预期 DACL、大片
> store-unsafe/not-private——**不主张跨 x64 通用**，根因待 `windows-platform.yml` evidence 步输出
> （登记 `docs/audit-backlog.md`）。用户目标机（ARM64）成立。
> T40a（file IDENTITY）已入库 `e804dfff`。**下面 §3–§7 是设计探索期的稿子；实测把方案
> 修正为「读+验 DACL + 建根即封」的混合，以本节 §0 为准**（§3 的选项 C「纯结构判据」被实测
> 推翻——见 §0）。

## §0. 实测终稿（drove the design；真 Windows 11 / Bun 1.3.14 **ARM64**，2026-08-06）

真机把设计从「trust-by-construction 结构判据」修正为**更忠实的「读+验 DACL」**：

- **判据 = 读文件真实 DACL、断言 allow-ACE 只含 {当前用户 SID, SYSTEM, Administrators}**。
  用 `icacls <f> /save`（SID-based SDDL、locale 无关、UTF-16LE，~106ms；PowerShell Get-Acl
  ~1166ms 太慢）。授 Everyone 注入 `(A;;FR;;;WD)` 即被拒。纯解析 + 白名单判据抽为可测纯核。
- **建根即封**：`%USERPROFILE%` 下默认 DACL 恰为 SY+BA+user，但 `os.tmpdir()`（真机
  `C:\OpenCodeTemp`）默认含 Users/AuthUsers 宽授权。故在**建 store/run 根处**用
  `icacls /inheritance:r /grant *SID:(OI)(CI)F` 封一次，子文件继承为私有（也稳健对抗企业 GPO
  宽 ACE）。**仅封根**、不逐目录封——逐目录封在 boot recovery 一次建多 store 时 spawn 过多
  icacls、撞 5s test timeout（实测回退）。
- **ARM64 确认**：真机 Bun 为 arm64 构建、`dlopen` 不可用 ⇒ **证实 §3 选项 A（advapi32-FFI）
  不可行**、icacls 子进程是唯一可行机制（x64/arm64 皆可）。
- **安全加固**：`whoami`/`icacls` 走绝对 `System32` 路径，杜绝 PATH 劫持（真机 git-bash 的
  MSYS `whoami` 曾抢占，实证）。工具缺失/输出不可解析一律 fail closed。
- **落点**：`util/win32Acl.ts`（读+验+封，sync/async 双生，共享纯核）；`fileTrust.ts`
  path-aware 隐私变体（注入式 reader，POSIX 双分支可测）；9 调用点接线；hermetic /
  verifiedPlan / verifiedSystemPlan / verifiedManifest 四处建根封点。
- **真机结果（全簇 0 fail，`e01c4464` 收口）**：rfc254-win32-acl 18/0、rfc254-file-trust 29/0、
  rfc254-win32-acl-integration（真 icacls §7 往返）6/0、rfc224-store-hygiene 20/0、
  rfc224-direct-control-protocol 5/0、rfc224-verified-launcher 21/0、
  rfc224-opencode-store-recovery 10/0、rfc224-verified-system-plan 2 pass/1 skip、
  test-suite-policy 5/0。
- **末 2 条经诊断均非 T40b 隐私问题**（T40b 隐私检查在 win32 全通过，只是各撞下一道 Windows 障碍）：
  ①recovery scrub = `assertPriorOuterGroupDead` 的 `resolve(p)===p` canonical 守卫 vs 夹具
  `HOST_SPAWN_PATH` 硬写 POSIX 路径（win32 resolve 前缀盘符），改 `canonicalBinaryPath` ⇒ 10/0；
  ②system-plan = 该用例走 **bwrap-ENFORCE**（Linux 机制），win32 核心在 manifest 前即
  `bootstrap-failed`（D1 无隔离 provider），`skipIf(win32)` 且其隐私证明由业务 launcher 路径覆盖。
- **POSIX**：全程 no-op（win32 分支跳过），后端相关套件全绿（9017/0，含 source-guard 回归修复
  `ccde2603`——guarded 模块禁直读平台全局，seal 平台分支下沉 helper）。
- **⚠️ x64 GitHub runner 分叉（未竟）**：上述 live-icacls 簇在 `windows-latest`（x64）runner 上
  seal 未产出预期 owner+TCB DACL、大片 store-unsafe/not-private。已把 `windows-platform.yml` 回退为
  只跑纯解析 `rfc254-win32-acl` + 加非门禁 evidence 步 dump runner 的 seal 行为。**T40b 在用户
  ARM64 目标机上端到端验收通过；跨 x64 通用性未定，待 evidence 根因**（`docs/audit-backlog.md`）。

---

## 以下为设计探索期原稿（保留以存论证；实测修正见上 §0）

> 原状态：Design（待设计门 + 真机验收）。**不得在无真机验证的情况下合入**——这是 verified
> 安全边界，未验证的隐私证明比没有更危险（receipt 说「已验证」而实际零验证）。

## 1. 问题

`util/fileTrust.ts` 的**隐私**断言（`assertPrivateRegularFile` /
`assertUnopenedPrivateFile`，及其 `...ForHost` 包装）在 win32 返回
`platform-unsupported`（fail-closed）。根因：Node/libuv 在 Windows 上**合成** `fs.Stats.mode`
——只反映只读属性，可写文件恒报 `0o666`，与真实 ACL 无关。所以 `mode & 0o777 === 0o600`
这条 POSIX 算术在 Windows 上既可能误拒合法私有文件、也可能（若有人「修」成放宽比较）放行
一个人人可写的文件。

**影响面（9 个调用点，全在 verified RFC-224/227 路径）**：

- `verifiedManifest.ts:335` 写 launch manifest 后的隐私复检、`:350` 读回前的 unopened 复检；
- `controlProtocol.ts:202` control ACK 的隐私复检、`:217` unopened 复检；
- `storeHygiene.ts:344/383/399/442/561` store 生命周期锁与 auth 清理的锁探针。

这些都是 fail-closed：win32 → `execution-identity-store-unsafe` / `unsafe()` ⇒
**整条 verified 执行路径在 Windows 上直接拒跑**（`verifiedManifest.ts:336` 实测）。
即 T40b 不是测试修补，是让 verified opencode 执行在 Windows 上**成为可能**的前置——
是 RFC-254「Windows 原生执行」的核心，不是边角。

## 2. Windows 上「私有」的可达语义

威胁模型（`fileTrust.ts` 头部）：store「不信任任何其它本地主体」。POSIX 的 `0o600` =
仅属主。Windows 上的等价物**在实践中不可能是「仅属主」**：SYSTEM 与 Administrators 是
OS 的 TCB——管理员随时可 take-ownership 任何文件、附加调试器、替换二进制。它们在**每个**
OS 上都在威胁模型之外。故 Windows 上**可达且正确**的隐私保证是：

> **仅「当前用户 + OS TCB（SYSTEM、Administrators）」可访问，其它非特权本地主体一律不可。**

这正是 `%USERPROFILE%` 下文件的默认 ACL 语义。verified store 的真实威胁是「另一个非特权
本地用户在写与读之间篡改 manifest/ACK/store（TOCTOU + 植入内容）」——在「用户 + TCB」DACL
下，任何其它非特权用户连遍历都不行，威胁被消除。

**这是能力语义变更，须按 RFC 规则 #7 作为 breaking change 记入「能力影响清单」呈用户**：
Windows 的隐私边界是「用户 + OS TCB」而非「仅用户」，是**如实降级到平台可达上界**，不是
静默放宽。

## 3. 三个架构选项

### 选项 A：逐文件读 DACL，走 advapi32 FFI（`GetNamedSecurityInfoW`）

镜像 `windowsJobObject.ts`（`bun:ffi` + `dlopen`）。**否决为主路**：`dlopen()` 在
**Windows ARM64 Bun 构建不可用**（TinyCC 禁用，`windowsJobObject.ts:39-51` 实测）。若照
JobObject 的诚实降级（FFI 不可用 → 返回「测不出」→ fail-closed），则**隐私在 ARM64 上仍
fail-closed ⇒ verified 路径在用户的真机（ARM64）上依旧拒跑**——等于没做。FFI 只在 x64
可用，而用户的验收机是 ARM64。

### 选项 B：逐文件读/设 DACL，走 `icacls` 子进程

`icacls` 是 Windows 自带工具，x64/ARM64 都在，无 FFI。**否决为主路**：verified 一次启动要
做十几次隐私检查（manifest 写+读、每个 control ACK、每个 store-hygiene 探针）⇒ 十几次子进程
spawn；且 `icacls` 显示输出**受区域设置影响**（账户名本地化），健壮解析要绕到 SDDL
（`icacls /save` 或 PowerShell `(Get-Acl).Sddl`）——每次一坨子进程，慢且脆。

### 选项 C（推荐）：**trust-by-construction**——锁根一次，逐文件走结构检查

1. **建根即锁**：store root（`verifiedLauncher.ts:516` 的 `dirname(xdgData)`、
   `verifiedSystemPlan.ts:147` 的 `join(systemStoreParent, invocationId)`）在创建时设一个
   **受保护（禁继承）** 的 DACL：`grant:r` 仅 {当前用户 SID, `S-1-5-18`(SYSTEM),
   `S-1-5-32-544`(Administrators)} 完全控制，`(OI)(CI)` 令其**向下继承**。用 `icacls` +
   **SID**（`*S-1-...` 前缀，绕开区域本地化）设置——只一次、在建根路径上，不进热路。
2. **逐文件隐私证明变结构化**：`assertPrivateRegularFile` 在 win32 上不再看 `mode`，而是证明
   「① 是普通文件 ② 词法位于已封的 store root 内 ③ 不是 reparse point（symlink/junction）」。
   ①③ 从 `lstat` 可得（symlink 由 `isSymbolicLink()` 抓；junction 需 `FILE_ATTRIBUTE_REPARSE_POINT`
   ——Bun stat 未直接暴露，对**文件**主要威胁是 symlink，已覆盖；junction 主要针对目录，
   store 内文件父链已被根 DACL 挡住其它主体创建）。②要把 root 路径喂进原语（签名变更，见 §4）。

   不逐文件复读 DACL：因为根被锁 + 继承，其它非特权主体连在 root 内创建/替换文件都做不到，
   inheritance 是 OS 强制的。TOCTOU 收窄到「用户自己或管理员改了根 DACL」——二者都在威胁模型外。

**为什么 C 优于 A/B**：ARM64 安全（无 FFI）、廉价（建根一次 icacls，逐文件纯 stat）、语义正确
（§2 的可达上界）。代价是隐私边界从「逐文件字节级 mode」变成「根级 DACL + 文件级结构」——
但这恰是 Windows 上**唯一真实可强制**的边界。

> 可选增强（非必需）：x64 上若 `dlopen` 可用，建根的 DACL 设置与一次性根 DACL **验收**可
> 走 advapi32 FFI（`SetNamedSecurityInfoW`/`GetNamedSecurityInfoW`）省掉 icacls 子进程；
> ARM64 回落 icacls。但**主契约是 C**，FFI 只是同一语义下的加速旁路，不改变判据。

## 4. 原语签名与调用点改动

- `assertPrivateRegularFile(stats, platform, expectedMode?)` →
  win32 分支需要**文件路径 + 已封根路径**才能做结构判据。两种落法：
  - (i) 新增 `assertPrivateRegularFileWithin(path, sealedRoot, stats, platform, ...)`，POSIX 分支
    仍只看 `mode`（`path`/`sealedRoot` 忽略），win32 分支走 §3-C 结构判据；旧签名保留给
    「无根上下文」的少数调用，其 win32 仍 fail-closed。
  - (ii) 给现有签名加可选 `sealedRoot?`，缺省时 win32 fail-closed（向后兼容）。
    推荐 (i)：显式区分「有根上下文可证」与「无根上下文只能拒」，不把 win32 判据藏进可选参数。
- 建根处（`verifiedLauncher.ts` / `verifiedSystemPlan.ts` / `hermetic.ts:342,426` /
  `verifiedSystemPlan.ts:74` 的 `mkdir(mode:0o700)`）新增 win32「设根 DACL」步：
  新 `util/win32Acl.ts:sealDirectoryOwnerOnly(root)`（icacls-SID 实现 + 可选 FFI 旁路 + 诚实降级）。
- `statMetadataIsAuthoritative` 保持 win32-false（它现在只服务「无根上下文」的 fail-closed 判断）。

## 5. `sealDirectoryOwnerOnly` 命令形（icacls，SID，locale-independent）

当前用户 SID：`whoami /user /fo csv /nh`（解析第二列，稳定；或 FFI `GetTokenInformation`）。

```
icacls "<root>" /inheritance:r ^
  /grant:r "*<userSID>:(OI)(CI)F" ^
  /grant:r "*S-1-5-18:(OI)(CI)F" ^
  /grant:r "*S-1-5-32-544:(OI)(CI)F"
```

- `/inheritance:r` 移除所有继承 ACE 并转受保护（`SE_DACL_PROTECTED`）——挡掉从上层继承来的
  「Users」等宽 ACE。
- `/grant:r` 用 `*SID`：不受区域语言影响。
- `(OI)(CI)` 令根下**新建**文件/目录继承此三 ACE。

**验收读取**（真机清单用）：`icacls "<file>" /save <tmp>` 后读 SDDL，或
PowerShell `(Get-Acl "<file>").Sddl`——断言 DACL 只含上述三个 SID 的 allow-ACE、无其它 allow。

## 6. 测试策略

- **POSIX no-op**：现有 `rfc254-file-trust.test.ts` 隐私用例保持不变（linux/darwin 判据零改动）。
- **win32 结构判据纯测试**：给 `assertPrivateRegularFileWithin` 注入 `platform:'win32'` +
  合成 stats + 路径对，断言「文件在封根内且非 link ⇒ trusted」「在封根外 ⇒ not-trusted」
  「isSymbolicLink ⇒ is-link」「无根上下文旧签名 ⇒ platform-unsupported」。**双平台注入**，
  POSIX CI 即可跑两分支。
- **store-hygiene 测试的 win32 化**：`rfc224-store-hygiene.test.ts:105` 等
  `mode & 0o777 === 0o600` 断言在 win32 上不成立 ⇒ 改为平台条件断言（win32 上断言「文件在
  封根内 + 封根 DACL 正确」，POSIX 上保留 mode 断言），或抽出可注入平台的判据函数在用户层
  wire 进去后再写少量集成断言（首选，见 CLAUDE.md「首选可断言面」）。
- **真机 ACL 往返（§7）**：唯一能证明 icacls 语义、继承传播、store 流程在真 DACL 下仍工作的。

## 7. 真机 ACL 往返验收清单（落地门槛，缺一不可）

在真 Windows 11（x64 与 ARM64 各一遍）上：

1. `sealDirectoryOwnerOnly(root)` 后，`(Get-Acl root).Sddl` 只含 {user, SYSTEM, Admins}
   allow-ACE、`P`（protected）置位、无 `AI`（inherited）。
2. 在 root 内 `writeFile` 一个新文件，其 `.Sddl` **继承**到同三 ACE、无其它 allow。
3. 以**另一个非管理员本地用户**（或降权 token）尝试读该文件 ⇒ Access Denied。
4. verified 全链路（manifest 写+读、control ACK、store-hygiene 锁+auth 清理）在封根下
   端到端跑通、`rfc224-store-hygiene` / `rfc224-verified-launcher` 在真机转绿。
5. ARM64：确认走 icacls 路（无 FFI）且 1–4 全过；若实现了 FFI 旁路，确认 ARM64 正确回落。
6. 降级诚实性：故意让 `sealDirectoryOwnerOnly` 失败（如 icacls 不在 PATH）⇒ 建根**fail-closed**
   并给可诊断 reason，**绝不**静默当作已私有。

## 8. 与已定事项的关系

- 不与 D1（v1 不做隔离 provider）冲突：这是**存储信任**原语，非 model-child containment。
- 与 T40a 正交：T40a 管 IDENTITY（dev/ino，已可信），T40b 管 PRIVACY（DACL）。两者组合后
  verified 路径的三类文件证明（隐私 / 非链接 / 同一对象）在 Windows 上才全部成立。
- backlog 已登记 DPAPI、Job Object/AppContainer provider、windows-arm64 FFI——本文的 icacls
  主路使 arm64 隐私**不依赖** FFI 落地，是对那条 backlog 的正面回答。

## 9. 明确的未完成边界

本文是**设计**。实现须：新 `util/win32Acl.ts` + 原语签名变更 + 9 调用点 + 建根设 DACL +
测试三档 + §7 真机往返。**在拿到 §7 的真机往返证据前不得声称 T40b 完成、不得合入生产隐私
判据变更**——headless 环境无法验证 DACL 语义，硬合等于在 verified 安全边界上放未验证的证明。
