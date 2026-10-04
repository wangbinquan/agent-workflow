// RFC-370 A4 — the existing native fixture endpoint and Git mechanisms.
import { describeRepositoryRemote } from '@agent-workflow/shared'
import { isAbsolute } from 'node:path'
import { runGit as defaultRunGit } from '@/util/git'
import type { RepositoryGit } from '../../application/repositoryCommit'
import type { RepositoryPublicationSession } from '../../public/types'

export function createFileRepositoryPublicationFixtureSession(
  remoteUrl: string,
  runGit: RepositoryGit = defaultRunGit,
): RepositoryPublicationSession | null {
  const described = describeRepositoryRemote(remoteUrl)
  const local =
    (described.ok && described.value.transport === 'file') ||
    isAbsolute(remoteUrl) ||
    remoteUrl.startsWith('./') ||
    remoteUrl.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(remoteUrl)
  if (!local) return null
  return {
    endpointUrl: remoteUrl,
    receipt: {
      credentialSource: 'legacy',
      credentialRevision: null,
      endpointSource: 'local-fixture',
      endpointBindingDigest: null,
    },
    runNetwork(repoPath, args, options) {
      return runGit(repoPath, [...args], options)
    },
    close() {},
  }
}
