// RFC-310 PR-4 —— attempt 编排的内存 fake 端口组（应用级测试用）。
//
// PR-3 时代的测试只需一个 fake launcher 就能拿到 'action-launched'；PR-4 的
// launch 半是完整编排（baseline/workspace/manifest/template/pre-state），端口
// 任一缺席都是 typed block。本 helper 提供全套结构化 fake，让「政策链走到
// 动作发射」类测试继续以最小噪声表达意图；真实文件系统/子进程面归
// rfc310-pr4-* 专项测试与 journey。

import type { DbClient } from '../../src/db/client'
import type {
  ReconcilerPorts,
  WorkspaceValidationPort,
} from '../../src/modules/development-automation/application/ports/reconcilerPorts'
import { createSqliteActionTemplateStore } from '../../src/modules/development-automation/infrastructure/sqliteConfigResourceStore'

export interface FakeAgentPortsOptions {
  readonly db: DbClient
  readonly launches?: string[]
  readonly overrides?: Partial<ReconcilerPorts>
}

export function fakeAgentActionPorts(
  options: FakeAgentPortsOptions,
): Partial<ReconcilerPorts> & { workspaceValidation: WorkspaceValidationPort } {
  const templates = createSqliteActionTemplateStore(options.db)
  const contexts = new Map<string, string>()
  let contextSeq = 0
  const base = {
    agentLauncher: {
      async launch(input: { readonly capabilityId: string }) {
        options.launches?.push(input.capabilityId)
        return { ok: true as const, executionRef: `exec-${options.launches?.length ?? 1}` }
      },
      async fetchOutcome(executionRef: string) {
        return { kind: 'pending' as const, executionRef, taskStatus: 'running' }
      },
      async cancel() {
        return { settled: 'already-terminal' as const }
      },
    },
    actionBaseline: {
      async resolve() {
        return { repoPath: '/fake/baseline-repo', headSha: 'a'.repeat(40) }
      },
    },
    actionWorkspace: {
      async materialize() {
        return { workspacePath: '/fake/action-ws', businessTreeDigest: 'b'.repeat(64) }
      },
      discard() {},
    },
    attemptContext: {
      async save(json: string) {
        contextSeq += 1
        const ref = `ctx-${contextSeq}`
        contexts.set(ref, json)
        return ref
      },
      load(ref: string) {
        return contexts.get(ref) ?? null
      },
    },
    actionTemplates: {
      content(id: string, revision: number) {
        const row = templates.getRevision(id, revision)
        return row === null ? null : (JSON.parse(row.contentJson) as unknown)
      },
    },
    workspaceValidation: {
      capturePreState() {
        return '{}'
      },
      validate(input: { readonly outcome: string }) {
        return input.outcome === 'changed'
          ? { ok: true as const, kind: 'changed' as const, changedPaths: ['src/fake.ts'] }
          : { ok: true as const, kind: 'clean' as const }
      },
    },
    changeCandidate: {
      async derive() {
        return {
          ok: true as const,
          receipt: { candidateRef: 'c'.repeat(64), treeOid: 't'.repeat(40) },
        }
      },
    },
  }
  return { ...base, ...(options.overrides ?? {}) } as ReturnType<typeof fakeAgentActionPorts>
}
