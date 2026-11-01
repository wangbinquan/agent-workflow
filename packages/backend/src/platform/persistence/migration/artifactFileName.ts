/** NTFS reserves these in file names; a colon even addresses an alternate data stream. */
const WINDOWS_RESERVED = /[<>:"|?*]/g

/**
 * RFC-398: logical epoch-switch artifact names carry digests (`plans/sha256:<hex>.json`,
 * `acknowledgements/sha256:<hex>.json`). On Windows the colon named an alternate data stream of a
 * file called `sha256`: the write-once temporary opened as that stream and the publishing `link`
 * failed with EINVAL, so every Windows epoch switch stopped at its first plan (release-upgrade
 * nightly 41303628365). Windows file names map each reserved character to `-`; the mapping is
 * idempotent. Logical names, digests and POSIX file names are unchanged, so operation directories
 * written by earlier releases keep resolving.
 *
 * A leaf on purpose: runtime recovery (`fileJournal.ts`) and the offline runner (`run/paths.ts`)
 * share it without the runtime reaching migration runner code (rfc395-v3-dormancy).
 */
export function epochArtifactFileName(platform: NodeJS.Platform, reference: string): string {
  return platform === 'win32' ? reference.replace(WINDOWS_RESERVED, '-') : reference
}
