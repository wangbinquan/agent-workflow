import { constants, copyFileSync, linkSync } from 'node:fs'

/**
 * RFC-626 §4.5: give a write-once file a second name without copying its bytes.
 *
 * Elsewhere that is a hard link. On macOS it must not be one: the system SQLite, which Bun
 * uses there, fails every connection that is open on a database file once the file's link
 * count changes (`SQLITE_IOERR_VNODE`, reported as "disk I/O error"), and the files shared
 * here are databases this very process is reading — the work copy while it is registered as
 * an artifact, the frozen copy while it becomes the backup. So macOS clones instead: on APFS
 * as cheap as a link and without extra space, but a new inode that leaves the source alone.
 *
 * `linked`: the two names are one file. `cloned`: a copy-on-write clone, identical by
 * construction. `copied`: an ordinary copy, which the caller has to prove by its bytes.
 */
export type SharedFile = 'linked' | 'cloned' | 'copied'
export function shareFile(
  source: string,
  destination: string,
  options: {
    readonly platform?: NodeJS.Platform
    /** Replaceable so tests can stand in for a filesystem that refuses hard links. */
    readonly link?: (existingPath: string, newPath: string) => void
    /** Replaceable so tests can stand in for a filesystem that cannot clone. */
    readonly clone?: (existingPath: string, newPath: string) => void
  } = {},
): SharedFile {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') {
    try {
      ;(options.clone ?? ((from, to) => copyFileSync(from, to, constants.COPYFILE_FICLONE_FORCE)))(
        source,
        destination,
      )
      return 'cloned'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error
      // Not a copy-on-write filesystem: an ordinary copy below.
    }
  } else {
    try {
      ;(options.link ?? linkSync)(source, destination)
      return 'linked'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error
      // Another filesystem, or one without hard links: an ordinary copy below.
    }
  }
  copyFileSync(source, destination, constants.COPYFILE_EXCL)
  return 'copied'
}
