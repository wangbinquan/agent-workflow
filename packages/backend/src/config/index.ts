// RFC-370 A-T2 — compatibility entrypoint. File configuration is a platform
// mechanism; keep one cache and one implementation for all existing callers.
export {
  applyConfigPatch,
  invalidateReadConfigCache,
  loadConfig,
  previewConfigPatch,
  readConfig,
  saveConfigRaw,
} from '@/platform/configuration/fileConfiguration'
