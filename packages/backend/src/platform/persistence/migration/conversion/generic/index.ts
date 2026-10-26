import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import { genericCopyTables } from './tables'
import { preservedRule } from './preserved'
import { referenceLookups } from './references'
import { identityMaxima } from './identityHighWater'
import { activeClaimValidators } from './validators'
import { sourceTableRules } from './sourceTables'
import { seedPresence } from './seedPresence'

export const conversion: ConversionContribution = {
  rules: genericCopyTables.map(preservedRule),
  lookups: [...referenceLookups, identityMaxima, seedPresence],
  validators: activeClaimValidators,
  forSource: sourceTableRules,
}
