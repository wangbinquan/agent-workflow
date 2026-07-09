# RFC-W001 — 技术设计

## 1. 核心抽象：`tests/helpers/stub-runtime.ts`

所有测试中创建 stub opencode / fake npm 的逻辑统一收口到一个 helper 模块。该模块根据 `process.platform` 自动选择脚本格式：

```ts
// tests/helpers/stub-runtime.ts
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const isWindows = process.platform === 'win32'

/**
 * Write a stub script that can be spawned on the current platform.
 * POSIX: writes .sh with shebang + chmod 0o755
 * Windows: writes .cmd wrapper + .js script (Node.js is always available via Bun)
 * Returns the path to the executable (platform-appropriate).
 */
export function writeStubScript(dir: string, name: string, scriptContent: string): string {
  if (isWindows) {
    return writeWindowsStub(dir, name, scriptContent)
  }
  return writePosixStub(dir, name, scriptContent)
}

/** Write a stub opencode binary (handles --version and run subcommand). */
export function writeStubOpencode(dir: string, opts: StubOpencodeOpts = {}): string {
  const { version = 'stub-opencode 1.14.99', runScript } = opts
  if (isWindows) {
    return writeWindowsStubOpencode(dir, version, runScript)
  }
  return writePosixStubOpencode(dir, version, runScript)
}

/** Write a fake npm shim. */
export function writeFakeNpm(dir: string): string {
  if (isWindows) {
    return writeWindowsFakeNpm(dir)
  }
  // POSIX: use existing fixtures/fake-npm.sh
  return join(dir, 'fake-npm.sh')  // caller still needs to copy or PATH-inject
}
```

### 1.1 Windows stub 策略

Windows 上用 Node.js 脚本（`.js`）+ `.cmd` 包装器替代 `.sh`：

**`.cmd` 包装器**（让 `spawn('stub-opencode')` 能找到并执行）：
```cmd
@echo off
node "%~dp0stub-opencode.js" %*
```

**`.js` 脚本**（等价 bash 逻辑）：
```js
// stub-opencode.js
const args = process.argv.slice(2)
if (args[0] === '--version' || args[0] === '-v') {
  console.log('stub-opencode 1.14.99')
  process.exit(0)
}
if (args[0] === 'run') {
  // ... emit JSON events
  process.exit(0)
}
console.error('unknown: ' + args.join(' '))
process.exit(99)
```

### 1.2 为什么用 Node.js 而非纯 .cmd

- `.cmd` 批处理无法生成 JSON stdout（特殊字符转义地狱）
- Node.js 是 Bun 自带的，零额外依赖
- `.js` 脚本可精确模拟 bash 逻辑（环境变量读取、JSON 输出、exit code）
- `.cmd` 包装器只做一件事：`node script.js %*`

## 2. 各失败类别的修复设计

### 2.1 C1: .sh stub → 跨平台 stub（最大类，~200+ fail）

**改动范围**：所有创建 `stub-opencode.sh` / `fake-npm.sh` 的测试文件

**方案**：
1. 新建 `tests/helpers/stub-runtime.ts`，提供 `writeStubOpencode()` / `writeFakeNpm()` / `writeStubScript()`
2. 每个测试文件改调 helper，删除内联 `writeFileSync(path, '#!/bin/sh ...')` + `chmodSync`
3. Helper 内部：POSIX 写 `.sh`（行为不变），Windows 写 `.cmd` + `.js`

**stub-opencode 行为等价表**：

| bash 行为 | Node.js 等价 |
|---|---|
| `echo 'stub-opencode 1.14.99'` | `console.log('stub-opencode 1.14.99')` |
| `printf '%s\n' '{"type":"text",...}'` | `process.stdout.write(JSON.stringify({...}) + '\n')` |
| `exit 0` | `process.exit(0)` |
| `$1` / `$2` | `process.argv[2]` / `process.argv[3]` |
| `$FAKE_NPM_MODE` | `process.env.FAKE_NPM_MODE` |
| `mkdir -p "$DIR"` | `mkdirSync(DIR, {recursive:true})` |
| `cat > "$FILE" <<EOF...EOF` | `writeFileSync(FILE, ...)` |
| `sleep 300` | `await new Promise(() => {})` 或 `setInterval(() => {}, 60000)` |
| `date +%s%3N` | `Date.now().toString()` |

### 2.2 C2: chmod mode 断言（~10 fail）

**方案**：权限断言改平台分流：
- POSIX：保留 `expect(mode & 0o777).toBe(0o600)` 
- Windows：断言 `secureFile` 被调用（mock）或检查 ACL（`icacls` dump），或直接跳过 mode 断言（因 `secureFile` 在 Windows 已用 icacls 闭合，mode 值无安全意义）

具体改动：
- `auth-token.test.ts`：`ensureTokenFile sets mode 0600` → POSIX 断言 mode，Windows 断言文件存在 + ACL
- `daemon-start.test.ts`：同上
- `cli.test.ts`：同上

### 2.3 C3: symlink 权限不足（~8 fail）

**方案**：
- 安全测试（symlink traversal 防护）：Windows 上用 junction 替代 symlink（junction 不需开发者模式）
- 若 junction 创建也失败（极端情况），`test.skip` 并标注原因
- `worktree-files-service.test.ts`：symlink 列表测试，Windows 上 junction 行为等价

### 2.4 C4: pgrep 不存在（~2 fail）

**方案**：`rfc135-runtimes-status.test.ts` 的 `pgrep -f` 改平台分流：
- POSIX：保留 `pgrep -f`
- Windows：`wmic process where "CommandLine like '%marker%'" get ProcessId /format:list`，检查输出非空

### 2.5 C5: Git 长路径（~6 fail）

**方案**：
- `cached-repos-http.test.ts`：缩短 tmpdir 前缀（`aw-` → 单字符），减少路径深度
- git clone 加 `-c core.longPaths=true`
- 测试中避免过深的目录嵌套

### 2.6 C6: 通用断言失败（~179 fail，根因同 C1）

修好 C1 后，stub-opencode 能正常 spawn，scheduler/runner 链路恢复，此类自动绿。

### 2.7 C7: 其他零散

- 逐个修复，无通用模式

## 3. 测试策略

- 每个 helper 函数有单测（POSIX/Windows 分支各覆盖）
- 修完后全量 `bun test` 在 Windows 上 0 fail
- POSIX 全量 `bun test` 不回归
- `bun run typecheck && bun run format:check` 绿

## 4. 失败模式

- **Windows .cmd 编码**：`.cmd` 文件必须用 CRLF + BOM？不需要——Node.js `.js` 文件 UTF-8 即可，`.cmd` 包装器纯 ASCII
- **stdout CRLF**：`.cmd` → `node .js` 的 stdout 可能带 CRLF？不会——Node.js `console.log` 输出 LF（Windows 上也是）
- **环境变量透传**：`.cmd %*` 传参时特殊字符？测试参数都是简单字符串（`--version`、`run`、`--agent`），无特殊字符风险
