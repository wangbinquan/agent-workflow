import { z } from 'zod'
import { gitUrlCacheKeyWith, parseGitUrl, redactGitUrl } from '@agent-workflow/shared'
import type { SecretBox } from '@/auth/secretBox'
import { sha1Hex } from '@/util/hash'
import { redactSensitiveString } from '@/util/redact'
import { bytesDigest, valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  repositoryUrlFacts,
  repositoryUrlFactKey,
  repositoryCacheFactKey,
  emitBootRow,
  blockBootRow,
  createBootUpgradeFacts,
  type RepositoryUrlFact,
  type BootUpgradeFacts,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import type { LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import type {
  ConversionContribution,
  ConversionRule,
} from '@/platform/persistence/migration/conversion/rule'
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
      const rows = await bootSourceRows(input.source, 'cached_repos')
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
          blockBootRow(
            ctx,
            ref,
            row,
            lookupFact.reason ?? 'v2-boot-url-fact-missing',
            { cacheId: String(row.values.id) },
            [factId],
          )
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
