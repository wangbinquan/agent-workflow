// RFC-345 T9 — compatibility barrels may expose only symbols with a real
// external consumer. These ACL helpers remain module-internal; restoring any
// re-export would recreate public/facade debt without an owning use case.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('resource ACL compatibility barrels do not re-export consumer-zero symbols', () => {
  const sourceRoot = resolve(import.meta.dir, '../src')
  const publicOperations = readFileSync(
    resolve(sourceRoot, 'modules/resource-catalog/public/operations.ts'),
    'utf8',
  )
  const legacyFacade = readFileSync(resolve(sourceRoot, 'services/resourceAcl.ts'), 'utf8')

  for (const retiredSymbol of [
    'AclResourceIdentitySnapshot',
    'DEFAULT_USER_RESOURCE_VISIBILITY',
    'DisclosedRefs',
    'ResourceAclActorProjection',
    'ResourceAclAudienceAuthority',
    'canEditResourceInTx',
    'canGovernResource',
    'grantsOfUserWhere',
    'hasPrivateResourceAccess',
    'listResourceGrantsInTx',
    'listResourceGrantUserIds',
    'loadGrantLevelInTx',
    'loadGrantLevelsForUser',
    'resolveAccessFrom',
    'resolveResourceAccess',
    'requireResourceView',
  ]) {
    const exactSymbol = new RegExp(`\\b${retiredSymbol}\\b`)
    expect(exactSymbol.test(publicOperations)).toBe(false)
    expect(exactSymbol.test(legacyFacade)).toBe(false)
  }
})
