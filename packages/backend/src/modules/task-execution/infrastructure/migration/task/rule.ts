import {
  blockBootRow,
  bootRowArchive,
  recordBootUpgradeEffect,
  repositoryUrlFacts,
  resolveRepositoryUrlFact,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { TASK_FACTS, TASK_MOUNTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import { canonicalValue } from '@/platform/persistence/migration/conversion/migrationKey'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import type {
  JsonValue,
  SourceRow,
  TargetRef,
  TargetRow,
} from '@/platform/persistence/migration/conversion/types'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { redactSensitiveString } from '@/util/redact'
import {
  decodeRequestedSourceJson,
  encodeRequestedSource,
} from '../../../domain/requestedSourceCodec'
import { taskLaunchContext, taskLifecycle } from './alignment'
import { taskDefinition } from './definition'
import { recordTaskIssues, type TaskIssue } from './evidence'
import { TASK_LINEAGE } from './lineage'
import { TASK_ISOLATION, USER_IDS, WORKFLOW_BUILTIN } from './lookups'
import { taskSpaceNodes } from './spaceNodes'
import { deriveTaskSubjectFacts } from './subject'
import { nullableText, number, text } from './values'
import { workgroupState } from './workgroupState'
import { assignTaskRepositoryMounts } from './workspace'

export const taskConversionRule: ConversionRule = {
  ref: { id: 'task-execution/task', version: 4 },
  owner: 'task-execution',
  codecTakeovers: [{ table: 'tasks', columns: ['workgroup_config_json', 'name'] }],
  claims: ['tasks', 'task_repos', 'task_space_nodes', 'workgroup_task_state'],
  produces: [
    { table: 'tasks' },
    { table: 'task_definitions' },
    { table: 'task_launch_contexts' },
    { table: 'task_workspaces' },
    { table: 'task_repository_mounts' },
    { table: 'task_space_nodes' },
    { table: 'workgroup_task_state' },
    { table: 'execution_legacy_evidence', partition: 'task|task-repo' },
  ],
  lookups: [
    TASK_FACTS,
    TASK_MOUNTS,
    TASK_LINEAGE,
    USER_IDS,
    WORKFLOW_BUILTIN,
    TASK_ISOLATION,
    repositoryUrlFacts,
  ],
  unit: {
    kind: 'group',
    driver: 'tasks',
    groupColumn: 'id',
    groupsPerUnit: 1,
    members: [
      { table: 'task_repos', column: 'task_id' },
      { table: 'task_space_nodes', column: 'task_id' },
      { table: 'workgroup_task_state', column: 'task_id' },
    ],
  },
  convert(unit, ctx) {
    for (const task of unit.rows.get('tasks') ?? []) {
      const taskId = text(task, 'id')
      const members = (table: string): readonly SourceRow[] =>
        (unit.rows.get(table) ?? []).filter((row) => row.values.task_id === taskId)
      const repos = members('task_repos')
      const nodes = members('task_space_nodes')
      const state = members('workgroup_task_state')[0]
      const facts = ctx.lookup(TASK_FACTS).require(taskId)
      const lineage = ctx.lookup(TASK_LINEAGE).require(taskId)
      const subject = deriveTaskSubjectFacts(
        task,
        ctx.lookup(WORKFLOW_BUILTIN).get(text(task, 'workflow_id'))?.builtin === true,
        state,
      )
      const definition = taskDefinition(task, subject)
      const workspace = assignTaskRepositoryMounts(
        task,
        repos,
        facts,
        ctx.ids,
        ctx.lookup(TASK_ISOLATION).get(taskId),
      )
      const urls = ctx.lookup(repositoryUrlFacts)
      const taskUrl = resolveRepositoryUrlFact(
        urls,
        nullableText(task, 'repo_url'),
        nullableText(task, 'cached_repo_id'),
      )
      const mountUrls = workspace.mounts.map((mount) => ({
        mount,
        fact: resolveRepositoryUrlFact(
          urls,
          typeof mount.repo_url === 'string' ? mount.repo_url : null,
          typeof mount.cached_repo_id === 'string' ? mount.cached_repo_id : null,
        ),
      }))
      let urlBlocked = false
      for (const { origin, fact } of [
        { origin: task, fact: taskUrl },
        ...mountUrls.map(({ mount, fact }) => ({
          origin: repos.find((repo) => repo.values.repo_index === mount.ordinal) ?? task,
          fact,
        })),
      ])
        if (fact.state === 'blocked') {
          blockBootRow(
            ctx,
            taskConversionRule.ref,
            origin,
            fact.reason ?? 'v2-boot-url-unproven',
            { taskId },
            fact.factIds,
          )
          urlBlocked = true
        }
      if (urlBlocked) continue
      const source = decodeRequestedSourceJson(workspace.workspace.requested_source)
      const convertedWorkspace = {
        ...workspace.workspace,
        requested_source: encodeRequestedSource({
          ...source,
          repoUrl: taskUrl.repoUrl,
          cachedRepoId: taskUrl.cachedRepoId,
        }),
      }
      const convertedMounts = mountUrls.map<TargetRow>(({ mount, fact }) => ({
        ...mount,
        repo_url: fact.repoUrl,
        cached_repo_id: fact.cachedRepoId,
        submodule_init_error:
          typeof mount.submodule_init_error === 'string'
            ? redactSensitiveString(mount.submodule_init_error)
            : (mount.submodule_init_error ?? null),
      }))
      const mountFacts = ctx.lookup(TASK_MOUNTS).require(taskId)
      if (
        JSON.stringify(mountFacts.mounts.map((mount) => mount.repoKey)) !==
        JSON.stringify(workspace.mounts.map((mount) => mount.repo_key))
      )
        throw new Error(`v2-task-mount-lookup-drift:${taskId}`)
      const issues: TaskIssue[] = []
      const codecColumns = task.codecTakeovers?.map((failure) => failure.column) ?? []
      if (codecColumns.includes('workgroup_config_json'))
        issues.push({
          code: 'v2-task-config-undecodable',
          missingFields: ['workgroup_config_json'],
          detail: { retainedIn: 'execution_legacy_evidence' },
        })
      if (codecColumns.includes('name') && task.values.name !== null)
        issues.push({
          code: 'v2-task-name-undecodable',
          missingFields: ['name'],
          detail: { retainedIn: 'execution_legacy_evidence' },
        })
      if (subject.mismatch)
        issues.push({
          code: 'v2-task-subject-mismatch',
          missingFields: ['subject_kind'],
          detail: { workflowId: text(task, 'workflow_id'), derivedKind: subject.subject.kind },
        })
      if (definition.missingFields.length)
        issues.push({
          code: 'v2-task-definition-incomplete',
          missingFields: definition.missingFields,
          detail: { subjectKind: subject.subject.kind },
        })
      if (lineage.missingFields.length)
        issues.push({
          code: 'v2-task-lineage-unresolved',
          missingFields: lineage.missingFields,
          detail: { parentTaskId: facts.parentTaskId },
        })
      if (
        lineage.parentLaunchOrigin !== null &&
        lineage.launchOrigin !== lineage.parentLaunchOrigin
      )
        issues.push({
          code: 'v2-task-launch-origin-mismatch',
          missingFields: ['launch_origin'],
          detail: { parent: lineage.parentLaunchOrigin, child: lineage.launchOrigin },
        })
      const owner = nullableText(task, 'owner_user_id')
      if (owner !== null && !ctx.lookup(USER_IDS).get(owner))
        issues.push({
          code: 'v2-task-owner-dangling',
          missingFields: ['owner_user_id'],
          detail: { ownerUserId: owner },
          alwaysBlock: true,
        })
      for (const decision of workspace.decisions)
        if (decision.scenario === 'unexplained-conflict')
          issues.push({
            code: decision.code,
            repoOrdinal: decision.ordinal,
            missingFields: decision.fieldDiffs.map((diff) => diff.field),
            detail: {
              ordinal: decision.ordinal,
              fields: decision.fieldDiffs.map((diff) => ({
                field: diff.field,
                root: canonicalValue(diff.root),
                child: canonicalValue(diff.child),
              })),
            },
          })

      const lifecycle = taskLifecycle(task, ctx.target, workspace.rootRef)
      ctx.out.row('tasks', lifecycle, task)
      const taskTargets: TargetRef[] = [{ table: 'tasks', key: ctx.target.key('tasks', lifecycle) }]
      ctx.out.row('task_definitions', definition.row, task)
      ctx.out.row('task_launch_contexts', taskLaunchContext(task, lineage), task)
      ctx.out.row('task_workspaces', convertedWorkspace, task)
      const sourceChanged =
        taskUrl.repoUrl !== nullableText(task, 'repo_url') ||
        taskUrl.cachedRepoId !== nullableText(task, 'cached_repo_id')
      const workspaceTarget = {
        table: 'task_workspaces',
        key: ctx.target.key('task_workspaces', convertedWorkspace),
      }
      recordBootUpgradeEffect(ctx, taskConversionRule.ref, task, {
        disposition: sourceChanged ? 'transformed' : 'copied',
        targets: [workspaceTarget],
        before: {
          cachedRepoId: nullableText(task, 'cached_repo_id'),
          rawUrlDigest: taskUrl.rawUrlDigest,
        },
        after: { cachedRepoId: taskUrl.cachedRepoId, repoUrl: taskUrl.repoUrl },
        reason: sourceChanged
          ? 'v2-task-repository-url-converged'
          : 'v2-task-repository-url-unchanged',
        factIds: taskUrl.factIds,
      })
      if (sourceChanged)
        ctx.out.exception({
          sourceTable: task.table,
          sourceKey: task.encodedKey,
          class: 'converted',
          kind: 'conflict-resolved',
          targets: [workspaceTarget],
          archive: bootRowArchive(ctx, task),
          decision: { code: 'v2-task-repository-url-converged', detail: { taskId } },
        })

      for (const mount of convertedMounts) {
        const origin = repos.find((row) => row.values.repo_index === mount.ordinal) ?? task
        ctx.out.row('task_repository_mounts', mount, origin)
        const target = {
          table: 'task_repository_mounts',
          key: ctx.target.key('task_repository_mounts', mount),
        }
        taskTargets.push(target)
        const fact = mountUrls.find((entry) => entry.mount.repo_key === mount.repo_key)!.fact
        const changed =
          mount.repo_url !== origin.values.repo_url ||
          mount.cached_repo_id !== origin.values.cached_repo_id ||
          mount.submodule_init_error !== origin.values.submodule_init_error
        recordBootUpgradeEffect(ctx, taskConversionRule.ref, origin, {
          disposition: changed ? 'transformed' : 'copied',
          targets: [target],
          before: {
            cachedRepoId: nullableText(origin, 'cached_repo_id'),
            rawUrlDigest: fact.rawUrlDigest,
          },
          after: { cachedRepoId: fact.cachedRepoId, repoUrl: fact.repoUrl },
          reason: changed ? 'v2-task-mount-url-converged' : 'v2-task-mount-url-unchanged',
          factIds: fact.factIds,
        })
        if (changed)
          ctx.out.exception({
            sourceTable: origin.table,
            sourceKey: origin.encodedKey,
            class: 'converted',
            kind: 'conflict-resolved',
            targets: [target],
            archive: bootRowArchive(ctx, origin),
            decision: {
              code: 'v2-task-mount-url-converged',
              detail: { taskId, ordinal: Number(mount.ordinal) },
            },
          })

        ctx.out.exception({
          sourceTable: origin.table,
          sourceKey: origin.encodedKey,
          class: 'converted',
          kind: 'derived-id',
          targets: [target],
          archive: null,
          decision: {
            code: 'v2-task-repo-key',
            detail: { ordinal: mount.ordinal as number, sourceVersion: ctx.sourceVersion },
          },
        })
      }
      if (repos.length)
        ctx.out.exception({
          sourceTable: task.table,
          sourceKey: task.encodedKey,
          class: 'converted',
          kind: 'merged',
          targets: taskTargets,
          archive: null,
          decision: {
            code: 'v2-task-mount-merge',
            detail: {
              sourceVersion: ctx.sourceVersion,
              decisions: workspace.decisions as unknown as JsonValue,
            },
          },
        })
      for (const node of taskSpaceNodes(taskId, workspace.mounts, nodes))
        ctx.out.row('task_space_nodes', node.row, node.origin)
      const runtime = workgroupState(task, state, facts)
      if (runtime) {
        ctx.out.row('workgroup_task_state', runtime.row, state ?? null)
        if (runtime.synthesized)
          ctx.out.record({
            kind: 'decision',
            code: 'v2-task-workgroup-state-synthesized',
            payload: { taskId, updatedAt: facts.startedAt, basis: 'engine-default-row' },
          })
      }
      const derived =
        lineage.derived ||
        task.values.name === null ||
        task.values.name === '' ||
        workspace.decisions.some((decision) => decision.scenario === 'legacy-root-only') ||
        runtime?.synthesized
      ctx.out.evidence({
        origin: task,
        taskId,
        recordKind: 'task',
        recordId: taskId,
        quality: issues.length ? 'unknown' : derived ? 'legacy-derived' : 'recorded',
        missingFields: [...new Set(issues.flatMap((issue) => issue.missingFields))],
        detail: {
          sourceVersion: ctx.sourceVersion,
          sourceColumns: ctx.preflight
            .contract!.tables.find((table) => table.id === task.table)!
            .columns.map((column) => column.name),
          codecTakeovers: JSON.parse(canonicalSchemaJson(task.codecTakeovers ?? [])) as JsonValue,
          lineageDerived: lineage.derived,
          nameDerived: task.values.name === null || task.values.name === '',
          requestedRefProvenance: 'resolved-base-branch',
          mountDecisions: workspace.decisions as unknown as JsonValue,
          workgroupState: (state?.values as JsonValue) ?? null,
        },
      })
      if (codecColumns.length && !issues.length)
        ctx.out.exception({
          sourceTable: task.table,
          sourceKey: task.encodedKey,
          class: 'converted',
          kind: 'conflict-resolved',
          targets: taskTargets,
          archive: null,
          codecColumns,
          decision: {
            code: 'v2-task-codec-takeover',
            detail: { name: 'NULL uses task- plus last ten Unicode characters' },
          },
        })
      recordTaskIssues(task, facts, issues, taskTargets, ctx)
      for (const repo of repos) {
        const ordinal = number(repo, 'repo_index')
        const decisions = workspace.decisions.filter((decision) => decision.ordinal === ordinal)
        const repoIssues = issues.filter((issue) =>
          decisions.some(
            (decision) =>
              decision.scenario === 'unexplained-conflict' &&
              decision.code === issue.code &&
              issue.repoOrdinal === ordinal,
          ),
        )
        ctx.out.evidence({
          origin: repo,
          taskId,
          recordKind: 'task-repo',
          recordId: repo.encodedKey,
          quality: repoIssues.length ? 'unknown' : 'recorded',
          missingFields: [...new Set(repoIssues.flatMap((issue) => issue.missingFields))],
          detail: {
            sourceColumns: ctx.preflight
              .contract!.tables.find((table) => table.id === repo.table)!
              .columns.map((column) => column.name),
            decisions: decisions as unknown as JsonValue,
          },
        })
        recordTaskIssues(
          repo,
          facts,
          repoIssues,
          taskTargets.filter((ref) => ref.table === 'task_repository_mounts'),
          ctx,
        )
      }
    }
  },
}
