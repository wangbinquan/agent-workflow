// RFC-345 compatibility composition for the legacy Intent readers.
//
// The resource-catalog infrastructure owns SQL and paging. Legacy services own
// their row decoders and revision codecs until their aggregate cohorts move;
// this exact provider keeps that dependency pointing into the module instead
// of letting module infrastructure import legacy services in reverse.

import { rowToMcp } from '@/services/mcp'
import { mcpOperationConfigHashOf } from '@/services/mcpOperationRevision'
import { rowToPlugin } from '@/services/plugin'
import { pluginOperationConfigHashOf } from '@/services/pluginOperationRevision'
import { encodeSkillToken } from '@/services/skillToken'
import type { SqliteResourceCatalogProjectionDependencies } from '@/modules/resource-catalog/public/operations'

export const resourceCatalogProjections = Object.freeze({
  encodeSkillToken,
  mcpFromRow: rowToMcp,
  mcpOperationConfigHashOf,
  pluginFromRow: rowToPlugin,
  pluginOperationConfigHashOf,
} satisfies SqliteResourceCatalogProjectionDependencies)
