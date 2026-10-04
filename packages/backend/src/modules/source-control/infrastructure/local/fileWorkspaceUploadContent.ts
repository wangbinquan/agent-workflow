import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, normalize, resolve } from 'node:path'
import { ValidationError } from '@/util/errors'
import {
  assertInsideWorktree,
  assertTargetDirInsideWorktree,
  lstatOrNull,
} from '@/platform/content/local/uploadPaths'
import type {
  SynchronousWorkspaceUploadContent,
  WorkspaceUploadBinding,
  WorkspaceUploadContentFactory,
} from '../../application/ports/workspaceUploadContent'

function createFileWorkspaceUploadContent(
  binding: WorkspaceUploadBinding,
): SynchronousWorkspaceUploadContent {
  const worktreePath = binding.workspaceRef
  return Object.freeze<SynchronousWorkspaceUploadContent>({
    prepareTarget(relativeDirectory: string) {
      const targetAbs = assertInsideWorktree(worktreePath, relativeDirectory)
      assertTargetDirInsideWorktree(worktreePath, targetAbs)
      mkdirSync(targetAbs, { recursive: true })
      return {
        directoryRef: targetAbs,
        packedDirectory: normalize(relativeDirectory).replace(/\\/g, '/'),
      }
    },
    file(directoryRef: string, filename: string) {
      const absPath = resolve(directoryRef, filename)
      if (dirname(absPath) !== directoryRef) {
        throw new ValidationError(
          'upload-path-escape',
          `resolved upload path escapes target directory: ${absPath}`,
        )
      }
      return absPath
    },
    entry(fileRef: string) {
      const st = lstatOrNull(fileRef)
      return st === null
        ? 'missing'
        : st.isFile()
          ? 'file'
          : st.isDirectory()
            ? 'directory'
            : 'other'
    },
    read: (fileRef: string) => readFileSync(fileRef),
    remove: (fileRef: string) => unlinkSync(fileRef),
    write: (fileRef: string, bytes: Uint8Array) => writeFileSync(fileRef, bytes, { flag: 'wx' }),
  })
}

export function createFileWorkspaceUploadContentFactory(): WorkspaceUploadContentFactory {
  return Object.freeze({ bind: createFileWorkspaceUploadContent })
}
