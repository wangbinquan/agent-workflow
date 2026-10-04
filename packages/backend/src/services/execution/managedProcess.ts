// RFC-370: preserve the original native managed-process API for existing consumers.
export {
  FINAL_REAP_MARGIN_MS,
  MANAGED_PROCESS_MAX_LINE_CHARS,
  MANAGED_PROCESS_MAX_STREAM_CHARS,
  pump,
  runManagedProcess,
  type ManagedProcessOutcome,
  type ManagedProcessRequest,
  type ManagedProcessResult,
} from '@/platform/execution/local/managedProcess'
