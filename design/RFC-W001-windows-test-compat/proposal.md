# RFC-W001 — Windows 测试兼容性修复

状态：In Progress（用户授权直接实现，无需批准）

## 1. 背景

RFC-windows（PR-1~5）已落地，daemon + opencode 原生 Windows 可运行。但 `bun test` 在 Windows 上 392 fail / 4345 pass，大量测试因 POSIX-only 假设而失败。CI `check-windows` job 只跑平台层子集，全量测试未在 Windows 上跑过。

## 2. 失败分类（392 fail 根因分析）

### C1: `.sh` 脚本无法 spawn（~200+ fail，最大类）

测试用 `writeFileSync(path, '#!/bin/sh ...')` + `chmodSync(path, 0o755)` 创建 stub opencode / fake npm，然后 `Bun.spawn(path, ...)` 执行。Windows 上：
- `spawn('xxx.sh')` 找不到解释器（ENOENT），Windows 不认 shebang
- `chmodSync` 是 no-op，不报错但也不生效
- 涉及文件：几乎所有 scheduler / runner / review / clarify / plugin / runtime 测试

**修复方案**：创建 `tests/helpers/stub-runtime.ts` 工具函数，Windows 下写 `.cmd` 批处理 + Node.js `.js` 脚本替代 `.sh`，POSIX 保留 `.sh`。所有测试改调工具函数。

### C2: `chmod 0o600` / `0o755` 断言失败（~10 fail）

- `auth-token.test.ts` 断言 `mode & 0o777 === 0o600`：Windows 文件 mode 无 unix 权限位，实际返回 0o666
- `daemon-start.test.ts` 同款
- `cli.test.ts` 同款

**修复方案**：权限断言改用 `util/fs-perms.ts` 的 `secureFile`/`secureDir`（PR-2 已落地），测试断言改为：POSIX 检查 mode，Windows 检查 ACL（`icacls` dump）或跳过 mode 断言（因 `secureFile` 已在 Windows 用 icacls 闭合，mode 断言在 Windows 无意义）。

### C3: `symlinkSync` 权限不足（~8 fail）

- `rfc103-envelope-symlink-containment.test.ts`、`rfc107-url-upload-multipart.test.ts`、`worktree-files-service.test.ts` 等创建 symlink 测试安全边界
- Windows 创建 symlink 需开发者模式或管理员权限，普通用户 EPERM

**修复方案**：安全测试中 symlink 创建改用 junction（目录）或 `fs.copyFileSync`（文件）模拟。对「symlink 指向 worktree 外」的安全测试，Windows 上用 junction 验证等价语义；若 junction 也不可用则 `test.skip` 并标注「需开发者模式」。

### C4: `pgrep` 不存在（~2 fail）

- `rfc135-runtimes-status.test.ts` 用 `pgrep -f` 检查子进程是否被 reap

**修复方案**：Windows 分支改用 `tasklist /FI "IMAGENAME eq ..."` 或 `wmic process where "CommandLine like '%marker%'" get ProcessId`。

### C5: Git 长路径 / `file://` URL 问题（~6 fail）

- `cached-repos-http.test.ts`：`git clone file://C:\...` 路径过长（MAX_PATH 260），`Filename too long`
- 路径含 Windows 盘符冒号被 GNU tar 误解为 `host:path`

**修复方案**：
- 测试用更短的 tmpdir 前缀（`aw-` → 单字母）
- `git clone` 加 `-c core.longPaths=true`
- `file://` URL 已在 PR-2 用 `pathToFileURL` 修过，但测试中 git clone 的本地路径仍可能过长

### C6: `expect(received).toBe(expected)` 通用断言失败（~179 fail）

大量 scheduler/runner 集成测试因 stub-opencode 无法 spawn 导致整条链路失败，根因同 C1。修好 C1 后此类应大幅减少。

### C7: 其他零散问题

- `EPERM: operation not permitted, symlink` — 同 C3
- `toBeInstanceOf` 预期类型不匹配 — 可能是 Bun Windows 行为差异
- migration 测试失败 — 可能与 DB 路径或文件锁有关

## 3. 目标 / 非目标

### 目标
- `bun test` 在 Windows 上 0 fail（与 POSIX 等价绿）
- 修复方案不改变 POSIX 测试行为（POSIX byte-for-byte 绿）
- 平台差异收口到 helper 函数，测试文件不散落 `if (process.platform === 'win32')`

### 非目标
- 不改生产代码（RFC-windows PR-1~5 已修完生产层）
- 不改 e2e 测试（Playwright e2e 另行处理）
- 不降级测试覆盖（Windows skip 的 case 必须有等价替代或明确标注原因）

## 4. 验收标准

1. `bun test` 在 Windows 上 0 fail / 0 error
2. `bun test` 在 POSIX 上行为不变（全绿）
3. `bun run typecheck && bun run test && bun run format:check` 三项全绿
4. CI `check-windows` job 跑全量 `bun test`（不再只跑子集）
