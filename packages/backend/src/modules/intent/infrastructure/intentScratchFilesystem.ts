// Compatibility names for the original local scratch adapter.
export type { IntentScratchStore as IntentScratchFilesystem } from '../application/ports/intentScratchStore'
export { createFileIntentScratchStore as createIntentScratchFilesystem } from './local/fileIntentScratchStore'
