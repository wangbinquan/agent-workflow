// RFC-389 — side-effect-free entry paths; safe to import from the main thread.
declare const AW_COMPILED_BUILD: boolean | undefined

// In source execution an absolute file URL is reliable. In a standalone Bun
// executable the Worker remains a separately bundled entry and MUST be opened
// by its relative entry name: resolving it through new URL(...).href produces
// an absolute /$bunfs/root URL that Bun 1.3 cannot map back to that entry. Keep
// both forms explicit; otherwise every release binary degrades with
// ModuleNotFound even though source-level Worker tests pass.
export const MAINTENANCE_WORKER_ENTRY =
  typeof AW_COMPILED_BUILD === 'boolean' && AW_COMPILED_BUILD
    ? './bootstrap/maintenanceWorker.ts'
    : new URL('./maintenanceWorker.ts', import.meta.url).href
