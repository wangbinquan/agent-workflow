// RFC-254 T32 — repo-relative path used as an IDENTIFIER, not as a filesystem
// path.
//
// Several guards in this suite build a key with `path.relative(SRC, abs)` and
// compare it against a literal like `'components/LoadingState.tsx'`. On Windows
// `path.relative` yields `components\LoadingState.tsx`, so every entry misses
// its allowlist at once and the guard reports the whole inventory as both
// missing and unexpected — the same shape that once made `test-suite-policy`
// unreadable on that platform.
//
// The canonical statement of this rule is `toPortableRelativePath()` in
// `packages/backend/src/util/platformExec.ts`; frontend tests cannot import
// backend source (the dependency-rule gate forbids that seam), so this is a
// deliberate twin rather than a fork of convenience. Keep the two in step.
//
// ONLY WINDOWS IS REWRITTEN. `\` is a separator only there; on POSIX it is a
// legal character inside a filename, so rewriting unconditionally would not
// normalize a path, it would name a different one.
export function toPortableRelativePath(
  relativePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return relativePath
  return relativePath.replaceAll('\\', '/')
}
