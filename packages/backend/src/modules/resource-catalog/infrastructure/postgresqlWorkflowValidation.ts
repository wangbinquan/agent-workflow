import {
  collectWorkflowCallRefs,
  collectWorkgroupCallRefs,
  migrateWorkflowDefinitionToLatest,
  WorkflowDefinitionSchema,
  type Skill,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { inArray } from 'drizzle-orm'
import { agents, mcps, plugins, skills, workflows, workgroups } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ValidationError } from '@/util/errors'
import type { ResourceAuthorizationApplication } from '../application/resourceAuthorization'
import type {
  WorkflowReferenceAdmissionPort,
  WorkflowValidationPort,
} from '../application/workflows/ports'
import { agentFromPersistenceRow } from './agentPersistence'
import { mcpFromPersistenceRow } from './mcpPersistence'
import { pluginFromPersistenceRow } from './pluginPersistence'
import type { PostgresqlSkillContentLifecycle } from './postgresqlSkillRepository'
import { skillFromPersistenceRow } from './skillPersistence'
import {
  validateWorkflowDefinition,
  workflowDefinitionCandidateHashOf,
  workflowValidationContextHashOf,
  type ValidatorContext,
  type ValidatorWorkflowRef,
} from './legacy/workflow.validator'

interface WorkflowSelector {
  readonly name: string
  readonly id?: string
}

function selectorOf(reference: {
  readonly workflowName: string
  readonly workflowId?: string
}): WorkflowSelector {
  return Object.freeze({
    name: reference.workflowName,
    ...(reference.workflowId === undefined ? {} : { id: reference.workflowId }),
  })
}

function selectorKey(selector: WorkflowSelector): string {
  return `${selector.id ?? ''}#${selector.name}`
}

function workflowClosure(
  definition: WorkflowDefinition,
  inventory: readonly ValidatorWorkflowRef[],
): ReadonlyMap<string, ValidatorWorkflowRef> {
  const byId = new Map(inventory.map((workflow) => [workflow.id, workflow]))
  const byName = new Map<string, ValidatorWorkflowRef>()
  for (const workflow of [...inventory].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!byName.has(workflow.name)) byName.set(workflow.name, workflow)
  }

  const selectedById = new Map<string, ValidatorWorkflowRef>()
  const selectedByName = new Map<string, ValidatorWorkflowRef>()
  const seen = new Set<string>()
  const queue = collectWorkflowCallRefs(definition).map(selectorOf)
  while (queue.length > 0) {
    const selector = queue.shift()
    if (selector === undefined || seen.has(selectorKey(selector))) continue
    seen.add(selectorKey(selector))
    const hinted = selector.id === undefined ? undefined : byId.get(selector.id)
    const selected = hinted?.name === selector.name ? hinted : byName.get(selector.name)
    if (selected === undefined) continue
    selectedById.set(selected.id, selected)
    if (!selectedByName.has(selector.name)) selectedByName.set(selector.name, selected)
    queue.push(...collectWorkflowCallRefs(selected.definition).map(selectorOf))
  }

  const closure = new Map<string, ValidatorWorkflowRef>(selectedById)
  for (const [name, workflow] of selectedByName) closure.set(name, workflow)
  return closure
}

