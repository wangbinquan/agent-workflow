// RFC-276 — natural OpenCode model enumeration.

import type { ListModelsOpts, RuntimeModelList } from '../types'
import { listOpencodeModels } from '@/util/opencode-models'

export async function listOpencodeModelsNatural(
  binary: string,
  opts: ListModelsOpts = {},
): Promise<RuntimeModelList> {
  return listOpencodeModels(binary, {
    refresh: opts.refresh === true,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    cwd: opts.cwd ?? process.cwd(),
    env:
      opts.env ??
      Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        }),
      ),
  })
}
