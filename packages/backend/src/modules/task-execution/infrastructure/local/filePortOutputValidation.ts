import { toPortableRelativePath } from '@/util/platformExec'
import { checkLexicalThenRealpath } from '@/util/safePath'
import { readFileSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import type { ValidateIO } from '@agent-workflow/shared'
import type { PortOutputValidationContent } from '../../application/ports/portOutputValidation'

/**
 * Node-backed ValidateIO supplied to RFC-049 OutputKindHandler.validate.
 * Centralized here so the same fs / path semantics back every handler call;
 * the handlers themselves stay pure JS and can be exercised in tests with a
 * stub IO that doesn't touch disk.
 */
// RFC-284 T6：导出供四象限行为锁直测（rfc284-containment-quadrants.test.ts）——
// resolveWorktreePath 的分支语义（不存在回退词法 / RFC-193 绝对路径同位重写）
// 是安全关键面，迁移到共享骨架前后必须逐字节同判。
export const NODE_VALIDATE_IO: ValidateIO = {
  resolveWorktreePath(worktreeAbsPath, rawContent) {
    // RFC-284 T6：双查骨架收敛到 util/safePath.checkLexicalThenRealpath，
    // 本适配层只保留 envelope 的**判定策略**（与迁移前逐字节同判，由
    // rfc284-containment-quadrants.test.ts 锁定）：
    //   - RFC-103 T7：词法 containment 先行，词法内再 realpath 收紧（根内
    //     symlink 指根外不得读穿）；目标不存在 → 回退词法判定（存在性由
    //     handler 另报）。
    //   - RFC-193：词法根外的**绝对**输入，双 realpath 同位证明可翻转放行，
    //     并把 targetAbs/relativePath 重写为 real 形（macOS /var→/private/var
    //     前缀差异；纯同位证明，读穿保护不受影响）。
    const v = checkLexicalThenRealpath(worktreeAbsPath, rawContent)
    let targetAbs = v.targetAbs
    let insideWorktree = v.lexicalInside
    // Portable spelling: this value is persisted, interpolated into prompts and
    // read by downstream nodes, so it must not vary by host separator.
    let relativePath = toPortableRelativePath(relative(v.rootAbs, targetAbs))
    if (v.lexicalInside) {
      if (v.realpath.resolved) insideWorktree = v.realpath.realInside
      // unresolved（目标或根尚不存在）→ keep the lexical verdict.
    } else if (isAbsolute(rawContent) && v.realpath.resolved && v.realpath.realInside) {
      insideWorktree = true
      targetAbs = v.realpath.realTarget
      relativePath = toPortableRelativePath(relative(v.realpath.realRoot, v.realpath.realTarget))
    }
    return { targetAbs, relativePath, insideWorktree }
  },
  readFileUtf8(absPath) {
    return readFileSync(absPath, 'utf8')
  },
}

/** Construction performs no reads; only this native implementation interprets paths. */
export function createFilePortOutputValidationContent(): PortOutputValidationContent {
  return {
    resolve(workspaceRef, rawContent) {
      const resolved = NODE_VALIDATE_IO.resolveWorktreePath(workspaceRef, rawContent)
      return {
        targetRef: resolved.targetAbs,
        relativePath: resolved.relativePath,
        insideWorkspace: resolved.insideWorktree,
      }
    },
    readUtf8(targetRef) {
      return NODE_VALIDATE_IO.readFileUtf8(targetRef)
    },
  }
}
