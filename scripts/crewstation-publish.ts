// RFC-370 M0 — publish the committed agent-workflow sources to a CrewStation project.
//
//   CS_TOKEN=<platform session> [CS_API_URL=<platform api>] \
//     bun run scripts/crewstation-publish.ts --profile <profile.json> [--version patch|minor|major|vX.Y.Z] [--no-release]
//
// 1. `git archive HEAD` (committed sources only — never the working tree);
// 2. add `deploy/crewstation/Dockerfile` and the rendered `crewstation.yaml` at
//    the root, as the platform builds the repository root;
// 3. commit that snapshot on the project's branch and push it;
// 4. release exactly that commit through the platform release API
//    (`POST /v1/services/:serviceId/releases` with `expectedCommitSha`): the
//    platform tags, builds, runs `agent-workflow migrate` and deploys the
//    standby slot. `crewstation publish` is the development-session entry (it
//    pushes the session workspace) and does not apply to a pushed snapshot.
//    Traffic is switched by the project owner (`crewstation traffic switch`).
//
// The session value (`CS_TOKEN`, the same one the `crewstation` CLI reads) is
// sent as the platform session cookie and never printed.
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseDeploymentProfile, renderCrewStationManifest } from './lib/crewstation-manifest'

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
    'usage: bun run scripts/crewstation-publish.ts --profile <profile.json> [--version patch|minor|major|vX.Y.Z] [--no-release]',
  )
  process.exit(2)
}
const profile = parseDeploymentProfile(JSON.parse(readFileSync(profilePath, 'utf8')))
const head = run(['git', 'rev-parse', 'HEAD'], repoRoot).trim()
const manifest = renderCrewStationManifest(
  readFileSync(join(repoRoot, 'deploy', 'crewstation', 'crewstation.template.yaml'), 'utf8'),
  profile,
)

const workspace = mkdtempSync(join(tmpdir(), 'aw-crewstation-publish-'))
try {
  const checkout = join(workspace, 'project')
  run(
    ['git', 'clone', '--quiet', '--branch', profile.branch, profile.repository, checkout],
    workspace,
  )
  // Replace the tracked tree wholesale; the project history keeps one commit per publish.
  for (const entry of readdirSync(checkout)) {
    if (entry !== '.git') rmSync(join(checkout, entry), { recursive: true, force: true })
  }
  const archive = Bun.spawnSync(['git', 'archive', '--format=tar', head], { cwd: repoRoot })
  if (archive.exitCode !== 0) throw new Error(`git archive failed:\n${archive.stderr.toString()}`)
  run(['tar', '-x', '-f', '-'], checkout, archive.stdout)
  copyFileSync(join(repoRoot, 'deploy', 'crewstation', 'Dockerfile'), join(checkout, 'Dockerfile'))
  writeFileSync(join(checkout, 'crewstation.yaml'), manifest)
  run(['git', 'add', '-A'], checkout)
  const changed = run(['git', 'status', '--porcelain'], checkout).trim().length > 0
  if (changed) {
    run(['git', 'commit', '--quiet', '-m', `agent-workflow ${head}`], checkout)
    run(['git', 'push', '--quiet', 'origin', `HEAD:${profile.branch}`], checkout)
    process.stdout.write(`pushed agent-workflow ${head} to ${profile.project}/${profile.branch}\n`)
  } else {
    process.stdout.write(
      `${profile.project}/${profile.branch} already carries agent-workflow ${head}\n`,
    )
  }
  if (!Bun.argv.includes('--no-release')) {
    const commitSha = run(['git', 'rev-parse', 'HEAD'], checkout).trim()
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
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
