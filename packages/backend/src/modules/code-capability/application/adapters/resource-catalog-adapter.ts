import type { CapabilityTemplatePackageMutationOwner } from '@/modules/resource-catalog/composition/required-ports'

// RFC-609: the capability templates' PostgreSQL owner-native arm takes Resource Catalog's owner contract from this designated
// adapter only (a required-implementation edge, type-only through `composition/required-ports`).
export type { CapabilityTemplatePackageMutationOwner }
