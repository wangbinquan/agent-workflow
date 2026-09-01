import type { MemoryDistillCommands } from './commands'

/** Closed participant used by clarify/review/feedback contexts after commit. */
export type MemoryDistillEnqueuer = Pick<MemoryDistillCommands, 'enqueue'>
