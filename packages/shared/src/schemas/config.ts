// Global config schema (~/.agent-workflow/config.json).
// Mirrors design.md §11. Each field has a default; missing fields are
// backfilled by the backend on load.

import { z } from 'zod'

export const CONFIG_SCHEMA_VERSION = 1

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])
export const LanguageSchema = z.enum(['zh-CN', 'en-US'])
export const ThemeSchema = z.enum(['system', 'light', 'dark'])

export const WorktreeGcSchema = z.object({
  enabled: z.boolean(),
  olderThanDays: z.number().int().positive().optional(),
  onlyMerged: z.boolean().optional(),
})

export const EventsArchiveThresholdsSchema = z.object({
  perNodeRunRows: z.number().int().positive(),
  globalRows: z.number().int().positive(),
})

export const ConfigSchema = z.object({
  $schema_version: z.literal(CONFIG_SCHEMA_VERSION),

  // --- Runtime ---
  /** Override opencode binary path. Falls back to `which opencode` (PATH). */
  opencodePath: z.string().min(1).optional(),
  /** Default model for agents without an explicit model. */
  defaultModel: z.string().min(1).optional(),
  defaultVariant: z.string().min(1).optional(),
  defaultTemperature: z.number().min(0).max(2).optional(),
  /** Global semaphore capacity. design.md §11 default = 4. */
  maxConcurrentNodes: z.number().int().positive(),
  /** Independent sub-process pool capacity inside a multi-process node. */
  multiProcessSubprocessConcurrency: z.number().int().positive(),

  // --- Resource limits (defaults; workflow & launcher can override per task) ---
  defaultPerTaskMaxDurationMs: z.number().int().nonnegative(),
  defaultPerTaskMaxTotalTokens: z.number().int().nonnegative(),
  defaultPerNodeTimeoutMs: z.number().int().positive(),

  // --- GC ---
  worktreeAutoGc: WorktreeGcSchema,
  eventsArchiveThresholds: EventsArchiveThresholdsSchema,

  // --- Large outputs ---
  largeOutputThresholdBytes: z.number().int().positive(),

  // --- Network (requires restart to take effect) ---
  bindHost: z.string().min(1),
  bindPort: z.number().int().min(0).max(65535).optional(),

  // --- i18n / theme (frontend reads these) ---
  language: LanguageSchema,
  theme: ThemeSchema,

  // --- Logging ---
  logLevel: LogLevelSchema,
})

export type Config = z.infer<typeof ConfigSchema>

/** Default config — every field present, satisfies ConfigSchema. */
export const DEFAULT_CONFIG: Config = {
  $schema_version: CONFIG_SCHEMA_VERSION,
  maxConcurrentNodes: 4,
  multiProcessSubprocessConcurrency: 4,
  defaultPerTaskMaxDurationMs: 60 * 60 * 1000, // 1 hour
  defaultPerTaskMaxTotalTokens: 0, // 0 = unlimited
  defaultPerNodeTimeoutMs: 30 * 60 * 1000, // 30 min
  worktreeAutoGc: { enabled: false },
  eventsArchiveThresholds: {
    perNodeRunRows: 50_000,
    globalRows: 1_000_000,
  },
  largeOutputThresholdBytes: 1_048_576, // 1 MB
  bindHost: '127.0.0.1',
  language: 'zh-CN',
  theme: 'system',
  logLevel: 'info',
}

/**
 * Patch schema: any subset of the full config (except $schema_version),
 * sent by PUT /api/config and merged onto the current config.
 */
export const ConfigPatchSchema = ConfigSchema.partial().omit({ $schema_version: true })
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>
