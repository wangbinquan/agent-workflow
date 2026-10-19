// RFC-370 M0 — publish the committed agent-workflow sources to a CrewStation project.
//
//   CS_TOKEN=<platform session> CS_GITLAB_TOKEN=<repository token> [CS_API_URL=<platform api>] \
//     bun run scripts/crewstation-publish.ts --profile <profile.json> [--version patch|minor|major|vX.Y.Z] [--no-release] [--adopt-existing] [--source <sha>]
//
// The first publication to a new project replaces the template it was created
// from only with `--adopt-existing`; later publications are deltas against the
// previously published source commit named in the branch head.
//
// 1. Read committed blobs from the primary checkout (never the working tree):
//    HEAD, or with `--source` an earlier commit of main whose CI passed;
// 2. add `deploy/crewstation/Dockerfile` and the rendered `crewstation.yaml` at
//    the root, as the platform builds the repository root;
// 3. publish a checked delta through GitLab's Commits API, without another checkout;
// 4. release exactly that commit through the platform release API
//    (`POST /v1/services/:serviceId/releases` with `expectedCommitSha`): the
//    platform tags, builds, runs `agent-workflow migrate` and deploys the
//    standby slot. `crewstation publish` is the development-session entry (it
//    pushes the session workspace) and does not apply to a pushed snapshot.
//    Traffic is switched by the project owner (`crewstation traffic switch`).
//
// The session value (`CS_TOKEN`, the same one the `crewstation` CLI reads) is
// sent as the platform session cookie and never printed.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseDeploymentProfile, renderCrewStationManifest } from './lib/crewstation-manifest'
import {
  chunkPublicationActions,
  createGitLabPublication,
  partialPublicationMessage,
  planSourcePublication,
  previousPublication,
  publicationSource,
  sourceFile,
  type SourceFile,
} from './lib/crewstation-source-publication'

const repoRoot = resolve(import.meta.dirname, '..')

function flag(name: string): string | undefined {
  const index = Bun.argv.indexOf(name)
  return index >= 0 ? Bun.argv[index + 1] : undefined
}

