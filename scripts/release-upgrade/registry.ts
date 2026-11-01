#!/usr/bin/env bun
/** RFC-398 T7. Run with Bun 1.4.3. --check regenerates in memory, never writes fixtures. */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LEGACY_MIGRATION_HASHES } from '../../packages/backend/src/platform/persistence/migration/epoch1/journalAliases'
import { buildIdentity, executableName, l1Builds, PLATFORMS, selectRegistryTags } from './lib/model'
import type {
  BinarySource,
  ReleaseEntry,
  ReleasedSql,
  ReleaseRegistry,
  PostgresqlReceipt,
} from './lib/model'
import {
  canonical,
  command,
  FIXTURES,
  REGISTRY_PATH,
  REPO_ROOT,
  sha256,
  readL2Approvals,
} from './lib/io'
import { git, TagSource } from './lib/tag-source'

interface Asset {
  name: string
  digest: string | null
}
interface GithubRelease {
  tag_name: string
  draft: boolean
  assets: Asset[]
}
interface PgJournal {
  baselineId: string
  contractDigest: string
  planDigest: string
}
interface PgUpgrade {
  id: string
  digest: string
  sqlFile: string
  to: { contractDigest: string; planDigest: string }
}
const SQLITE = 'packages/backend/db/migrations'
const PG = 'packages/backend/db/postgresql-migrations'
const HISTORY = 'packages/backend/db/schema-history/epoch2'
const REPOSITORY = 'wangbinquan/agent-workflow'
const RETAINED: Readonly<Record<string, string>> = {
  'linux-x86_64': '364fafdbfdd4f54d360c4186ececbfed1aef96da9f25c32861544afb5768f4ca',
  'macos-arm64': '32fc13bd6a17c6fa6b95d269a6d87d8e2be6d337a9574115bd7346b8d2944d9a',
  'windows-x86_64': '45f31105795a3531f184200dddc189292325538f24f38f8e530496bb35cecbb2',
}

