// RFC-370 M0 — publish the committed agent-workflow sources to a CrewStation project.
//
//   bun run scripts/crewstation-publish.ts --profile <profile.json> [--version patch|vX.Y.Z] [--no-release]
//
// 1. `git archive HEAD` (committed sources only — never the working tree);
// 2. add `deploy/crewstation/Dockerfile` and the rendered `crewstation.yaml` at
//    the root, as the platform builds the repository root;
// 3. commit that snapshot on the project's branch and push it;
// 4. `crewstation publish <project> --branch <branch>`: the platform tags,
//    builds, runs `agent-workflow migrate` and deploys the standby slot. Traffic
//    is switched by the project owner (`crewstation traffic switch`).
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

const profilePath = flag('--profile')
if (profilePath === undefined) {
  console.error(
    'usage: bun run scripts/crewstation-publish.ts --profile <profile.json> [--version patch|vX.Y.Z] [--no-release]',
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
    const version = flag('--version')
    process.stdout.write(
      run(
        [
          'crewstation',
          'publish',
          profile.project,
          '--branch',
          profile.branch,
          ...(version === undefined ? [] : ['--version', version]),
        ],
        repoRoot,
      ),
    )
  }
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
