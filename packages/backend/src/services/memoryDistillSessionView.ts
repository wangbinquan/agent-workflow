// RFC-349 — compatibility facade over the provider-neutral memory query port.
import type { MemoryDistillQueries } from '@/modules/memory/public/queries'

export { DISTILLER_PRIMARY_AGENT_NAME } from '@/modules/memory/application/distillQueries'

export async function getDistillJobSessionView(queries: MemoryDistillQueries, jobId: string) {
  return await queries.getJobSessionView(jobId)
}
