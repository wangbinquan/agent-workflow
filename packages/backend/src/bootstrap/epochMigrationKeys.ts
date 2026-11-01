import { existsSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from '@/util/hash'
import { createSecretBoxFromKey, ensureSecretKey } from '@/auth/secretBox'
import type { RepositoryUrlKeyProvider } from '@/modules/source-control/composition/conversion'
import {
  bootSourceRows,
  type BootUpgradeCaptureInput,
} from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'

const LEGACY_URL_ESCROW_PREFIX = 'aw-legacy-url-hex-v1:'

/**
 * Offline migrations report operator notices on stderr with the `WARN ` prefix: `start` relays
 * such lines from its `db migration auto` child into its own log (the same channel as history
 * restrictions). stdout is never used: it carries `--json` results, and the logger writes there.
 */
function warnLine(line: string): void {
  try {
    writeSync(2, `WARN ${line}\n`)
  } catch (error) {
    // A SIGKILLed delegating parent closes its pipe; the child still finishes the session.
    if (!['EPIPE', 'EIO'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
}

/**
 * RFC-398 (user decision 2026-11-01): installations from before v0.5.0 never had secret.key, and
 * their repository URLs reach the boot upgrade only as the legacy escrow the frozen chain writes.
 * Their next daemon boot (v0.5.0+) would have created the key; an automatic upgrade straight from
 * such a release was refused instead (`v2-boot-url-key-missing`, release-upgrade nightly
 * 41287876705, v0.2.0). The migration performs that same first-boot step for a live app home at
 * its first capture, so every later capture and retry seals with one key. A source that holds
 * sealed URLs without their key stays blocked: those URLs need the original key.
 */
async function createKeyForLegacyUrls(
  input: BootUpgradeCaptureInput,
  path: string,
  warn: (line: string) => void,
): Promise<Buffer | null> {
  const encoded = (await bootSourceRows(input.source, 'cached_repos'))
    .map((row) => (typeof row.url_enc === 'string' ? row.url_enc : ''))
    .filter(Boolean)
  if (encoded.length === 0 || encoded.some((value) => !value.startsWith(LEGACY_URL_ESCROW_PREFIX)))
    return null
  const key = ensureSecretKey(path)
  const fingerprint = `sha256:${sha256Hex(key)}`
  warn(
    `created secret.key for legacy repository URLs (pre-v0.5.0 installation): ${path} ` +
      `(${encoded.length} repositories, ${fingerprint})`,
  )
  await input.writeArtifact(
    'boot-url-key/created.json',
    Buffer.from(
      JSON.stringify({ path, fingerprint, repositories: encoded.length, stage: input.stage }),
    ),
  )
  return key
}

/** A backup carries its original key. Hosted sources use the platform's existing source key.
 * Only a live app home whose repository URLs are all legacy escrow gets a newly created key
 * (`createKeyForLegacyUrls`); no other path creates or writes a key file. */
export function epochMigrationKeys(
  hostedKey?: () => Uint8Array | null,
  installationRoot?: string,
  warn: (line: string) => void = warnLine,
): RepositoryUrlKeyProvider {
  return {
    async open(input) {
      const path = join(input.root.root, 'secret.key')
      let key =
        input.root.kind === 'backup' || !hostedKey
          ? existsSync(path)
            ? readFileSync(path)
            : null
          : hostedKey()
      let identity = input.root.kind === 'backup' || !hostedKey ? path : 'crewstation:source-secret'
      if (!key && input.root.kind === 'backup') {
        const fallback = installationRoot ? join(installationRoot, 'secret.key') : null
        key = fallback && existsSync(fallback) ? readFileSync(fallback) : (hostedKey?.() ?? null)
        if (key) {
          const box = createSecretBoxFromKey(Buffer.from(key))
          for (const row of await bootSourceRows(input.source, 'cached_repos'))
            if (
              typeof row.url_enc === 'string' &&
              row.url_enc &&
              !row.url_enc.startsWith(LEGACY_URL_ESCROW_PREFIX)
            )
              box.unseal(row.url_enc)
          identity = fallback ?? 'crewstation:source-secret'
        }
      }
      if (!key && input.root.kind === 'app-home' && !hostedKey)
        key = await createKeyForLegacyUrls(input, path, warn)
      if (!key) return null
      return {
        identity,
        fingerprint: `sha256:${sha256Hex(key)}`,
        box: createSecretBoxFromKey(Buffer.from(key)),
      }
    },
  }
}