function runtimeFor(source: TagSource): ReleaseEntry['runtime'] {
  const path =
    [...source.files.keys()].find((file) => file.endsWith('/util/opencode.ts')) ??
    [...source.files.keys()].find((file) => file.endsWith('/runtime/opencode/util.ts')) ??
    [...source.files.keys()].find((file) => file.endsWith('/opencodeProbe.ts'))
  if (!path)
    throw new Error(`${source.tag}: inspect the new runtime probe layout before registering`)
  const probe = source.text(path)
  const minimum =
    /(?:export )?const MIN_OPENCODE_VERSION\s*=\s*['"]([^'"]+)/.exec(probe)?.[1] ?? null
  const maximumExclusive =
    /(?:export )?const MAX_OPENCODE_VERSION_EXCLUSIVE\s*=\s*['"]([^'"]+)/.exec(probe)?.[1] ?? null
  const route = (name: string) => source.text(`packages/backend/src/routes/${name}.ts`)
  const shared = (name: string) => source.text(`packages/shared/src/schemas/${name}.ts`)
  const workflow = shared('workflow')
  const agent = shared('agent')
  const auth = route('auth')
  const nonce = [...source.files.keys()]
    .filter(
      (file) =>
        file.startsWith('packages/backend/src/') &&
        /(?:envelope|prompt|protocol)/i.test(file) &&
        file.endsWith('.ts'),
    )
    .some((file) => /nonce=|RFC-200/.test(source.text(file)))
  // v0.15.x mint a run nonce (db/schema.ts, nodeRunMint.ts) and teach the envelope parser and the
  // shared prompt builder about it, but the runner passes it into the prompt only from v0.16.0;
  // their stub runs failed "prompt is missing the RFC-200 envelope nonce" (nightly 41287876705).
  const promptNonce = source
    .grepFiles('envelopeNonce', 'packages/backend/src')
    .some((file) => !/(?:^|\/)db\/schema\.ts$|[Mm]int[^/]*\.ts$/.test(file))
  const capabilities: ReleaseEntry['runtime']['capabilities'] = {
    auth: auth.includes('/api/auth/bootstrap/admin')
      ? 'bootstrap'
      : auth.includes('/api/auth/login')
        ? 'session'
        : 'token',
    profile: auth.includes('/api/auth/me/profile'),
    profileGitName: /\bgitName:/.test(shared('user')),
    mcps: source.has('packages/backend/src/routes/mcps.ts'),
    schedules:
      source.has('packages/backend/src/routes/scheduled-tasks.ts') ||
      source.has('packages/backend/src/routes/scheduledTasks.ts'),
    scheduleEnvelope: /launchPayload/.test(shared('scheduledTask')),
    workgroups: source.has('packages/backend/src/routes/workgroups.ts'),
    memories: [...source.files.keys()].some((file) =>
      /^packages\/backend\/src\/routes\/memor(?:y|ies)(?:\/|\.ts)/.test(file),
    ),
    clarify: /['"]clarify['"]/.test(workflow),
    nonce,
    promptNonce,
    agentId: /agentId:/.test(workflow),
    skillId: route('skills').includes('/api/skills/:id'),
    workgroupId: route('workgroups').includes('/api/workgroups/:id'),
    repoUrl: /repoUrl:/.test(shared('task')),
    workflowSchema: Number(
      /WORKFLOW_SCHEMA_VERSION\s*=\s*(\d+)/.exec(workflow)?.[1] ??
        /\$schema_version:\s*z\.literal\((\d+)\)/.exec(workflow)?.[1] ??
        1,
    ),
    permission: /permission:/.test(agent),
    readonly: /readonly:\s*z\./.test(agent),
    businessWorkflow:
      nonce && workflow.includes('wrapper-fanout') && workflow.includes('outputKinds'),
  }
  // Some workflow schemas keep output kinds on agents rather than nodes.
  capabilities.businessWorkflow =
    nonce && workflow.includes('wrapper-fanout') && agent.includes('outputKinds')
  return {
    probeVersion: minimum ?? '1.18.3',
    minimum,
    maximumExclusive,
    source: path,
    sourceSha256: sha256(probe),
    capabilities,
  }
}

export async function generateRegistry(options: { readonly candidate?: string } = {}): Promise<{
  registry: ReleaseRegistry
  files: Map<string, Buffer>
}> {
  const tags = selectRegistryTags(
    git(['tag', '--list', 'v*']).toString().trim().split('\n').filter(Boolean),
    options.candidate,
  )
  if (!tags.length || !tags[0])
    throw new Error('No local release tags; use a checkout with complete tags')
  const pages = JSON.parse(
    (
      await command(['gh', 'api', `repos/${REPOSITORY}/releases`, '--paginate', '--slurp'])
    ).toString(),
  ) as GithubRelease[][]
  const github = new Map(pages.flat().map((release) => [release.tag_name, release]))
  const files = new Map<string, Buffer>()
  const approvals = new Map(readL2Approvals().map((entry) => [entry.tag, entry]))
  const releases: ReleaseEntry[] = []
  for (const tag of tags) {
    const source = new TagSource(tag)
    const commit = git(['rev-parse', `${tag}^{commit}`])
      .toString()
      .trim()
    const pkg = source.json<{ packageManager?: string }>('package.json')
    const bunVersion = /^bun@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? '')?.[1]
    if (!bunVersion) throw new Error(`${tag}: no exact Bun version declared in packageManager`)
    const releasedSql: ReleasedSql[] = []
    const sql = (provider: 'sqlite' | 'postgresql', migration: string): string => {
      const path = `${provider === 'sqlite' ? SQLITE : PG}/${migration}.sql`
      const bytes = source.read(path)
      // Drizzle hashes the complete UTF-8 SQL BEFORE splitting statement-breakpoints.
      const hash = sha256(bytes.toString('utf8'))
      const frozen = join(REPO_ROOT, path)
      const frozenSha256 = existsSync(frozen) ? sha256(readFileSync(frozen).toString('utf8')) : null
      if (hash !== frozenSha256) {
        const file = `released-sql/${hash}.sql`
        files.set(file, bytes)
        releasedSql.push({
          provider,
          migration,
          sha256: hash,
          file,
          frozenSha256,
          recognizedAlias:
            provider === 'sqlite' && (LEGACY_MIGRATION_HASHES[migration]?.includes(hash) ?? false),
        })
      }
      return hash
    }
    const historyFiles = [...source.files.keys()]
      .filter((path) => path.startsWith(`${HISTORY}/`) && path.endsWith('.contract.json'))
      .sort()
    let epoch1: ReleaseEntry['epoch1'] = null
    let epoch2: ReleaseEntry['epoch2'] = null
    if (historyFiles.length) {
      const historyFile = historyFiles.at(-1)!
      const history = historyFile.slice(HISTORY.length + 1, -'.contract.json'.length)
      const contract = source.json<{ version: number; digest: string }>(historyFile)
      const sqlite = source.json<{ digest: string }>(`${HISTORY}/${history}.sqlite-plan.json`)
      const postgresql = source.json<{ digest: string }>(
        `${HISTORY}/${history}.postgresql-plan.json`,
      )
      epoch2 = {
        history,
        version: contract.version,
        contractDigest: contract.digest,
        sqlitePlanDigest: sqlite.digest,
        postgresqlPlanDigest: postgresql.digest,
      }
    } else {
      const journal = source.json<{ entries: { tag: string; when: number }[] }>(
        `${SQLITE}/meta/_journal.json`,
      )
      const sqlite = journal.entries.map((entry) => ({
        tag: entry.tag,
        created_at: entry.when,
        hash: sql('sqlite', entry.tag),
      }))
      let postgresql: PostgresqlReceipt[] | null = null
      let postgresqlSource: NonNullable<ReleaseEntry['epoch1']>['postgresqlSource'] = null
      let postgresqlBaselinePath: string | null = null
      if (source.has(`${PG}/meta/_journal.json`)) {
        const baseline = source.json<PgJournal>(`${PG}/meta/_journal.json`)
        postgresql = [
          {
            baselineId: baseline.baselineId,
            contractDigest: baseline.contractDigest,
            planDigest: baseline.planDigest,
            sqlFile: '0000_rfc349_baseline.sql',
            sqlSha256: sql('postgresql', '0000_rfc349_baseline'),
          },
        ]
        for (const path of [...source.files.keys()]
          .filter((file) => file.startsWith(`${PG}/meta/`) && file.endsWith('.upgrade.json'))
          .sort()) {
          const upgrade = source.json<PgUpgrade>(path)
          postgresql.push({
            baselineId: `upgrade:${upgrade.id}:${upgrade.digest}`,
            contractDigest: upgrade.to.contractDigest,
            planDigest: upgrade.to.planDigest,
            sqlFile: upgrade.sqlFile,
            sqlSha256: sql('postgresql', upgrade.sqlFile.replace(/\.sql$/, '')),
          })
        }
        const current = JSON.parse(
          readFileSync(join(REPO_ROOT, PG, 'meta/_journal.json'), 'utf8'),
        ) as PgJournal
        postgresqlSource =
          baseline.contractDigest === current.contractDigest &&
          baseline.planDigest === current.planDigest
            ? 'frozen'
            : 'released-baseline'
        if (postgresqlSource === 'released-baseline') {
          files.set(
            `released-postgresql/${tag}/meta/_journal.json`,
            source.read(`${PG}/meta/_journal.json`),
          )
          postgresqlBaselinePath = `packages/backend/src/platform/persistence/migration/epoch1/released-postgresql/${tag}`
        }
      }
      const head = postgresql?.at(-1)
      const postgresqlFresh = head
        ? [
            {
              baselineId: postgresql![0]!.baselineId,
              contractDigest: head.contractDigest,
              planDigest: head.planDigest,
            },
          ]
        : null
      epoch1 = { sqlite, postgresql, postgresqlFresh, postgresqlSource, postgresqlBaselinePath }
    }
    const binaries: ReleaseEntry['binaries'] = {}
    const release = github.get(tag)
    for (const platform of PLATFORMS) {
      const retained = tag === 'v0.19.3' && RETAINED[platform] !== undefined
      const releaseTag = retained ? 'upgrade-fixture-binaries' : tag
      const releaseSource = retained ? github.get(releaseTag) : release
      if (releaseSource?.draft && !retained)
        throw new Error(`${tag}: draft release is not published evidence`)
      const name = retained
        ? `agent-workflow-${tag}-${platform}${platform.startsWith('windows') ? '.exe' : ''}`
        : executableName(platform)
      const asset = releaseSource?.assets.find((item) => item.name === name)
      if (!asset) {
        if (retained)
          throw new Error(
            `${releaseTag}/${name} missing; do not silently downgrade retained evidence`,
          )
        continue
      }
      let hash = asset.digest?.replace(/^sha256:/, '')
      let digestSource: BinarySource['digestSource'] = 'github-metadata'
      if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
        // gh writes raw asset bytes to stdout with --output -.
        hash = sha256(
          await command([
            'gh',
            'release',
            'download',
            releaseTag,
            '--repo',
            REPOSITORY,
            '--pattern',
            name,
            '--output',
            '-',
          ]),
        )
        digestSource = 'download'
      }
      if (retained && hash !== RETAINED[platform])
        throw new Error(`Retained ${name} digest differs from approved provenance`)
      binaries[platform] = {
        kind: retained ? 'retained-asset' : 'release-asset',
        release: releaseTag,
        asset: name,
        sha256: hash,
        digestSource,
        evidenceLevel: retained ? 2 : 1,
        ...(retained
          ? { provenance: { runId: 41157876045, commit, reportedVersion: 'd7b5d9d' } }
          : {}),
      }
    }
    const driver = source.text('packages/backend/src/services/runtime/opencode/driver.ts')
    const unsupported = driver.includes('buildVerifiedOpencodeBusinessPlan')
      ? 'Published production driver requires the RFC-224 official OpenCode SHA-256 allowlist and direct-API launcher; the compiled stub cannot pass it. See this tag: packages/backend/src/services/runtime/opencode/{driver,verifiedPlan,officialBuilds}.ts. L2 exclusion requires user approval; L1 remains required.'
      : undefined
    const approval = approvals.get(tag)
    if (approval && approval.reason !== unsupported)
      throw new Error(`${tag}: L2 approval no longer matches its source-derived reason`)
    if (unsupported && !approval)
      throw new Error(`${tag}: unsupported L2 driver requires an exact user approval`)
    approvals.delete(tag)
    const entry: ReleaseEntry = {
      tag,
      commit,
      bunVersion,
      epoch1,
      epoch2,
      releasedSql,
      buildKey: `sha256:${sha256(canonical(buildIdentity({ epoch1, epoch2, releasedSql })))}`,
      binaries,
      binaryAbsence: Object.keys(binaries).length
        ? null
        : 'No published GitHub Release binary assets for this tag; tag-build is the lowest-evidence fallback.',
      fallback: { kind: 'tag-build', evidenceLevel: 4, bunVersion },
      runtime: runtimeFor(source),
      l2: {
        gate: false,
        nightly: binaries['linux-x86_64'] !== undefined,
        shard: binaries['linux-x86_64'] ? `linux-${tag}` : null,
        ...(unsupported ? { unsupported } : {}),
        ...(approval
          ? { approval: { approvedBy: approval.approvedBy, approvedAt: approval.approvedAt } }
          : {}),
      },
    }
    releases.push(entry)
  }
  // Cover earliest format, pre/post nonce protocol, released 0111, both PG bridges,
  if (approvals.size)
    throw new Error(`L2 approvals reference absent releases: ${[...approvals.keys()].join(', ')}`)
  // latest epoch-1 and epoch-2. New releases automatically join the gate as latest.
  const gate = new Set([
    releases[0]!.tag,
    'v0.10.0',
    'v0.16.3',
    'v0.18.10',
    'v0.18.18',
    'v0.18.19',
    'v0.19.2',
    releases.at(-1)!.tag,
  ])
  for (const release of releases) release.l2.gate = gate.has(release.tag)
  return {
    registry: {
      formatVersion: 1,
      repository: REPOSITORY,
      releases,
      l1Builds: l1Builds(releases),
      nightlyShards: releases
        .filter((release) => release.l2.nightly)
        .map((release) => ({ id: release.l2.shard!, tags: [release.tag] })),
    },
    files,
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const usage =
    'Usage: bun scripts/release-upgrade/registry.ts --write | --check [--candidate vX.Y.Z]'
  const mode = args[0]
  const candidate =
    args.length === 3 && args[1] === '--candidate' ? args[2] : args.length === 1 ? undefined : null
  if ((mode !== '--write' && mode !== '--check') || candidate === null) throw new Error(usage)
  // The candidate's own release is a draft until the gate passes; it is not yet evidence.
  if (mode === '--write' && candidate !== undefined) throw new Error(usage)
  const { registry, files } = await generateRegistry({ candidate })
  files.set('releases.json', Buffer.from(`${JSON.stringify(registry, null, 2)}\n`))
  const differences: string[] = []
  for (const [relative, bytes] of files) {
    const path = join(FIXTURES, relative)
    if (args[0] === '--write') {
      // Do not rewrite immutable released bytes (or another session's identical fixtures).
      if (existsSync(path) && readFileSync(path).equals(bytes)) continue
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, bytes)
    } else if (!existsSync(path) || !readFileSync(path).equals(bytes)) differences.push(relative)
  }
  if (differences.length)
    throw new Error(`Release registry drift: ${differences.join(', ')}. Regenerate with --write.`)
  console.log(
    `${args[0]}: ${registry.releases.length} releases, ${registry.l1Builds.length} L1 builds; ${REGISTRY_PATH}`,
  )
}
