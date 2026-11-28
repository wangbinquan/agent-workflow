import { z } from 'zod'
import { gitUrlCacheKeyWith, parseGitUrl, redactGitUrl } from '@agent-workflow/shared'
import type { SecretBox } from '@/platform/contracts/secretBox'
import { sha1Hex } from '@/platform/contracts/hash'
import { redactSensitiveString } from '@/platform/logging/redact'
import { bytesDigest, valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  repositoryUrlFacts,
  repositoryUrlFactKey,
  repositoryCacheFactKey,
  emitBootRow,
  blockBootRow,
  bootRowArchive,
  recordBootUpgradeEffect,
  createBootUpgradeFacts,
  CONTRADICTED_URL_FACT_REASONS,
  LINKABLE_UNREADABLE_URL_REASONS,
  type RepositoryUrlFact,
  type BootUpgradeFacts,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { ConversionContractError } from '@/platform/persistence/migration/conversion/blockCodes'
import type { LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import type {
  ConversionContribution,
  ConversionRule,
  RuleContext,
} from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import {
  bootSourceRows,
  type BootUpgradeEnvironmentContribution,
  type BootUpgradeCaptureInput,
} from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'

const prefix = 'aw-legacy-url-hex-v1:'
const ref = { id: 'source-control/boot-repository-urls', version: 2 } as const
const cachedFactSchema = z.strictObject({
  id: z.string(),
  sourceDigest: z.string(),
  urlEnc: z.string().nullable(),
  urlRedacted: z.string().nullable(),
  reason: z.string().nullable(),
})
/**
 * RFC-626 §3.4 row 4: reasons a cached repository's address could not be read back while the
 * row itself is consistent — the key is missing or another one, or a legacy escrow is damaged.
 * The automatic upgrade keeps such a repository; tasks, mounts and schedules still link to it
 * by URL hash, as v0.19.2 did at boot. The integration schedule rule keeps an equal list (a
 * guard test compares them); modules do not import each other's migration code.
 */
export const KEPT_UNREADABLE_URL_REASONS = LINKABLE_UNREADABLE_URL_REASONS
const CONTRADICTED_URL_FACTS = CONTRADICTED_URL_FACT_REASONS
export const URL_KEPT_UNREADABLE = 'v2-boot-url-kept-unreadable'
/**
 * Whether the backup preparation of the new version can turn this legacy escrow into sealed
 * ciphertext. It decodes every escrow on every backup and refuses the whole backup for one it
 * cannot decode (`services/repoCredentials.ts` `decodeLegacyUrlEscrow`), so an escrow that fails
 * here must not reach the new database.
 */
export function legacyUrlEscrowReadable(value: string): boolean {
  if (!value.startsWith(prefix)) return false
  const hex = value.slice(prefix.length)
  if (!hex || hex.length % 2 || !/^[a-f0-9]+$/i.test(hex)) return false
  try {
    const plain = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex'))
    return plain.length > 0 && parseGitUrl(plain) !== null
  } catch {
    return false
  }
}
/**
 * RFC-626 §3.4 row 4, automatic resolution: the repository is converted although its address
 * could not be read back. A sealed address stays as it is, so restoring the key makes it usable
 * again. A legacy escrow the new version cannot decode is cleared, display form included: the
 * product then shows the address as unavailable and refuses to refresh, which it decides by a
 * NULL `url_redacted` (`repositoryMirrorCache.ts`); the original row goes to an archive.
 */
function keepUnreadableRepository(
  ctx: RuleContext,
  row: SourceRow,
  reason: string,
  factId: string,
): void {
  const stored = typeof row.values.url_enc === 'string' ? row.values.url_enc : null
  const escrow = stored?.startsWith(prefix) ?? false
  const cleared = escrow && !legacyUrlEscrowReadable(stored!)
  const values = {
    ...row.values,
    ...(cleared ? { url_enc: null, url_redacted: null } : {}),
    last_submodule_sync_error:
      typeof row.values.last_submodule_sync_error === 'string'
        ? redactSensitiveString(row.values.last_submodule_sync_error)
        : (row.values.last_submodule_sync_error ?? null),
  }
  const fields = Object.keys(values).filter(
    (column) => values[column as keyof typeof values] !== row.values[column],
  )
  const cacheId = String(row.values.id)
  const targets = [{ table: row.table, key: ctx.target.key(row.table, values) }]
  const archive = fields.length ? bootRowArchive(ctx, row) : null
  const before = {
    cacheId,
    encoding: escrow ? 'escrow' : 'sealed',
    display: typeof row.values.url_redacted === 'string' ? row.values.url_redacted : null,
  }
  const after = {
    cacheId,
    reason,
    address: cleared ? 'cleared' : 'unchanged',
    fields,
    error:
      typeof values.last_submodule_sync_error === 'string'
        ? values.last_submodule_sync_error
        : null,
  }
  // Recorded first: the decision names the row before the row's own outputs classify it.
  ctx.out.record(
    {
      kind: 'decision',
      code: URL_KEPT_UNREADABLE,
      payload: {
        automatic: 'kept',
        sourceTable: row.table,
        sourceKey: row.encodedKey,
        cacheId,
        reason,
        encoding: before.encoding,
        address: after.address,
        archive,
      },
    },
    row,
  )
  ctx.out.row(row.table, values, row)
  if (archive)
    ctx.out.exception({
      sourceTable: row.table,
      sourceKey: row.encodedKey,
      sourcePhase: row.phase,
      class: 'converted',
      kind: 'conflict-resolved',
      targets,
      archive,
      decision: { code: URL_KEPT_UNREADABLE, detail: after },
    })
  recordBootUpgradeEffect(ctx, ref, row, {
    disposition: archive ? 'transformed' : 'copied',
    targets,
    before,
    after,
    reason: URL_KEPT_UNREADABLE,
    factIds: [factId],
  })
}
export interface RepositoryUrlKeyProvider {
  open(
    input: BootUpgradeCaptureInput,
  ): Promise<{ identity: string; fingerprint: string; box: SecretBox } | null>
}
export function repositoryUrlEnvironment(
  keys: RepositoryUrlKeyProvider,
): BootUpgradeEnvironmentContribution {
  return {
    id: ref.id,
    async capture(input) {
      const rows = await bootSourceRows(input.source, 'cached_repos', input)
      let key: Awaited<ReturnType<RepositoryUrlKeyProvider['open']>> = null
      let keyUnavailable = false
      try {
        key = await keys.open(input)
      } catch {
        keyUnavailable = true
      }
      const facts = []
      for (const row of rows) {
        const id = String(row.id)
        const sourceDigest = valueDigest(row)
        let urlEnc = typeof row.url_enc === 'string' ? row.url_enc : null
        let urlRedacted = typeof row.url_redacted === 'string' ? row.url_redacted : null
        let reason: string | null = null
        let decodedDigest: string | null = null
        const needsChange = !!urlEnc?.startsWith(prefix) || (!!urlEnc && urlRedacted === null)
        if (needsChange) {
          try {
            if (!key)
              throw new Error(
                keyUnavailable ? 'v2-boot-url-key-unreadable' : 'v2-boot-url-key-missing',
              )
            let plain: string
            if (urlEnc!.startsWith(prefix)) {
              const hex = urlEnc!.slice(prefix.length)
              if (!hex || hex.length % 2 || !/^[a-f0-9]+$/i.test(hex))
                throw new Error('v2-boot-url-escrow-invalid')
              plain = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex'))
            } else plain = key.box.unseal(urlEnc!)
            if (!plain || !parseGitUrl(plain)) throw new Error('v2-boot-url-decode-invalid')
            decodedDigest = bytesDigest(plain)
            urlRedacted = redactGitUrl(plain)
            if (urlEnc!.startsWith(prefix)) {
              const name = `boot-url-output/${valueDigest({ id, urlEnc, key: key.fingerprint }).slice(7)}.json`
              const previous = await input.readArtifact(name)
              if (previous) {
                const saved = z
                  .strictObject({ ciphertext: z.string(), plaintextDigest: z.string() })
                  .parse(JSON.parse(Buffer.from(previous).toString('utf8')))
                if (
                  saved.plaintextDigest !== decodedDigest ||
                  bytesDigest(key.box.unseal(saved.ciphertext)) !== decodedDigest
                )
                  throw new Error('v2-boot-url-output-conflict')
                urlEnc = saved.ciphertext
              } else {
                urlEnc = key.box.seal(plain)
                await input.writeArtifact(
                  name,
                  Buffer.from(
                    JSON.stringify({ ciphertext: urlEnc, plaintextDigest: decodedDigest }),
                  ),
                )
              }
            }
          } catch (error) {
            reason =
              error instanceof Error && error.message.startsWith('v2-boot-')
                ? error.message
                : 'v2-boot-url-decode-unproven'
          }
        }
        facts.push({
          id: `repository-url:${id}`,
          kind: 'repository-url-key' as const,
          material: needsChange
            ? {
                id,
                decodedDigest,
                urlRedacted,
                reason,
              }
            : null,
          evidence: { id, sourceDigest, urlEnc, urlRedacted, reason },
        })
      }
      return facts
    },
  }
}

export function repositoryUrlConversion(facts: BootUpgradeFacts): ConversionContribution {
  const bound = new Map(
    facts.facts
      .filter((fact) => fact.kind === 'repository-url-key')
      .map((fact) => [fact.id, cachedFactSchema.parse(fact.evidence)]),
  )
  const lookup: LookupBuilder<RepositoryUrlFact> = {
    key: repositoryUrlFacts,
    sources: ['cached_repos', 'tasks', 'task_repos', 'scheduled_tasks'],
    build(staged, put) {
      const caches = [...staged.rows('cached_repos')]
      const byHash = new Map<string, string[]>()
      for (const row of caches) {
        const hash = String(row.values.url_hash)
        byHash.set(hash, [...(byHash.get(hash) ?? []), String(row.values.id)])
      }
      const cacheFacts = new Map<string, RepositoryUrlFact>()
      for (const row of caches) {
        const id = String(row.values.id),
          factId = `repository-url:${id}`
        const fact = bound.get(factId)
        const reason = row.codecFailure
          ? 'v2-boot-url-source-codec'
          : !fact
            ? 'v2-boot-url-fact-missing'
            : fact.sourceDigest !== valueDigest(row.values)
              ? 'v2-boot-url-source-changed'
              : fact.reason
        const value: RepositoryUrlFact = {
          state: reason ? 'blocked' : 'proven',
          cachedRepoId: id,
          repoUrl: fact?.urlRedacted ?? null,
          rawUrlDigest: null,
          factIds: [factId],
          reason,
        }
        cacheFacts.set(id, value)
        put(repositoryCacheFactKey(id), value)
      }
      const urls = new Set<string>()
      for (const table of ['tasks', 'task_repos'])
        for (const row of staged.rows(table))
          if (typeof row.values.repo_url === 'string' && row.values.repo_url)
            urls.add(row.values.repo_url)
      for (const row of staged.rows('scheduled_tasks')) {
        try {
          const body = JSON.parse(String(row.values.launch_payload)) as Record<string, unknown>
          for (const candidate of [body, ...(Array.isArray(body?.repos) ? body.repos : [])])
            if (
              candidate &&
              typeof candidate === 'object' &&
              typeof candidate.repoUrl === 'string' &&
              candidate.repoUrl
            )
              urls.add(candidate.repoUrl)
        } catch {
          /* The schedule rule reports the undecodable source row. */
        }
      }
      for (const url of urls) {
        const parsed = parseGitUrl(url)
        const ids = parsed ? (byHash.get(gitUrlCacheKeyWith(parsed, sha1Hex).hash) ?? []) : []
        const cache = ids.length === 1 ? cacheFacts.get(ids[0]!) : undefined
        const reason = ids.length > 1 ? 'v2-boot-url-reference-conflict' : (cache?.reason ?? null)
        put(repositoryUrlFactKey(url), {
          state: reason ? 'blocked' : 'proven',
          cachedRepoId: ids.length === 1 ? ids[0]! : null,
          repoUrl: redactSensitiveString(url),
          rawUrlDigest: bytesDigest(url),
          factIds: cache?.factIds ?? [],
          reason,
        })
      }
    },
  }
  const rule: ConversionRule = {
    ref,
    owner: 'source-control',
    claims: ['cached_repos'],
    produces: [{ table: 'cached_repos' }],
    lookups: [repositoryUrlFacts],
    unit: { kind: 'source-chunk', table: 'cached_repos' },
    convert(unit, ctx) {
      for (const row of unit.rows.get('cached_repos') ?? []) {
        const factId = `repository-url:${row.values.id}`,
          fact = bound.get(factId)
        const lookupFact = ctx
          .lookup(repositoryUrlFacts)
          .require(repositoryCacheFactKey(String(row.values.id)))
        if (!fact || lookupFact.state === 'blocked') {
          const reason = lookupFact.reason ?? 'v2-boot-url-fact-missing'
          if (ctx.resolution === 'automatic') {
            if (CONTRADICTED_URL_FACTS.includes(reason))
              throw new ConversionContractError(reason, `cached_repos/${String(row.values.id)}`)
            if (fact && KEPT_UNREADABLE_URL_REASONS.includes(reason)) {
              keepUnreadableRepository(ctx, row, reason, factId)
              continue
            }
          }
          blockBootRow(ctx, ref, row, reason, { cacheId: String(row.values.id) }, [factId])
          continue
        }
        const values = {
          ...row.values,
          url_enc: fact.urlEnc,
          url_redacted: fact.urlRedacted,
          last_submodule_sync_error:
            typeof row.values.last_submodule_sync_error === 'string'
              ? redactSensitiveString(row.values.last_submodule_sync_error)
              : (row.values.last_submodule_sync_error ?? null),
        }
        const fields = Object.keys(values).filter(
          (column) => values[column as keyof typeof values] !== row.values[column],
        )
        emitBootRow(ctx, ref, row, values, {
          changed: fields.length > 0,
          before: {
            cacheId: fact.id,
            encoding: String(row.values.url_enc ?? '').startsWith(prefix) ? 'escrow' : 'sealed',
            display: typeof row.values.url_redacted === 'string' ? row.values.url_redacted : null,
            error:
              typeof row.values.last_submodule_sync_error === 'string'
                ? row.values.last_submodule_sync_error
                : null,
          },
          after: {
            cacheId: fact.id,
            display: fact.urlRedacted,
            fields,
            encoding: 'sealed',
            error:
              typeof values.last_submodule_sync_error === 'string'
                ? values.last_submodule_sync_error
                : null,
          },
          reason: fields.length ? 'v2-boot-url-converged' : 'v2-boot-url-unchanged',
          factIds: [factId],
        })
      }
    },
  }
  return { rules: [rule], lookups: [lookup], validators: [] }
}
export const conversion: ConversionContribution = {
  ...repositoryUrlConversion(createBootUpgradeFacts([])),
  withBootUpgrade: repositoryUrlConversion,
}
