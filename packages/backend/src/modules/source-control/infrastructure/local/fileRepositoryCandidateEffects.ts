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
  RepositoryCandidateStepEffectsFactory,
  RepositoryCandidateFileFacts,
  RepositoryCandidateWorkspace,
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

/** One native candidate workspace over a temporary clone directory. */
function openFileRepositoryCandidateWorkspace(input: {
  readonly baselineReference: string
  readonly overlayReference: string
  readonly workspaceReference: string
  readonly runGit?: RepositoryGit
}): RepositoryCandidateWorkspace {
  const { baselineReference, overlayReference } = input
  const ws = input.workspaceReference
  const parent = dirname(ws)
  const runGit = input.runGit ?? defaultRunGit
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
        lstatSync(relativePath === '' ? overlayReference : join(overlayReference, relativePath)),
      )
    },
    listOverlay(relativeDirectory) {
      return readdirSync(
        relativeDirectory === '' ? overlayReference : join(overlayReference, relativeDirectory),
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
      return runGit(baselineReference, ['fetch', '--quiet', ws, `+${commitSha}:${localRef}`])
    },
    close() {
      rmSync(parent, { recursive: true, force: true })
    },
  }
}

export function createFileRepositoryCandidateEffectsFactory(
  input: {
    readonly runGit?: RepositoryGit
    /** Where temporary candidate clones live; the OS temp directory when
     * absent. A hosted task image keeps them inside its persistent volume so
     * a staged tree survives between commands and container restarts. */
    readonly temporaryRoot?: string
  } = {},
): RepositoryCandidateStepEffectsFactory {
  const runGit = input.runGit ?? defaultRunGit
  const temporaryRoot = () => {
    if (input.temporaryRoot === undefined) return tmpdir()
    mkdirSync(input.temporaryRoot, { recursive: true })
    return input.temporaryRoot
  }
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
          const parent = mkdtempSync(
            join(
              temporaryRoot(),
              input.temporaryRoot === undefined ? 'aw-candidate-' : 'candidate-',
            ),
          )
          const ws = join(parent, 'ws')
          return openFileRepositoryCandidateWorkspace({
            baselineReference,
            overlayReference,
            workspaceReference: ws,
            runGit,
          })
        },
        close() {},
      }
    },
  }
}