export function createPostgresqlWorkflowValidationPort(input: {
  readonly db: PostgresqlDatabaseClient
  readonly skillContent: Pick<PostgresqlSkillContentLifecycle, 'isAvailable'>
}): WorkflowValidationPort {
  const port: WorkflowValidationPort = {
    candidateHash: workflowDefinitionCandidateHashOf,
    async validate(candidate) {
      const [agentRows, skillRows, mcpRows, pluginRows, workflowRows, workgroupRows] =
        await Promise.all([
          input.db.select().from(agents).all(),
          input.db.select().from(skills).all(),
          input.db.select().from(mcps).all(),
          input.db.select().from(plugins).all(),
          input.db.select().from(workflows).all(),
          input.db.select({ name: workgroups.name }).from(workgroups).all(),
        ])
      const availableSkills: Skill[] = []
      for (const row of skillRows) {
        if (row.reservationState !== 'ready') continue
        const skill = skillFromPersistenceRow(row)
        if (await input.skillContent.isAvailable(skill)) availableSkills.push(skill)
      }
      const workflowInventory: ValidatorWorkflowRef[] = workflowRows.flatMap((row) => {
        try {
          const parsed = WorkflowDefinitionSchema.safeParse(JSON.parse(row.definition))
          return parsed.success
            ? [
                {
                  id: row.id,
                  name: row.name,
                  definition: migrateWorkflowDefinitionToLatest(parsed.data),
                },
              ]
            : []
        } catch {
          return []
        }
      })
      const referencedWorkgroups = new Set(
        collectWorkgroupCallRefs(candidate.definition).map((reference) => reference.workgroupName),
      )
      const context: ValidatorContext = {
        agents: agentRows.map(agentFromPersistenceRow),
        skills: availableSkills,
        mcps: mcpRows.map(mcpFromPersistenceRow),
        plugins: pluginRows.map(pluginFromPersistenceRow),
        callWorkflows: workflowClosure(candidate.definition, workflowInventory),
        callWorkgroupNames: new Set(
          workgroupRows.map((row) => row.name).filter((name) => referencedWorkgroups.has(name)),
        ),
        currentWorkflow: candidate.currentWorkflow,
      }
      return Object.freeze({
        validationContextHash: workflowValidationContextHashOf(context),
        result: validateWorkflowDefinition(candidate.definition, context),
      })
    },
  }
  return Object.freeze(port)
}

interface AdmissionRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

async function loadAdmissionRows(
  db: PostgresqlDatabaseClient,
  resourceType: 'agent' | 'workflow' | 'workgroup',
  domain: 'id' | 'name',
  references: readonly string[],
): Promise<readonly AdmissionRow[]> {
  if (references.length === 0) return []
  const selected = [...new Set(references)]
  switch (resourceType) {
    case 'agent':
      return db
        .select({
          id: agents.id,
          name: agents.name,
          ownerUserId: agents.ownerUserId,
          visibility: agents.visibility,
        })
        .from(agents)
        .where(inArray(domain === 'id' ? agents.id : agents.name, selected))
        .all()
    case 'workflow':
      return db
        .select({
          id: workflows.id,
          name: workflows.name,
          ownerUserId: workflows.ownerUserId,
          visibility: workflows.visibility,
        })
        .from(workflows)
        .where(inArray(domain === 'id' ? workflows.id : workflows.name, selected))
        .all()
    case 'workgroup':
      return db
        .select({
          id: workgroups.id,
          name: workgroups.name,
          ownerUserId: workgroups.ownerUserId,
          visibility: workgroups.visibility,
        })
        .from(workgroups)
        .where(inArray(domain === 'id' ? workgroups.id : workgroups.name, selected))
        .all()
  }
}

export function createPostgresqlWorkflowReferenceAdmissionPort(input: {
  readonly db: PostgresqlDatabaseClient
  readonly authorization: ResourceAuthorizationApplication
}): WorkflowReferenceAdmissionPort {
  const port: WorkflowReferenceAdmissionPort = {
    async assertUsable(authority, groups) {
      const missing: Array<{ type: string; name: string }> = []
      for (const group of groups) {
        const references = [...new Set(group.references)].filter(
          (reference) => reference.length > 0,
        )
        const rows = await loadAdmissionRows(input.db, group.resourceType, group.domain, references)
        if (group.domain === 'id') {
          const byId = new Map(rows.map((row) => [row.id, row]))
          for (const reference of references) {
            const row = byId.get(reference)
            if (
              row !== undefined &&
              !(await input.authorization.canViewResource(authority, group.resourceType, row))
            ) {
              missing.push({ type: group.resourceType, name: reference })
            }
          }
          continue
        }
        const byName = new Map<string, AdmissionRow[]>()
        for (const row of rows) {
          const bucket = byName.get(row.name) ?? []
          bucket.push(row)
          byName.set(row.name, bucket)
        }
        for (const reference of references) {
          const matches = byName.get(reference)
          if (matches === undefined) continue
          let visible = false
          for (const row of matches) {
            if (await input.authorization.canViewResource(authority, group.resourceType, row)) {
              visible = true
              break
            }
          }
          if (!visible) missing.push({ type: group.resourceType, name: reference })
        }
      }
      if (missing.length > 0) {
        throw new ValidationError(
          'acl-missing-refs',
          `you do not have access to: ${missing.map((entry) => `${entry.type} '${entry.name}'`).join(', ')}`,
          { missing },
        )
      }
    },
  }
  return Object.freeze(port)
}
