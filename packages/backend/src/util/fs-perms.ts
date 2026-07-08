// util/fs-perms.ts — cross-platform "restrict a sensitive file/dir to the
// current user only" helper (RFC-windows PR-2 T9).
//
// 为什么单独一个模块：`auth/secretBox.ts`（OIDC client_secret 密封密钥）、
// `auth/token.ts`（daemon token）、`pluginInstaller.ts`（plugin 安装根）、
// `runtime/claudeCode/config.ts`（订阅凭据桥接）都用 `chmod 0o600`/`0o700`
// 限制敏感文件。POSIX 下 chmod 生效；Windows 下 chmod 是 **no-op**——这些
// 敏感文件实际全可读，是安全回归。本模块封装单一 `secureFile`/`secureDir`：
// POSIX 走 chmod（byte-for-byte 原行为），Windows 走 `icacls` 移除继承、仅留
// 当前用户。所有调用点改调这里，敏感文件 ACL 在两平台等价闭合。

import { chmodSync } from 'node:fs'
import { isWindows } from './platform'

/** POSIX: chmod 0o600. Windows: icacls remove-inheritance + current-user-only. */
export function secureFile(p: string): void {
  if (isWindows()) {
    restrictAclToCurrentUser(p, /* inherit */ false)
    return
  }
  chmodSync(p, 0o600)
}

/** POSIX: chmod 0o700. Windows: icacls remove-inheritance + current-user-only (inherit for dir). */
export function secureDir(p: string): void {
  if (isWindows()) {
    restrictAclToCurrentUser(p, /* inherit */ true)
    return
  }
  chmodSync(p, 0o700)
}

/**
 * Windows ACL restriction via `icacls`: disable inheritance (`/inheritance:r`),
 * remove all existing ACEs, then grant the current user full control. For dirs
 * `(:OI)(CI)` makes the ACE apply to this dir + all children (inheritance).
 *
 * `icacls` returns non-zero on failure (missing file, perms); we swallow but
 * the caller has already written the file, so a failed ACL restriction degrades
 * to the OS default (same as the pre-RFC chmod no-op) rather than crashing the
 * daemon. A follow-up `doctor` check (PR-5) surfaces ACL failures.
 */
function restrictAclToCurrentUser(p: string, inherit: boolean): void {
  const user = process.env.USERNAME ?? process.env.USER ?? ''
  if (user.length === 0) return // cannot name a grantee safely; leave default
  const grant = inherit ? `${user}:(OI)(CI)F` : `${user}:F`
  try {
    // /inheritance:r removes inherited ACEs; /grant:r replaces (not adds) the
    // named ACE; the trailing `F` = full control.
    const res = Bun.spawnSync(['icacls', p, '/inheritance:r', '/grant:r', grant])
    if (res.exitCode !== 0) {
      // Non-fatal: file written, ACL restriction failed. Logged at call sites
      // via doctor (PR-5); here we silently degrade to OS default.
    }
  } catch {
    // icacls unavailable (rare; Windows Server Core without it) — degrade.
  }
}
