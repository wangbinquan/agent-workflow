import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from '@/util/hash'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import type { RepositoryUrlKeyProvider } from '@/modules/source-control/composition/conversion'
import { bootSourceRows } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
/** A backup carries its original key. Hosted sources use the platform's existing
 * source key. Neither probe path calls createSecretBox or writes a key file. */
export function epochMigrationKeys(
  hostedKey?: () => Uint8Array | null,
  installationRoot?: string,
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
              !row.url_enc.startsWith('aw-legacy-url-hex-v1:')
            )
              box.unseal(row.url_enc)
          identity = fallback ?? 'crewstation:source-secret'
        }
      }
      if (!key) return null
      return {
        identity,
        fingerprint: `sha256:${sha256Hex(key)}`,
        box: createSecretBoxFromKey(Buffer.from(key)),
      }
    },
  }
}
