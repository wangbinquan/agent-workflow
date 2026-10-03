import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { runGit } from '@/util/git'
import type {
  EmployeeCaseWorkspaceEffects,
  EmployeeCaseWorkspaceEffectsFactory,
} from '../../application/ports/employeeCaseWorkspaceEffects'

/** The original file and raw Git mechanisms; no Case policy or staging decisions. */
export function createFileEmployeeCaseWorkspaceEffectsFactory(): EmployeeCaseWorkspaceEffectsFactory {
  return {
    acquire(): EmployeeCaseWorkspaceEffects {
      return {
        resolve(reference, ...relativeSegments) {
          return join(reference, ...relativeSegments)
        },
        sibling(reference, suffix) {
          return `${reference}${suffix}`
        },
        exists(reference) {
          return existsSync(reference)
        },
        stat(reference) {
          const stat = lstatSync(reference, { throwIfNoEntry: false })
          return stat === undefined
            ? null
            : {
                kind: stat.isSymbolicLink()
                  ? 'symlink'
                  : stat.isDirectory()
                    ? 'directory'
                    : stat.isFile()
                      ? 'file'
                      : 'other',
                mode: stat.mode,
              }
        },
        list(reference) {
          return readdirSync(reference)
        },
        createDirectory(reference) {
          mkdirSync(reference, { recursive: true })
        },
        copyFile(source, target) {
          copyFileSync(source, target)
        },
        setMode(reference, mode) {
          chmodSync(reference, mode)
        },
        readBytes(reference) {
          return readFileSync(reference)
        },
        writeText(reference, text) {
          writeFileSync(reference, text)
        },
        remove(reference) {
          rmSync(reference, { recursive: true, force: true })
        },
        move(source, target) {
          renameSync(source, target)
        },
        runGit(cwdReference, operands) {
          return runGit(
            cwdReference,
            operands.map((operand) =>
              operand.kind === 'literal' ? operand.value : operand.reference,
            ),
          )
        },
        close() {},
      }
    },
  }
}
