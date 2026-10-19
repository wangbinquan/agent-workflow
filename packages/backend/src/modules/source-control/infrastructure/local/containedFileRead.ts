// RFC-239 §3.5 P0-3 — handle-first contained worktree read (moved here from
// `services/worktreeFileContent.ts` by RFC-370 §10 V16, unchanged, so the
// local revision content and the file-content route share one primitive).
//
// The worktree side must not check-then-reopen (the resident
// `readWorktreeFile` pattern): a live agent can swap a symlink between the
// containment check and the read. We open FIRST (O_NOFOLLOW on the
// already-realpath'd target), then verify regular-file/size/NUL on the file
// handle and read from that same handle.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { assertSameFileIdentityForHost } from '@/util/fileTrust'

const NUL_PROBE_BYTES = 8192

/** Test seam: invoked between containment resolution and open(2) so a test can
 *  swap the resolved path for a symlink and prove the open still refuses. */
export interface ContainedFileHooks {
  beforeOpen?(): void
}

export type ContainedRead =
  | { kind: 'ok'; content: string; size: number }
  | { kind: 'not-found' }
  | { kind: 'outside' }
  | { kind: 'oversized'; size: number }
  | { kind: 'binary' }

function hasNul(buf: Buffer): boolean {
  const probe = buf.subarray(0, NUL_PROBE_BYTES)
  return probe.includes(0)
}

/**
 * Handle-first contained read. The containment decision is made on the
 * realpath'd target; the open then uses O_NOFOLLOW so a symlink swapped in
 * AFTER that decision (the classic TOCTOU) is refused by the kernel instead of
 * silently followed. All subsequent checks (regular file, size, NUL) run on
 * the SAME file description we read from. A directory-segment swap deeper in
 * the path is not closed by O_NOFOLLOW (needs openat2/RESOLVE_BENEATH,
 * unavailable on macOS) — tracked in docs/audit-backlog.md.
 */
export function openContainedFileWithin(
  root: string,
  relPath: string,
  maxBytes: number,
  hooks?: ContainedFileHooks,
): ContainedRead {
  // RFC-287 G7：**空根一律判否**，且判在最前面。
  //
  // `resolve('')` 返回的是 **daemon 进程的 cwd**，于是下面那道 realpath 包含性检查
  // 会以 daemon 的工作目录为根——任何 `tasks:read` 就能把 daemon 自己的源码读出来
  // （实测：准备窗口内的任务 `GET /file-content?path=package.json` 返回 daemon 的
  // packages/backend/package.json 全文）。
  //
  // G7 之前空 `worktreePath` 只在物化失败（罕见终态、无人会去读它的文件）时出现；
  // 现在**每一次** JSON-body 启动在准备窗口内都是这个状态，时长等于整个克隆。
  //
  // 这是同一个 bug 的**第二套实现**：`util/safePath.checkLexicalThenRealpath` 那道
  // 守卫喂的是 portArtifacts 一族，而本函数自己写了一份 realpath 包含性，从不经过
  // 它——所以必须在这里独立堵一次。AC-10 点名的四扇读洞里，本函数覆盖两扇
  // （worktreeFileContent 与 codeIntel.fileSymbols 都走它）。
  if (root === '') return { kind: 'not-found' }
  if (relPath === '' || isAbsolute(relPath)) return { kind: 'outside' }
  // Split on the platform's ACTUAL separators: win32 accepts `\` too, so a `..`
  // spelled with a backslash must be caught there — but `\` is a legal filename
  // character on POSIX, so splitting on it there would false-reject a real file.
  // (The realpath containment below is the true gate; this is a fast,
  // platform-honest pre-screen.)
  const sepSplit = process.platform === 'win32' ? /[/\\]/ : /\//
  if (relPath.split(sepSplit).some((seg) => seg === '..')) return { kind: 'outside' }

  let rootReal: string
  try {
    rootReal = realpathSync(resolve(root))
  } catch {
    return { kind: 'not-found' } // worktree itself is gone
  }
  let resolved: string
  try {
    resolved = realpathSync(join(rootReal, relPath))
  } catch {
    return { kind: 'not-found' }
  }
  if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
    return { kind: 'outside' }
  }

  // RFC-254 T31 (task#12): O_NOFOLLOW below is a NO-OP on win32
  // (`constants.O_NOFOLLOW` is undefined there, and `flags | undefined === flags`),
  // so the realpath→open symlink-swap window has no kernel guard on Windows.
  // Bracket the open with a handle-identity recheck instead: lstat the resolved
  // target now — it must be a non-symlink regular file — and after opening,
  // require the fstat'd handle to carry the SAME dev/ino (win32-authoritative
  // since T40a, fail-closed on index-less filesystems). A symlink swapped into
  // `resolved` after the realpath is refused here even where O_NOFOLLOW cannot;
  // on POSIX this is belt-and-suspenders behind the ELOOP path.
  let before: Stats
  try {
    before = lstatSync(resolved)
  } catch {
    return { kind: 'not-found' }
  }
  if (before.isSymbolicLink()) return { kind: 'outside' }
  if (!before.isFile()) return { kind: 'not-found' }

  hooks?.beforeOpen?.()

  let fd: number
  try {
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err) {
    // ELOOP = the final component became a symlink after resolution — the
    // exact race we refuse. Anything else (vanished file) is a plain miss.
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ELOOP' || code === 'EMLINK' ? { kind: 'outside' } : { kind: 'not-found' }
  }
  try {
    const st = fstatSync(fd)
    // The file we OPENED must be byte-identical in identity to the one we lstat'd
    // and containment-checked. A dev/ino change means a swap slipped into the
    // realpath→open window (the win32 gap O_NOFOLLOW cannot close); refuse it.
    if (!assertSameFileIdentityForHost(before, st).trusted) return { kind: 'outside' }
    if (!st.isFile()) return { kind: 'not-found' }
    if (st.size > maxBytes) return { kind: 'oversized', size: st.size }
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off)
      if (n <= 0) break
      off += n
    }
    const data = buf.subarray(0, off)
    if (hasNul(data)) return { kind: 'binary' }
    return {
      kind: 'ok',
      content: new TextDecoder('utf-8', { fatal: false }).decode(data),
      size: st.size,
    }
  } finally {
    closeSync(fd)
  }
}