function run(cmd: string[], cwd: string, input?: Uint8Array): string {
  const proc = Bun.spawnSync(cmd, { cwd, stdin: input ?? 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed (${proc.exitCode}):\n${proc.stderr.toString()}`)
  }
  return proc.stdout.toString()
}

/** The `crewstation` CLI's default platform address and session cookie. */
const DEFAULT_API_URL = 'http://console.cs.localhost'
const SESSION_COOKIE = 'cs_session'

async function platform<T>(
  input: { readonly apiUrl: string; readonly token: string },
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(new URL(path, input.apiUrl), {
    method,
    headers: {
      accept: 'application/json',
      cookie: `${SESSION_COOKIE}=${input.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok)
    throw new Error(`${method} ${path} failed: HTTP ${response.status} ${text.slice(0, 500)}`)
  return JSON.parse(text) as T
}

async function releaseCommit(input: {
  readonly apiUrl: string
  readonly token: string
  readonly project: string
  readonly branch: string
  readonly commitSha: string
  readonly version: string
  readonly message: string
}): Promise<{ id: string; tag: string; status: string }> {
  if (input.token.length === 0) {
    throw new Error(
      'CS_TOKEN (the platform session the crewstation CLI uses) is required to release',
    )
  }
  const projects = await platform<{ items: { slug: string; serviceId?: string; state: string }[] }>(
    input,
    'GET',
    '/v1/projects',
  )
  const project = projects.items.find((candidate) => candidate.slug === input.project)
  if (project?.serviceId === undefined) {
    throw new Error(`project ${input.project} is not visible or has no service yet`)
  }
  return await platform(input, 'POST', `/v1/services/${project.serviceId}/releases`, {
    branch: input.branch,
    expectedCommitSha: input.commitSha,
    version: input.version,
    message: input.message,
  })
}

const profilePath = flag('--profile')
if (profilePath === undefined) {
  console.error(
    'usage: bun run scripts/crewstation-publish.ts --profile <profile.json> [--version patch|minor|major|vX.Y.Z] [--no-release] [--adopt-existing] [--source <sha>]',
  )
  process.exit(2)
}
const profile = parseDeploymentProfile(JSON.parse(readFileSync(profilePath, 'utf8')))
const head = publicationSource({
  requested: flag('--source'),
  head: run(['git', 'rev-parse', 'HEAD'], repoRoot).trim(),
  onMain: (sha) =>
    Bun.spawnSync(['git', 'merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: repoRoot })
      .exitCode === 0,
})
if (run(['git', 'branch', '--show-current'], repoRoot).trim() !== 'main')
  throw new Error('publication-requires-primary-main')
const gitlabToken = process.env.CS_GITLAB_TOKEN
if (!gitlabToken) throw new Error('CS_GITLAB_TOKEN is required for source publication')
const repository = new URL(profile.repository)
const publisher = createGitLabPublication({
  apiUrl: process.env.CS_GITLAB_URL ?? repository.origin,
  project: repository.pathname.replace(/^\//, '').replace(/\.git$/, ''),
  token: gitlabToken,
})
const remoteHead = await publisher.head(profile.branch)
const remoteTree = await publisher.tree(remoteHead.id)
function committedFiles(sha: string): Map<string, SourceFile> {
  const files = new Map<string, SourceFile>()
  for (const entry of run(['git', 'ls-tree', '-r', '-z', sha], repoRoot)
    .split('\0')
    .filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry)
    if (match === null) throw new Error('publication-unsupported-git-entry')
    const [, mode, blob, path] = match as [string, '100644' | '100755', string, string]
    files.set(path, {
      mode,
      blob,
      bytes() {
        const process = Bun.spawnSync(['git', 'cat-file', 'blob', blob], {
          cwd: repoRoot,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        if (process.exitCode !== 0) throw new Error('publication-source-blob-unavailable')
        return process.stdout
      },
    })
  }
  const dockerfile = files.get('deploy/crewstation/Dockerfile')
  if (dockerfile === undefined) throw new Error('publication-dockerfile-missing')
  files.set('Dockerfile', dockerfile)
  return files
}
const baseline = previousPublication({
  headMessage: remoteHead.message,
  adopt: Bun.argv.includes('--adopt-existing'),
  committedFiles,
  remoteTree,
})
const previous = baseline.files
const next = committedFiles(head)
const manifestSource = next.get('deploy/crewstation/crewstation.template.yaml')
if (manifestSource === undefined) throw new Error('publication-manifest-template-missing')
const manifest = renderCrewStationManifest(
  new TextDecoder().decode(manifestSource.bytes()),
  profile,
)
// The deployed manifest is operator-owned configuration. Its exact remote
// revision is captured here and protected with last_commit_id in the batch.
const oldManifest = await publisher.file('crewstation.yaml', remoteHead.id)
if (oldManifest !== null)
  previous.set('crewstation.yaml', sourceFile(Buffer.from(oldManifest.content, 'base64')))
next.set('crewstation.yaml', sourceFile(Buffer.from(manifest)))
const actions = await planSourcePublication({
  previous,
  next,
  async remoteFile(path) {
    const remote = remoteTree.get(path)
    if (remote === undefined) return null
    const planned = next.get(path)
    if (planned?.blob === remote.id && planned.mode === remote.mode) {
      return { blob_id: remote.id, execute_filemode: remote.mode === '100755', last_commit_id: '' }
    }
    return publisher.file(path, remoteHead.id)
  },
})
// A large publication (the first one to a new project) goes as a sequence of
// commits; only the last names the new source in its first line, the
// provenance the next publication parses.
const chunks = chunkPublicationActions(actions)
const author = {
  authorName: run(['git', 'config', 'user.name'], repoRoot).trim(),
  authorEmail: run(['git', 'config', 'user.email'], repoRoot).trim(),
}
let commitSha = remoteHead.id
for (const [index, chunk] of (chunks.length === 0 ? [[]] : chunks).entries()) {
  const final = index === Math.max(chunks.length, 1) - 1
  commitSha = await publisher.commit({
    branch: profile.branch,
    expectedHead: commitSha,
    actions: chunk,
    message: final
      ? `agent-workflow ${head}`
      : partialPublicationMessage({
          previousSha: baseline.sourceSha,
          head,
          part: index + 1,
          parts: chunks.length,
        }),
    ...author,
  })
}
process.stdout.write(
  `published agent-workflow ${head} to ${profile.project}/${profile.branch}@${commitSha} (${actions.length} file actions in ${Math.max(chunks.length, 1)} commit(s))\n`,
)
if (!Bun.argv.includes('--no-release')) {
  const release = await releaseCommit({
    apiUrl: process.env.CS_API_URL ?? DEFAULT_API_URL,
    token: process.env.CS_TOKEN ?? '',
    project: profile.project,
    branch: profile.branch,
    commitSha,
    version: flag('--version') ?? 'patch',
    message: `agent-workflow ${head}`,
  })
  process.stdout.write(
    `release ${release.tag} (${release.id}) of ${profile.project}@${commitSha.slice(0, 12)}: ${release.status}\n`,
  )
}
