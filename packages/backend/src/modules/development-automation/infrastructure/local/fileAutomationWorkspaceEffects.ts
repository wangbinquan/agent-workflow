import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { AutomationWorkspaceEffectsFactory } from '../../application/ports/automationWorkspaceEffects'

export function createFileAutomationWorkspaceEffectsFactory(): AutomationWorkspaceEffectsFactory {
  return {
    resolve(reference, ...segments) {
      return join(reference, ...segments)
    },
    parent(reference) {
      return dirname(reference)
    },
    acquire() {
      return {
        exists(reference) {
          return existsSync(reference)
        },
        inspect(reference, followLinks) {
          const facts = followLinks
            ? statSync(reference, { throwIfNoEntry: false })
            : lstatSync(reference, { throwIfNoEntry: false })
          if (facts === undefined) return undefined
          return {
            kind: facts.isSymbolicLink()
              ? 'symlink'
              : facts.isDirectory()
                ? 'directory'
                : facts.isFile()
                  ? 'file'
                  : 'other',
            mode: facts.mode,
            size: facts.size,
            nlink: facts.nlink,
          }
        },
        listNames(reference) {
          return readdirSync(reference)
        },
        listEntries(reference) {
          return readdirSync(reference, { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            kind: entry.isSymbolicLink()
              ? 'symlink'
              : entry.isDirectory()
                ? 'directory'
                : entry.isFile()
                  ? 'file'
                  : 'other',
          }))
        },
        readBytes(reference) {
          return readFileSync(reference)
        },
        readText(reference) {
          return readFileSync(reference, 'utf8')
        },
        readLink(reference) {
          return readlinkSync(reference)
        },
        createDirectory(reference, recursive) {
          if (recursive) mkdirSync(reference, { recursive: true })
          else mkdirSync(reference)
        },
        copyFile(source, target, exclusive) {
          if (exclusive) copyFileSync(source, target, constants.COPYFILE_EXCL)
          else copyFileSync(source, target)
        },
        setMode(reference, mode) {
          chmodSync(reference, mode)
        },
        writeText(reference, text) {
          writeFileSync(reference, text)
        },
        close() {},
      }
    },
  }
}
