import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  ResourcePackageOwnedResourceLookupPort,
  ResourcePackageReadPort,
  ResourcePackageSkillTree,
} from '../application/package/ports'
import {
  createResourcePackageOwnedResourceLookup,
  createResourcePackageReadPort,
} from '../infrastructure/packageResourceRows'
import { readPackageSkillTree } from '../infrastructure/packageSkillTree'

/** Read capabilities consumed by the external package execution owner. */
export interface ResourcePackageProviderComposition {
  readonly resources: ResourcePackageOwnedResourceLookupPort
  readonly reads: ResourcePackageReadPort
  readonly readSkillTree: (skillId: string) => Promise<ResourcePackageSkillTree>
}

/** Both mutation-session mechanisms share these exact readers and app-home
 * binding. Provider-specific artifact and transaction owners are added outside. */
export function composeResourcePackageProvider(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
}): ResourcePackageProviderComposition {
  return Object.freeze({
    resources: createResourcePackageOwnedResourceLookup(input.db),
    reads: createResourcePackageReadPort(input.db),
    readSkillTree: (skillId: string) => readPackageSkillTree(input.db, input.appHome, skillId),
  })
}
