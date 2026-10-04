// RFC-370 A4 — the existing temporary clone and file mechanisms.
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Stats,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { runGit as defaultRunGit } from '@/util/git'
import { sha256Hex } from '@/util/hash'
import type {
  RepositoryCandidateEffectsFactory,
  RepositoryCandidateFileFacts,
} from '../../application/ports/repositoryCandidateEffects'
import type { RepositoryGit } from '../../application/repositoryCommit'

function fileFacts(stat: Stats): RepositoryCandidateFileFacts {
  return {
    kind: stat.isSymbolicLink()
      ? 'symlink'
      : stat.isDirectory()
        ? 'directory'
        : stat.isFile()
          ? 'file'
          : 'other',
    mode: stat.mode,
  }
}

export function createFileRepositoryCandidateEffectsFactory(
  input: { readonly runGit?: RepositoryGit } = {},
): RepositoryCandidateEffectsFactory {
  const runGit = input.runGit ?? defaultRunGit
  return {
    acquire({ baselineReference, overlayReference }) {
      return {
        runBaseline(args, options) {
          return runGit(baselineReference, [...args], options)
        },
        createWorkspace() {
          if (overlayReference === undefined) {
            throw new Error('candidate-overlay-reference-required')
          }
          const parent = mkdtempSync(join(tmpdir(), 'aw-candidate-'))
          const ws = join(parent, 'ws')
          return {
            reference: ws,
            cloneBaseline() {
              return runGit(parent, ['clone', '--no-hardlinks', '--quiet', baselineReference, ws])
            },
            run(args, options) {
              return runGit(ws, [...args], options)
            },
            listCandidateRoot() {
              return readdirSync(ws)
            },
            removeCandidateEntry(relativePath) {
              rmSync(join(ws, relativePath), { recursive: true, force: true })
            },
            statOverlay(relativePath) {
              return fileFacts(
                lstatSync(
                  relativePath === '' ? overlayReference : join(overlayReference, relativePath),
                ),
              )
            },
            listOverlay(relativeDirectory) {
              return readdirSync(
                relativeDirectory === ''
                  ? overlayReference
                  : join(overlayReference, relativeDirectory),
              )
            },
            copyOverlayFile(relativePath) {
              const dest = join(ws, relativePath)
              mkdirSync(dirname(dest), { recursive: true })
              copyFileSync(join(overlayReference, relativePath), dest)
            },
            statCandidate(relativePath) {
              const stat = lstatSync(join(ws, relativePath), { throwIfNoEntry: false })
              return stat ? fileFacts(stat) : null
            },
            setCandidateMode(relativePath, mode) {
              chmodSync(join(ws, relativePath), mode)
            },
            readCandidateDigest(relativePath) {
              const abs = join(ws, relativePath)
              const stat = lstatSync(abs, { throwIfNoEntry: false })
              return !stat || !stat.isFile() ? null : sha256Hex(readFileSync(abs))
            },
            importCommitToBaseline({ commitSha, localRef }) {
              return runGit(baselineReference, [
                'fetch',
                '--quiet',
                ws,
                `+${commitSha}:${localRef}`,
              ])
            },
            close() {
              rmSync(parent, { recursive: true, force: true })
            },
          }
        },
        close() {},
      }
    },
  }
}
