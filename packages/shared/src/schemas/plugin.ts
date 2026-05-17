// opencode plugin resource — DB-backed, referenced by agents via
// `frontmatter.plugins: [name1, name2, ...]`. See RFC-031.
//
// Each plugin record carries the user-authored `spec` (npm package, file URL,
// path, git URL, or github shorthand) plus the framework-managed install
// outputs `cachedPath` / `resolvedVersion` / `sourceKind`. The runner injects
// `file://<cachedPath>` (NOT the raw spec) into OPENCODE_CONFIG_CONTENT.plugin
// so spawn paths never hit the network.
//
// opencode `config.plugin` Spec union (verified against
// opencode/packages/opencode/src/config/plugin.ts:11-13) is
//   `string | [string, Record<string, unknown>]`.
// We store the spec as a single string in DB; the tuple form is only built at
// inject time when options are non-empty.

import { z } from 'zod'

/** Permitted characters in plugin name (URL-safe; matches `/api/plugins/:name`). */
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export const PluginNameSchema = z
  .string()
  .min(1, 'name is required')
  .max(64, 'name too long')
  .regex(PLUGIN_NAME_RE, 'name must start with [a-z0-9] and contain only [a-z0-9_-]')

/**
 * Raw spec string as the user typed it. Length cap mirrors the practical upper
 * bound of an npm specifier (incl. git URLs with embedded tokens). The Spec
 * tuple form `[spec, options]` from opencode is NOT accepted here — options
 * live in the dedicated `options` column.
 */
export const PluginSpecSchema = z.string().min(1, 'spec is required').max(512, 'spec too long')

/** Plain JSON-serialisable options bag, passed through to opencode plugin Spec tuple. */
export const PluginOptionsSchema = z.record(z.string(), z.unknown())

/**
 * Source kind, derived by the installer from `spec` (see services/pluginInstaller.ts):
 *   - npm  : standard npm specifier (`pkg@version`, scoped or otherwise)
 *   - file : starts with `file://`, `/`, `./`, `../`, or a Windows drive
 *   - git  : starts with `git+`, `github:`, `gitlab:`, or `bitbucket:`
 */
export const PluginSourceKindSchema = z.enum(['npm', 'file', 'git'])
export type PluginSourceKind = z.infer<typeof PluginSourceKindSchema>

/** Full plugin resource (response shape). */
export const PluginSchema = z.object({
  id: z.string(),
  name: PluginNameSchema,
  spec: PluginSpecSchema,
  options: PluginOptionsSchema,
  description: z.string(),
  enabled: z.boolean(),
  sourceKind: PluginSourceKindSchema,
  /**
   * Absolute filesystem path to the resolved plugin entry directory (npm/git)
   * or the user-supplied file path (file). Runner converts this to a
   * `file://...` URL before passing it to opencode at spawn time.
   */
  cachedPath: z.string().min(1),
  /**
   * For npm: `package.json` `version`. For git: short commit sha. For file:
   * mtime hash (informational only; not a semver). Nullable when install
   * partially succeeded but version could not be read.
   */
  resolvedVersion: z.string().nullable(),
  installedAt: z.number().int(),
  schemaVersion: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Plugin = z.infer<typeof PluginSchema>

/** POST /api/plugins body. Install happens synchronously inside the handler. */
export const CreatePluginSchema = z.object({
  name: PluginNameSchema,
  spec: PluginSpecSchema,
  options: PluginOptionsSchema.default({}),
  description: z.string().max(4096).default(''),
  enabled: z.boolean().default(true),
})
export type CreatePlugin = z.infer<typeof CreatePluginSchema>

/**
 * PUT /api/plugins/:id body. All fields optional; if `spec` changes the
 * installer re-runs to refresh cachedPath / resolvedVersion.
 */
export const UpdatePluginSchema = z
  .object({
    spec: PluginSpecSchema.optional(),
    options: PluginOptionsSchema.optional(),
    description: z.string().max(4096).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
export type UpdatePlugin = z.infer<typeof UpdatePluginSchema>

/** POST /api/plugins/:id/rename body. */
export const RenamePluginSchema = z.object({
  newName: PluginNameSchema,
})
export type RenamePlugin = z.infer<typeof RenamePluginSchema>

/** Response shape for POST /api/plugins/:id/check-update. */
export const PluginUpdateCheckSchema = z.object({
  available: z.boolean(),
  current: z.string().nullable(),
  latest: z.string().nullable(),
})
export type PluginUpdateCheck = z.infer<typeof PluginUpdateCheckSchema>
