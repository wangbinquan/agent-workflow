// GET    /api/tasks                       list (filters via query)
// POST   /api/tasks                       start task; scheduler kicks off in background
// GET    /api/tasks/:id                    full task incl. workflowSnapshot + inputs
// POST   /api/tasks/:id/cancel             abort in-flight task
// GET    /api/tasks/:id/node-runs          per-node run rows + captured outputs
// GET    /api/tasks/:id/diff               cumulative git diff in the worktree
//
// Resume / single-node retry land in M3 (P-3-08, P-3-09).

import {
  StartTaskSchema,
  TaskStatusSchema,
  UploadInputSchema,
  type WorkflowInput,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { loadConfig } from '@/config'
import type { AppDeps } from '@/server'
import {
  cancelTask,
  getNodeRunEvents,
  getNodeRunStdout,
  getTask,
  getTaskDiff,
  getTaskNodeRuns,
  listTasks,
  materializeWorktree,
  resumeTask,
  retryNode,
  startTask,
} from '@/services/task'
import {
  applyUploadsToWorktree,
  DEFAULT_UPLOAD_LIMITS,
  type UploadFile,
  type UploadInputDef,
  type UploadLimits,
} from '@/services/upload'
import { getSessionTree } from '@/services/sessionView'
import { getWorkflow } from '@/services/workflow'
import { Paths } from '@/util/paths'
import { NotFoundError, ValidationError } from '@/util/errors'

/**
 * Resolve the opencode subprocess command for the current config. When the
 * user sets `opencodePath` we pass it through to the runner so tasks spawn
 * the exact binary that was probed at daemon start. Without it, the runner
 * keeps falling back to a bare `['opencode']` PATH lookup.
 */
function resolveOpencodeCmd(configPath: string): string[] | undefined {
  try {
    const cfg = loadConfig(configPath)
    if (typeof cfg.opencodePath === 'string' && cfg.opencodePath.length > 0) {
      return [cfg.opencodePath]
    }
  } catch {
    // config unreadable — fall back to default PATH lookup
  }
  return undefined
}

export function mountTaskRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/tasks', async (c) => {
    const filters: Parameters<typeof listTasks>[1] = {}
    const status = c.req.query('status')
    if (status !== undefined) {
      const parsed = TaskStatusSchema.safeParse(status)
      if (!parsed.success) {
        throw new ValidationError('task-filter-invalid', `unknown status: ${status}`)
      }
      filters.status = parsed.data
    }
    const workflowId = c.req.query('workflow_id') ?? c.req.query('workflowId')
    if (workflowId !== undefined && workflowId !== '') filters.workflowId = workflowId
    const repoPath = c.req.query('repo_path') ?? c.req.query('repoPath')
    if (repoPath !== undefined && repoPath !== '') filters.repoPath = repoPath
    const limit = c.req.query('limit')
    if (limit !== undefined) {
      const n = Number(limit)
      if (!Number.isFinite(n) || n <= 0) {
        throw new ValidationError('task-filter-invalid', `limit must be a positive number`)
      }
      filters.limit = Math.min(n, 500)
    }
    return c.json(await listTasks(deps.db, filters))
  })

  app.get('/api/tasks/:id', async (c) => {
    const task = await getTask(deps.db, c.req.param('id'))
    if (task === null) {
      throw new NotFoundError('task-not-found', `task '${c.req.param('id')}' not found`)
    }
    return c.json(task)
  })

  app.post('/api/tasks', async (c) => {
    const ct = c.req.header('content-type') ?? ''
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)

    // RFC-020: multipart branch handles launcher uploads. payload field is
    // JSON-encoded StartTask; files[<inputKey>][] fields are the binary
    // contents bound to `kind: 'upload'` inputs.
    if (ct.toLowerCase().startsWith('multipart/form-data')) {
      const task = await handleMultipartTaskStart(c.req.raw, deps, opencodeCmd)
      return c.json(task, 201)
    }

    const parsed = StartTaskSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('task-invalid', 'invalid task payload', {
        issues: parsed.error.issues,
      })
    }
    const task = await startTask(parsed.data, {
      db: deps.db,
      ...(opencodeCmd ? { opencodeCmd } : {}),
    })
    return c.json(task, 201)
  })

  app.post('/api/tasks/:id/cancel', async (c) => {
    const task = await cancelTask(deps.db, c.req.param('id'))
    return c.json(task)
  })

  app.get('/api/tasks/:id/node-runs', async (c) => {
    return c.json(await getTaskNodeRuns(deps.db, c.req.param('id')))
  })

  app.get('/api/tasks/:id/diff', async (c) => {
    return c.json(await getTaskDiff(deps.db, c.req.param('id')))
  })

  app.post('/api/tasks/:id/resume', async (c) => {
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const task = await resumeTask(deps.db, c.req.param('id'), {
      db: deps.db,
      ...(opencodeCmd ? { opencodeCmd } : {}),
    })
    return c.json(task)
  })

  app.post('/api/tasks/:id/nodes/:nodeRunId/retry', async (c) => {
    const cascadeRaw = c.req.query('cascade')
    const cascade = cascadeRaw === undefined ? true : cascadeRaw !== 'false'
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const task = await retryNode(deps.db, c.req.param('id'), c.req.param('nodeRunId'), {
      cascade,
      deps: {
        db: deps.db,
        ...(opencodeCmd ? { opencodeCmd } : {}),
      },
    })
    return c.json(task)
  })

  app.get('/api/tasks/:id/nodes/:nodeRunId/stdout', async (c) => {
    const text = await getNodeRunStdout(deps.db, c.req.param('id'), c.req.param('nodeRunId'))
    return c.text(text)
  })

  app.get('/api/tasks/:id/node-runs/:nodeRunId/events', async (c) => {
    const sinceRaw = c.req.query('since')
    const limitRaw = c.req.query('limit')
    const opts: { since?: number; limit?: number } = {}
    if (sinceRaw !== undefined) {
      const n = Number(sinceRaw)
      if (!Number.isFinite(n) || n < 0) {
        throw new ValidationError('events-since-invalid', `since must be a non-negative number`)
      }
      opts.since = n
    }
    if (limitRaw !== undefined) {
      const n = Number(limitRaw)
      if (!Number.isFinite(n) || n <= 0) {
        throw new ValidationError('events-limit-invalid', `limit must be a positive number`)
      }
      opts.limit = n
    }
    return c.json(
      await getNodeRunEvents(deps.db, c.req.param('id'), c.req.param('nodeRunId'), opts),
    )
  })

  // RFC-027: Session-tree view consumed by the NodeDetailDrawer's
  // Session tab. Reads the persisted events for one node_run and
  // reassembles a normalized conversation tree (user / assistant text
  // / tool_use / subagent-call, with recursive children for any task
  // tool whose child sessionID was captured into node_run_events by
  // sessionCapture).
  app.get('/api/tasks/:id/node-runs/:nodeRunId/session', async (c) => {
    return c.json(await getSessionTree(deps.db, c.req.param('id'), c.req.param('nodeRunId')))
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

/**
 * RFC-020: read `uploadLimits` from settings, falling back to defaults. Kept
 * narrow so the multipart handler stays declarative.
 */
function resolveUploadLimits(configPath: string): UploadLimits {
  try {
    const cfg = loadConfig(configPath)
    const u = cfg.uploadLimits
    if (u !== undefined) {
      return {
        perFile: u.perFile,
        perRequest: u.perRequest,
        perCount: u.perCount,
      }
    }
  } catch {
    // unreadable config → defaults
  }
  return { ...DEFAULT_UPLOAD_LIMITS }
}

/**
 * Extract upload-kind input declarations from a workflow definition. Each
 * one must pass UploadInputSchema (strict-on-write) — anything that snuck
 * through the workflow save path with a bad targetDir is rejected here too.
 */
function collectUploadInputDefs(inputs: readonly WorkflowInput[]): Map<string, UploadInputDef> {
  const out = new Map<string, UploadInputDef>()
  for (const inp of inputs) {
    if (inp.kind !== 'upload') continue
    const parsed = UploadInputSchema.safeParse(inp)
    if (!parsed.success) {
      throw new ValidationError(
        'upload-input-invalid',
        `workflow input '${inp.key}' (kind=upload) is malformed`,
        { issues: parsed.error.issues },
      )
    }
    const def: UploadInputDef = {
      key: parsed.data.key,
      targetDir: parsed.data.targetDir,
    }
    if (parsed.data.accept !== undefined) def.accept = parsed.data.accept
    if (parsed.data.maxFileSize !== undefined) def.maxFileSize = parsed.data.maxFileSize
    if (parsed.data.minCount !== undefined) def.minCount = parsed.data.minCount
    if (parsed.data.maxCount !== undefined) def.maxCount = parsed.data.maxCount
    out.set(def.key, def)
  }
  return out
}

/** Match `files[<key>][]` field names; allowed keys mirror WorkflowInput.key. */
const UPLOAD_FIELD_RE = /^files\[([A-Za-z0-9_-]+)\]\[\]$/

async function handleMultipartTaskStart(
  req: Request,
  deps: AppDeps,
  opencodeCmd: string[] | undefined,
) {
  let form: Awaited<ReturnType<typeof req.formData>>
  try {
    form = await req.formData()
  } catch (err) {
    throw new ValidationError(
      'task-multipart-invalid',
      `failed to parse multipart body: ${(err as Error).message}`,
    )
  }

  // 1. Pull JSON payload out of the `payload` field.
  const payloadField = form.get('payload')
  if (payloadField === null) {
    throw new ValidationError(
      'task-multipart-payload-missing',
      'multipart body must include a "payload" field with the StartTask JSON',
    )
  }
  let payloadText: string
  if (typeof payloadField === 'string') {
    payloadText = payloadField
  } else {
    payloadText = await payloadField.text()
  }
  let payloadJson: unknown
  try {
    payloadJson = JSON.parse(payloadText)
  } catch (err) {
    throw new ValidationError(
      'task-multipart-payload-invalid',
      `payload field is not valid JSON: ${(err as Error).message}`,
    )
  }
  const parsed = StartTaskSchema.safeParse(payloadJson)
  if (!parsed.success) {
    throw new ValidationError('task-invalid', 'invalid task payload', {
      issues: parsed.error.issues,
    })
  }
  const startInput = parsed.data

  // 2. Resolve workflow → extract upload input declarations.
  const workflow = await getWorkflow(deps.db, startInput.workflowId)
  if (workflow === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${startInput.workflowId}' not found`)
  }
  const uploadDefs = collectUploadInputDefs(workflow.definition.inputs)

  // 3. Walk multipart fields, bind each file blob to its inputKey.
  const uploadFiles: UploadFile[] = []
  // Cast: bun's undici FormData type narrows to [string, string]; the real
  // value can be a File too — that's what we actually receive at runtime.
  const entries = form.entries() as unknown as Iterable<[string, string | File]>
  for (const [fieldName, value] of entries) {
    if (fieldName === 'payload') continue
    const m = UPLOAD_FIELD_RE.exec(fieldName)
    if (m === null) {
      throw new ValidationError(
        'task-multipart-unknown-field',
        `unexpected multipart field '${fieldName}'; expected 'payload' or 'files[<key>][]'`,
      )
    }
    const inputKey = m[1]!
    if (!uploadDefs.has(inputKey)) {
      throw new ValidationError(
        'task-multipart-unknown-input',
        `multipart files target unknown upload input '${inputKey}'`,
      )
    }
    if (typeof value === 'string') {
      throw new ValidationError(
        'task-multipart-string-not-file',
        `field '${fieldName}' must carry a file, got string`,
      )
    }
    const buf = new Uint8Array(await value.arrayBuffer())
    uploadFiles.push({
      inputKey,
      filename: value.name === '' ? 'upload.bin' : value.name,
      declaredMime: value.type,
      bytes: buf,
    })
  }

  // 4. Materialize the worktree first so we have a real path to write into.
  const appHome = Paths.root
  const taskId = ulid()
  // RFC-024 NOTE: multipart upload path currently requires path-mode launch
  // (URL-mode uploads would need to resolve the cache before this point).
  // Refuse URL+upload combos with a clear 422 instead of silently dropping.
  if (startInput.repoUrl) {
    throw new ValidationError(
      'multipart-upload-requires-path-mode',
      'multipart uploads currently require launching with a local repoPath; URL launches are JSON-only',
    )
  }
  const wt = await materializeWorktree({
    repoPath: startInput.repoPath as string,
    baseBranch: startInput.baseBranch,
    taskId,
    appHome,
  })
  if (wt.earlyError !== null) {
    // Fall back to the original behavior: create a failed task row so the
    // user sees the error. No files were written (worktree never existed).
    const task = await startTask(startInput, {
      db: deps.db,
      ...(opencodeCmd ? { opencodeCmd } : {}),
    })
    return task
  }

  // 5. Write uploads + pack paths back into inputs[].
  const limits = resolveUploadLimits(deps.configPath)
  try {
    const result = await applyUploadsToWorktree({
      worktreePath: wt.worktreePath,
      defs: uploadDefs,
      files: uploadFiles,
      limits,
    })
    const inputsOut: Record<string, string> = { ...startInput.inputs }
    for (const [key, paths] of result.packedByKey.entries()) {
      inputsOut[key] = paths.join('\n')
    }
    // 6. Hand off to startTask with the pre-created worktree.
    return await startTask(
      { ...startInput, inputs: inputsOut },
      {
        db: deps.db,
        ...(opencodeCmd ? { opencodeCmd } : {}),
        preCreatedWorktree: {
          taskId,
          worktreePath: wt.worktreePath,
          branch: wt.branch,
          baseCommit: wt.baseCommit,
        },
      },
    )
  } catch (err) {
    // Upload write failed (limits, accept, or fs error). Throw a structured
    // error; the worktree directory stays on disk but no task row is
    // created, matching the "createWorktree failed" semantics.
    if (err instanceof ValidationError) throw err
    throw new ValidationError(
      'task-upload-failed',
      `failed to land uploads into worktree: ${(err as Error).message}`,
    )
  }
}
