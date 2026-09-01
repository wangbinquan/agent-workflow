// RFC-349 — compatibility facade over the provider-neutral memory query port.
import type { MemoryDistillQueries } from '@/modules/memory/public/queries'

export {
  parseDedupSnapshot,
  summarizeClarifyQuestions,
} from '@/modules/memory/application/distillQueries'

export async function getDistillJobDetail(queries: MemoryDistillQueries, jobId: string) {
  return await queries.getJobDetail(jobId)
}
