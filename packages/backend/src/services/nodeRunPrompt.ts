// RFC-311 / RFC-370: existing synchronous native entry points retain their shape.
// Deployment consumers receive complete async operations through composition.
export { nodeRunPromptRelPath, storeNodeRunPrompt } from '@/modules/task-execution/public/commands'
export { readNodeRunPrompt } from '@/modules/task-execution/public/queries'
export type { PromptStorage } from '@/modules/task-execution/public/types'
