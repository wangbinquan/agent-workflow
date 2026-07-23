import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import {
  analyzeIdentitySource,
  type IdentityGuardCategory,
  type IdentityGuardFinding,
} from './helpers/rfc223IdentityGuard'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SOURCE_ROOTS = [
  'packages/backend/src',
  'packages/shared/src',
  'packages/frontend/src',
] as const

const ALLOWANCE_REASONS = {
  'code-symbol':
    'Names identify source-code symbols inside structural-diff analysis, not resources.',
  'deterministic-order': 'Name is only the first deterministic display sort key; id breaks ties.',
  'display-diagnostic':
    'Canonical ids decide the result; names only render a missing-item diagnostic.',
  'display-fallback': 'Canonical ids drive navigation; names are optional display labels only.',
  'filesystem-name':
    'The key identifies a browser File or worktree entry, not a persisted resource.',
  'import-name-boundary':
    'Portable ZIP candidates are name-keyed until the selected stable id and owner/OCC token are committed.',
  'injection-validation':
    'This map detects duplicate external registry names after canonical-id hydration.',
  'legacy-path':
    'The name appears only in fail-closed recovery of a legacy pre-id filesystem path.',
  'occ-fence':
    'The stable id is authoritative; name is one field in a full-row optimistic concurrency fence.',
  'owner-uniqueness':
    'This is an explicit owner-scoped name-slot collision check, not resource resolution.',
  'port-or-protocol-name':
    'The name belongs to a workflow port/channel protocol namespace, not resource identity.',
  'portable-selector':
    'This is the explicit portable selector boundary that resolves name plus owner to a stable id.',
  'runtime-global':
    'Runtime names intentionally remain globally unique and name-addressed under RFC-223 section 9.',
  'runtime-protocol':
    'The external runtime registry is name-keyed after canonical-id hydration and duplicate-name rejection.',
  'schema-column':
    'The names are SQLite schema column labels used for restore compatibility checks.',
} as const

type AllowanceReasonCode = keyof typeof ALLOWANCE_REASONS

interface ExactAllowance {
  category: IdentityGuardCategory
  file: string
  functionName: string | null
  fingerprint: string
  excerpt: string
  count: number
  reason: string
}

// Static, reviewed multiset snapshot. Each row is:
// category, file, function, exact AST fingerprint, count, reason code, excerpt.
// `count` is part of the contract: copying the exact same allowed syntax in the
// same function produces an extra occurrence and fails the guard.
const EXACT_ALLOWANCE_ROWS = [
  'collection-name-identity\u001fpackages/backend/src/services/importRefs.ts\u001fbuildCandidateSnapshotsInTx\u001fNewExpression:375cd3c41fdf6552897b\u001f1\u001fportable-selector\u001fnew Set(typeSelectors.map((selector) => selector.name))',
  'collection-name-identity\u001fpackages/backend/src/services/restore.ts\u001fhasFusionProvenanceSchema\u001fNewExpression:33997c70d15e0d15c945\u001f1\u001fschema-column\u001fnew Set( ( raw.query("SELECT name FROM pragma_table_info(\'memories\')").all() as Array<{ name: string }> ).map((column) => column.name), )',
  'collection-name-identity\u001fpackages/backend/src/services/restore.ts\u001fhasFusionProvenanceSchema\u001fNewExpression:590ef4bb2acf4b8f66f6\u001f1\u001fschema-column\u001fnew Set( ( raw.query("SELECT name FROM pragma_table_info(\'fusions\')").all() as Array<{ name: string }> ).map((column) => column.name), )',
  'collection-name-identity\u001fpackages/backend/src/services/runner.ts\u001frunNode\u001fCallExpression:a542d65f2cd58c9d735b\u001f1\u001fruntime-protocol\u001fresolvedParamsByAgent.set(opts.agent.name, opts.runtimeParams ?? EMPTY_RUNTIME_PROFILE)',
  'collection-name-identity\u001fpackages/backend/src/services/runner.ts\u001frunNode\u001fCallExpression:c4fcc147e09c28523846\u001f1\u001fruntime-protocol\u001fresolvedParamsByAgent.has(dep.name)',
  'collection-name-identity\u001fpackages/backend/src/services/runner.ts\u001frunNode\u001fCallExpression:ed70f7ab8579a8b397af\u001f1\u001fruntime-protocol\u001fresolvedParamsByAgent.set(dep.name, { model: r.model, variant: r.variant, temperature: r.temperature, steps: r.steps, maxSteps: r.maxSteps, })',
  'collection-name-identity\u001fpackages/backend/src/services/runtime/claudeCode/driver.ts\u001fbuildBusinessSpawn\u001fCallExpression:d6aa73917b11a05318bb\u001f1\u001fruntime-protocol\u001fctx.resolvedParamsByAgent.get(ctx.agent.name)',
  'collection-name-identity\u001fpackages/backend/src/services/runtime/injectionIdentity.ts\u001ffirstConflict\u001fCallExpression:0e951b1e1d97a1b0dc0c\u001f1\u001fruntime-protocol\u001ffirstIdByName.set(row.name, row.id)',
  'collection-name-identity\u001fpackages/backend/src/services/runtime/injectionIdentity.ts\u001ffirstConflict\u001fCallExpression:70a6aca824745ed4770c\u001f1\u001fruntime-protocol\u001ffirstIdByName.get(row.name)',
  'collection-name-identity\u001fpackages/backend/src/services/runtime/opencode/inlineConfig.ts\u001fbuildInlineConfig\u001fCallExpression:2298356755d45d318dac\u001f1\u001fruntime-protocol\u001fparamsByAgent.get(dep.name)',
  'collection-name-identity\u001fpackages/backend/src/services/runtime/opencode/inlineConfig.ts\u001fbuildInlineConfig\u001fCallExpression:d17bc30fe13a7ef152fc\u001f1\u001fruntime-protocol\u001fparamsByAgent.get(agent.name)',
  'collection-name-identity\u001fpackages/backend/src/services/runtimeRegistry.ts\u001f<root>\u001fNewExpression:9428766592cce6b364b9\u001f1\u001fruntime-global\u001fnew Set(BUILTIN_RUNTIMES.map((b) => b.name))',
  'collection-name-identity\u001fpackages/backend/src/services/skill-zip.ts\u001fcommitSkillZipBuffer\u001fCallExpression:96b8ace641a82608112d\u001f1\u001fimport-name-boundary\u001fclaimedNames.has(targetName)',
  'collection-name-identity\u001fpackages/backend/src/services/skill-zip.ts\u001fcommitSkillZipBuffer\u001fCallExpression:f9cd15030afeebbda1b2\u001f1\u001fimport-name-boundary\u001fcandidateNames.has(name)',
  'collection-name-identity\u001fpackages/backend/src/services/skill-zip.ts\u001fcommitSkillZipBuffer\u001fNewExpression:04c80e00882e194c1187\u001f1\u001fimport-name-boundary\u001fnew Set(candidates.map((c) => c.name))',
  'collection-name-identity\u001fpackages/backend/src/services/skill-zip.ts\u001fparseSkillZipBuffer\u001fCallExpression:1ab9213557f074247375\u001f1\u001fimport-name-boundary\u001fbyName.set(row.name, rows)',
  'collection-name-identity\u001fpackages/backend/src/services/skill-zip.ts\u001fparseSkillZipBuffer\u001fCallExpression:3023029feda7ee362604\u001f1\u001fimport-name-boundary\u001fbyName.get(c.name)',
  'collection-name-identity\u001fpackages/backend/src/services/skill-zip.ts\u001fparseSkillZipBuffer\u001fCallExpression:a68e1be588b0b8918920\u001f1\u001fimport-name-boundary\u001fbyName.get(row.name)',
  'collection-name-identity\u001fpackages/backend/src/services/skillIdentityMigration.ts\u001fsweepMissingLegacyHusks\u001fNewExpression:4cb1bd076f81148e0d89\u001f1\u001flegacy-path\u001fnew Set<string>( dbCanonical && canonicalExists ? [canonicalRoot] : canonicalExists ? [canonicalRoot] : [legacySkillRootAbs(appHome, row.name)], )',
  'collection-name-identity\u001fpackages/backend/src/services/structuralDiff/classGraph.ts\u001fusedMembersAndCallers\u001fCallExpression:2bf15707fa543e1b8e92\u001f1\u001fcode-symbol\u001fbyName.set(m.name, arr)',
  'collection-name-identity\u001fpackages/backend/src/services/structuralDiff/classGraph.ts\u001fusedMembersAndCallers\u001fCallExpression:6edf3998342b9d961944\u001f1\u001fcode-symbol\u001fbyName.get(m.name)',
  'collection-name-identity\u001fpackages/backend/src/services/structuralDiff/gitBackend.ts\u001faugmentCrossFileImpact\u001fNewExpression:784001ec1ae2346e6103\u001f1\u001fcode-symbol\u001fnew Set(targets.map((t) => `${t.name}(`))',
  'collection-name-identity\u001fpackages/backend/src/services/workflow.validator.ts\u001fvalidateWorkflowDef\u001fNewExpression:7e4d470a28695735ce47\u001f1\u001fport-or-protocol-name\u001fnew Set([...declared.dataOutputs, ...declared.systemOutputs].map((p) => p.name))',
  'collection-name-identity\u001fpackages/backend/src/services/workflow.validator.ts\u001fvalidateWorkflowDef\u001fNewExpression:c6fd6d9df36491340b56\u001f1\u001fport-or-protocol-name\u001fnew Set([...declared.dataInputs, ...declared.systemInputs].map((p) => p.name))',
  "collection-name-identity\u001fpackages/backend/src/services/workgroup/launch.ts\u001fstartWorkgroupTask\u001fNewExpression:a020e8f44332039a7241\u001f1\u001fdisplay-diagnostic\u001fnew Set( agentMembers .filter((m) => typeof m.agentId !== 'string' || !existingAgentIds.has(m.agentId)) .map((m) => m.agentName ?? '(unnamed)'), )",
  'collection-name-identity\u001fpackages/frontend/src/components/canvas/connectionSync.ts\u001funiquePortName\u001fNewExpression:017998ecc67727fdffe2\u001f1\u001fport-or-protocol-name\u001fnew Set(existing.map((p) => p.name))',
  'collection-name-identity\u001fpackages/frontend/src/components/fusion/FuseDialog.tsx\u001fFuseDialog\u001fCallExpression:556d5f7d8727dd30ca33\u001f1\u001finjection-validation\u001fduplicateSkillNames.has(s.name)',
  'collection-name-identity\u001fpackages/frontend/src/components/fusion/FuseDialog.tsx\u001fFuseDialog\u001fNewExpression:118b531c4e199146bd33\u001f1\u001finjection-validation\u001fnew Set( Array.from(counts.entries()) .filter(([, count]) => count > 1) .map(([name]) => name), )',
  'collection-name-identity\u001fpackages/frontend/src/lib/agent-ports.ts\u001fduplicateEffectiveWrapperNames\u001fCallExpression:5fe486bb17ea57868c51\u001f1\u001fport-or-protocol-name\u001fbyName.delete(name)',
  'collection-name-identity\u001fpackages/frontend/src/lib/skill-zip-import.ts\u001fskillNamesForOwnerBucket\u001fNewExpression:d40a30119bd91f3cec32\u001f1\u001fimport-name-boundary\u001fnew Set( visibleSkills .filter((skill) => skill.ownerUserId === targetOwnerUserId) .map((skill) => skill.name), )',
  'collection-name-identity\u001fpackages/frontend/src/lib/skill-zip-import.ts\u001fvalidateRenameTarget\u001fCallExpression:9af549719955ad41325a\u001f1\u001fimport-name-boundary\u001fexistingSkillNames.has(newName)',
  'collection-name-identity\u001fpackages/frontend/src/lib/workflow-transition.ts\u001fapplyOutputPortsTransition\u001fNewExpression:e50d523bc1c0a2c50051\u001f1\u001fport-or-protocol-name\u001fnew Map(ports.map((port) => [port.name, port] as const))',
  'collection-name-identity\u001fpackages/frontend/src/lib/workflow-transition.ts\u001fdisappearedOutputPorts\u001fCallExpression:91dac55a0af0d7a3d87c\u001f1\u001fport-or-protocol-name\u001fnewNames.has(port.name)',
  'collection-name-identity\u001fpackages/frontend/src/lib/workflow-transition.ts\u001fdisappearedOutputPorts\u001fNewExpression:1875a2c16fec079cb2c8\u001f1\u001fport-or-protocol-name\u001fnew Set( declaredPorts(current, after, context.agentsByName).dataOutputs.map((port) => port.name), )',
  'collection-name-identity\u001fpackages/shared/src/prompt.ts\u001frenderUserPrompt\u001fCallExpression:1a3cbb12cf7ce497f06a\u001f1\u001fport-or-protocol-name\u001fPROMPT_INJECTED_PORT_NAMES.has(name)',
  'collection-name-identity\u001fpackages/shared/src/systemChannelPorts.ts\u001f<root>\u001fNewExpression:40923b6150888c390e51\u001f1\u001fport-or-protocol-name\u001fnew Set( Object.entries(SYSTEM_CHANNEL_PORTS) .filter(([, spec]) => spec.promptInjected) .map(([name]) => name), )',
  'frontend-name-key\u001fpackages/backend/src/services/runner.ts\u001frunNode\u001fBinaryExpression:d8cf512d7a0026109a14\u001f1\u001fport-or-protocol-name\u001foutputs[name] = norm',
  'frontend-name-key\u001fpackages/backend/src/services/runtime/claudeCode/inject.ts\u001ftoClaudeAgents\u001fBinaryExpression:7556d98e1f0ee2471bef\u001f1\u001fruntime-protocol\u001fagents[dep.name] = { description: dep.description, prompt: dep.bodyMd }',
  'frontend-name-key\u001fpackages/backend/src/services/runtime/claudeCode/inject.ts\u001ftoClaudeMcpConfig\u001fBinaryExpression:f8ebc86bd322dfcdc9a9\u001f2\u001fruntime-protocol\u001fservers[m.name] = entry',
  'frontend-name-key\u001fpackages/backend/src/services/runtime/opencode/driver.ts\u001fbuildSpawn\u001fComputedPropertyName:efd90113b17bce420ca3\u001f1\u001fruntime-protocol\u001f[ctx.agentName]',
  'frontend-name-key\u001fpackages/backend/src/services/runtime/opencode/inlineConfig.ts\u001fbuildInlineConfig\u001fBinaryExpression:1b704a7eef75f83fad16\u001f1\u001fruntime-protocol\u001fmcpMap[m.name] = buildInlineMcpEntry(m)',
  'frontend-name-key\u001fpackages/backend/src/services/runtime/opencode/inlineConfig.ts\u001fbuildInlineConfig\u001fBinaryExpression:a27576c85b1ba417ea2d\u001f1\u001fruntime-protocol\u001fmap[dep.name] = buildInlineAgentEntry(dep, paramsByAgent.get(dep.name))',
  'frontend-name-key\u001fpackages/backend/src/services/runtime/opencode/inlineConfig.ts\u001fbuildInlineConfig\u001fComputedPropertyName:a2e3850c47204f0d2b3c\u001f1\u001fruntime-protocol\u001f[agent.name]',
  "frontend-name-key\u001fpackages/backend/src/services/scheduler.ts\u001fresolveUpstreamInputs\u001fBinaryExpression:4adcb682bade24ff4c1c\u001f1\u001fport-or-protocol-name\u001finputs[name] = values.length === 1 ? (values[0] ?? '') : values.join('\\n\\n---\\n\\n')",
  "frontend-name-key\u001fpackages/frontend/src/components/agent-ports/AgentPortValidationSummary.tsx\u001fAgentPortValidationSummary\u001fJsxAttribute:9e83221af9cc15d1292e\u001f1\u001fport-or-protocol-name\u001fkey={`${issue.code}-${issue.key ?? issue.name ?? ''}-${issue.index ?? index}`}",
  'frontend-name-key\u001fpackages/frontend/src/components/agent/AgentCapabilityCard.tsx\u001fPortRow\u001fJsxAttribute:e964b9930f12f17e125a\u001f1\u001fport-or-protocol-name\u001fkey={`${p.name}-${index}`}',
  'frontend-name-key\u001fpackages/frontend/src/components/canvas/inspector/WrapperFanoutEdit.tsx\u001fWrapperFanoutEdit\u001fJsxAttribute:682df04f457876dc0a0f\u001f1\u001fport-or-protocol-name\u001fkey={o.name}',
  'frontend-name-key\u001fpackages/frontend/src/components/FileDropzone.tsx\u001fFilesDropzone\u001fJsxAttribute:49fec0ef75ae50835246\u001f1\u001ffilesystem-name\u001fkey={`${f.name}-${f.size}-${i}`}',
  'frontend-name-key\u001fpackages/frontend/src/components/inventory/AgentsTable.tsx\u001fAgentsTable\u001fJsxAttribute:fcd88cc8b27dbe86e141\u001f1\u001fruntime-protocol\u001fkey={a.name}',
  'frontend-name-key\u001fpackages/frontend/src/components/inventory/McpsTable.tsx\u001fMcpsTable\u001fJsxAttribute:504797de7dca4352fa83\u001f1\u001fruntime-protocol\u001fkey={m.name}',
  'frontend-name-key\u001fpackages/frontend/src/components/inventory/SkillsTable.tsx\u001fSkillsTable\u001fJsxAttribute:a7166e5b3bc6a67c77e8\u001f1\u001fruntime-protocol\u001fkey={s.name}',
  'frontend-name-key\u001fpackages/frontend/src/components/mcps/McpInventoryPanel.tsx\u001fPromptsSection\u001fJsxAttribute:bc80f3d69a077f9370fc\u001f1\u001fruntime-protocol\u001fkey={p.name}',
  'frontend-name-key\u001fpackages/frontend/src/components/mcps/McpInventoryPanel.tsx\u001fPromptsSection\u001fJsxAttribute:fcd88cc8b27dbe86e141\u001f1\u001fruntime-protocol\u001fkey={a.name}',
  'frontend-name-key\u001fpackages/frontend/src/components/mcps/McpInventoryPanel.tsx\u001fToolsSection\u001fJsxAttribute:23e66ea6f8d6e0f02b2f\u001f1\u001fruntime-protocol\u001fkey={tool.name}',
  "frontend-name-key\u001fpackages/frontend/src/components/RuntimeList.tsx\u001fRuntimeFormDialog\u001fPropertyAssignment:e9b005067c9b215061f4\u001f1\u001fruntime-global\u001fqueryKey: ['runtime', 'models', 'rt', name.trim()]",
  'frontend-name-key\u001fpackages/frontend/src/components/RuntimeList.tsx\u001fRuntimeList\u001fJsxAttribute:362b34187b17245b169c\u001f1\u001fruntime-global\u001fkey={rt.name}',
  "frontend-name-key\u001fpackages/frontend/src/components/RuntimeList.tsx\u001fRuntimeList\u001fPropertyAssignment:d096da9168e4f5e12e44\u001f1\u001fruntime-global\u001fqueryKey: ['runtime', 'models', 'rt', name]",
  'frontend-name-key\u001fpackages/frontend/src/components/skills/ImportZipPanel.tsx\u001fResultPhase\u001fJsxAttribute:1c7f19c6e80f9fa9fb33\u001f1\u001fimport-name-boundary\u001fkey={item.name}',
  'frontend-name-key\u001fpackages/frontend/src/components/skills/ImportZipPanel.tsx\u001fResultPhase\u001fJsxAttribute:e99154dd22d404862e46\u001f1\u001fimport-name-boundary\u001fkey={`${item.name}-${item.code}`}',
  'frontend-name-key\u001fpackages/frontend/src/components/skills/ImportZipPanel.tsx\u001fReviewPhase\u001fJsxAttribute:e823e2cf6505413bec52\u001f1\u001fimport-name-boundary\u001fkey={row.candidate.name}',
  'frontend-name-key\u001fpackages/frontend/src/components/TaskOutputPanel.tsx\u001fTaskOutputPanel\u001fJsxAttribute:8808a2afe9f155ffba84\u001f1\u001fport-or-protocol-name\u001fkey={`${r.port.name}-${i}`}',
  'frontend-name-key\u001fpackages/frontend/src/components/TaskOutputPanel.tsx\u001fTaskOutputPanel\u001fJsxAttribute:becf02ceddb1aacb671a\u001f1\u001fport-or-protocol-name\u001fkey={`${port.port.name}-${i}`}',
  'frontend-name-key\u001fpackages/frontend/src/components/WorktreeFilesPanel.tsx\u001fDirChildren\u001fJsxAttribute:c5b4acd338972267579a\u001f1\u001ffilesystem-name\u001fkey={entry.name}',
  "frontend-name-key\u001fpackages/frontend/src/lib/skill-zip-import.ts\u001fbuildDecisionMap\u001fBinaryExpression:03bfef62fd8ba7b27dd4\u001f1\u001fimport-name-boundary\u001fout[row.candidate.name] = { action: 'import' }",
  "frontend-name-key\u001fpackages/frontend/src/lib/skill-zip-import.ts\u001fbuildDecisionMap\u001fBinaryExpression:22a61d09c6bb1e978d5d\u001f1\u001fimport-name-boundary\u001fout[row.candidate.name] = { action: 'skip' }",
  "frontend-name-key\u001fpackages/frontend/src/lib/skill-zip-import.ts\u001fbuildDecisionMap\u001fBinaryExpression:2306dab802a531ae8c06\u001f1\u001fimport-name-boundary\u001fout[row.candidate.name] = { action: 'overwrite', skillId: target.skillId, expectedOwnerUserId: target.ownerUserId, expectedVisibility: target.visibility, expectedAclRevision: target.expectedAclRevision, expectedToken: target.expectedToken, ",
  "frontend-name-key\u001fpackages/frontend/src/lib/skill-zip-import.ts\u001fbuildDecisionMap\u001fBinaryExpression:9efd51bc06107824e2eb\u001f1\u001fimport-name-boundary\u001fout[row.candidate.name] = { action: 'rename', newName: d.newName }",
  "id-name-fallback\u001fpackages/backend/src/services/workflow.validator.ts\u001fcompareResourceIdentity\u001fBinaryExpression:7b849ec1de6e0f779e2e\u001f1\u001fdeterministic-order\u001fleft.name.localeCompare(right.name) || (left.id ?? '').localeCompare(right.id ?? '')",
  'id-name-fallback\u001fpackages/frontend/src/components/TaskSubjectLink.tsx\u001fTaskSubjectLink\u001fBinaryExpression:c120a3667d253ef16d68\u001f1\u001fdisplay-fallback\u001ftask.workflowName ?? task.workflowId',
  'id-name-fallback\u001fpackages/frontend/src/routes/clarify.tsx\u001fClarifyListPage\u001fConditionalExpression:316e1cfa80f0184b921b\u001f2\u001fdisplay-fallback\u001fitems[0]?.taskName && items[0].taskName.length > 0 ? items[0].taskName : taskId',
  'id-name-fallback\u001fpackages/frontend/src/routes/tasks.new.tsx\u001fTaskWizardPage\u001fBinaryExpression:1f916ee84daf6fb858bd\u001f1\u001fdisplay-fallback\u001fagentOptions.find((option) => option.value === agentId)?.label ?? agentName',
  'id-name-fallback\u001fpackages/frontend/src/routes/tasks.new.tsx\u001fTaskWizardPage\u001fBinaryExpression:319d4111d8d2188ff79e\u001f1\u001fdisplay-fallback\u001fworkgroupOptions.find((option) => option.value === workgroupId)?.label ?? workgroupName',
  "name-route\u001fpackages/backend/src/routes/runtimes.ts\u001fmountRuntimesRoutes\u001fStringLiteral:034caf1cbd8e79a5fef1\u001f1\u001fruntime-global\u001f'/api/runtimes/:name/probe'",
  "name-route\u001fpackages/backend/src/routes/runtimes.ts\u001fmountRuntimesRoutes\u001fStringLiteral:87b6540e34ce0a2e31b4\u001f2\u001fruntime-global\u001f'/api/runtimes/:name'",
  "name-route\u001fpackages/backend/src/routes/runtimes.ts\u001fmountRuntimesRoutes\u001fStringLiteral:cd417bfe1eb05d6285f2\u001f1\u001fruntime-global\u001f'/api/runtimes/:name/enabled'",
  'sql-name-selector\u001fpackages/backend/src/services/importRefs.ts\u001fbuildCandidateSnapshotsInTx\u001fCallExpression:03169331a96b84cdcf29\u001f1\u001fportable-selector\u001finArray(table.name, names)',
  'sql-name-selector\u001fpackages/backend/src/services/plugin.ts\u001ffullPluginRowWhere\u001fCallExpression:b47860501605b15e093f\u001f1\u001focc-fence\u001feq(plugins.name, row.name)',
  'sql-name-selector\u001fpackages/backend/src/services/resourceAcl.ts\u001fupdateResourceAcl\u001fCallExpression:76ab257c288c5be30912\u001f1\u001fowner-uniqueness\u001feq(table.name, cur.name)',
  'sql-name-selector\u001fpackages/backend/src/services/skill-zip.ts\u001flistTargetRowsByName\u001fCallExpression:d4aacb57560033abf229\u001f1\u001fimport-name-boundary\u001finArray(skills.name, [...new Set(names)])',
  'sql-name-selector\u001fpackages/backend/src/services/skill.ts\u001fisSkillNameOccupiedForOwner\u001fCallExpression:8ac7999e7a14319cb452\u001f1\u001fowner-uniqueness\u001feq(skills.name, name)',
] as const

function parseAllowance(row: string): ExactAllowance {
  const [category, file, rawFunctionName, fingerprint, rawCount, reasonCode, excerpt] =
    row.split('\u001f')
  if (
    category === undefined ||
    file === undefined ||
    rawFunctionName === undefined ||
    fingerprint === undefined ||
    rawCount === undefined ||
    reasonCode === undefined ||
    excerpt === undefined ||
    !(reasonCode in ALLOWANCE_REASONS)
  ) {
    throw new Error(`invalid RFC-223 identity allowance row: ${row}`)
  }
  return {
    category: category as IdentityGuardCategory,
    file,
    functionName: rawFunctionName === '<root>' ? null : rawFunctionName,
    fingerprint,
    excerpt,
    count: Number(rawCount),
    reason: ALLOWANCE_REASONS[reasonCode as AllowanceReasonCode],
  }
}

const EXACT_ALLOWANCES = EXACT_ALLOWANCE_ROWS.map(parseAllowance)

function sourceFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (entry.isFile() && (path.endsWith('.ts') || path.endsWith('.tsx'))) out.push(path)
  }
  return out.sort()
}

function scanProductionSources(): IdentityGuardFinding[] {
  const findings: IdentityGuardFinding[] = []
  for (const sourceRoot of SOURCE_ROOTS) {
    for (const file of sourceFiles(resolve(REPO_ROOT, sourceRoot))) {
      findings.push(...analyzeIdentitySource(readFileSync(file, 'utf8'), relative(REPO_ROOT, file)))
    }
  }
  return findings
}

function exactIdentity(
  value: Pick<ExactAllowance, 'category' | 'file' | 'functionName' | 'fingerprint' | 'excerpt'>,
): string {
  return JSON.stringify([
    value.category,
    value.file,
    value.functionName,
    value.fingerprint,
    value.excerpt,
  ])
}

function allowanceDiagnostics(
  findings: readonly IdentityGuardFinding[],
  allowances: readonly ExactAllowance[],
): string[] {
  const actualCounts = new Map<string, number>()
  const allowedCounts = new Map<string, { count: number; reason: string }>()
  for (const finding of findings) {
    const key = exactIdentity(finding)
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1)
  }
  for (const allowance of allowances) {
    const key = exactIdentity(allowance)
    if (allowedCounts.has(key)) throw new Error(`duplicate allowance row: ${key}`)
    allowedCounts.set(key, { count: allowance.count, reason: allowance.reason })
  }

  const diagnostics: string[] = []
  for (const [key, actual] of actualCounts) {
    const allowed = allowedCounts.get(key)?.count ?? 0
    if (actual > allowed) {
      diagnostics.push(`unreviewed identity sink (${actual} actual > ${allowed} allowed): ${key}`)
    }
  }
  for (const [key, allowance] of allowedCounts) {
    const actual = actualCounts.get(key) ?? 0
    if (actual < allowance.count) {
      diagnostics.push(
        `stale identity allowance (${actual} actual < ${allowance.count} allowed; ${allowance.reason}): ${key}`,
      )
    }
  }
  return diagnostics.sort()
}

function exactAllowance(file: string, functionName: string, fingerprint: string): ExactAllowance {
  const allowance = EXACT_ALLOWANCES.find(
    (entry) =>
      entry.file === file &&
      entry.functionName === functionName &&
      entry.fingerprint === fingerprint,
  )
  if (allowance === undefined) throw new Error(`missing fixture allowance ${file}:${functionName}`)
  return allowance
}

describe('RFC-223 T15 structural identity guard', () => {
  test('production source matches the exact reviewed fingerprint multiset', () => {
    const findings = scanProductionSources()
    expect(allowanceDiagnostics(findings, EXACT_ALLOWANCES)).toEqual([])
    expect(findings.length).toBe(83)
  })

  test('detects bracket SQL, neutral table aliases and query-result rows', () => {
    const findings = analyzeIdentitySource(
      `
      const direct = eq(agents['name'], selector)
      const t = agents
      const aliased = eq(t['name'], selector)
      const rows = await db.select().from(agents)
      const found = rows.find((row) => row.name === selector)
      `,
      'fixture.ts',
    )
    expect(findings.filter((finding) => finding.category === 'sql-name-selector')).toHaveLength(2)
    expect(
      findings.filter((finding) => finding.category === 'collection-name-identity'),
    ).toHaveLength(1)
  })

  test('detects id/name fallback, rows.find, Map.set and neutral value aliases', () => {
    const findings = analyzeIdentitySource(
      `
      const fallback = byId.get(ref) ?? byName.get(ref)
      const direct = agents.find((row) => row.name === selector)
      const key = row['name']
      const map = new Map()
      map.set(key, row)
      `,
      'fixture.ts',
    )
    expect(findings.map((finding) => finding.category).sort()).toEqual([
      'collection-name-identity',
      'collection-name-identity',
      'id-name-fallback',
    ])
  })

  test('detects JSX key aliases, computed keys, assignments, query keys and name routes', () => {
    const findings = analyzeIdentitySource(
      `
      const alias = resource.name
      const view = <Row key={alias} />
      const keyed = { [agent.name]: value }
      out[skill.name] = value
      const query = { queryKey: ['skill', skill.name] }
      app.get('/api/skills/:name', handler)
      `,
      'fixture.tsx',
    )
    expect(findings.filter((finding) => finding.category === 'frontend-name-key')).toHaveLength(4)
    expect(findings.filter((finding) => finding.category === 'name-route')).toHaveLength(1)
  })

  test('validateWorkflowDef allowance is exact; another sink in that function remains unreviewed', () => {
    const source = `
      function validateWorkflowDef() {
        const outputNames = new Set([...declared.dataOutputs, ...declared.systemOutputs].map((p) => p.name))
        agents.find((agent) => agent.name === selector)
      }
    `
    const findings = analyzeIdentitySource(
      source,
      'packages/backend/src/services/workflow.validator.ts',
    )
    const allowance = exactAllowance(
      'packages/backend/src/services/workflow.validator.ts',
      'validateWorkflowDef',
      'NewExpression:7e4d470a28695735ce47',
    )
    expect(allowanceDiagnostics(findings, [allowance])).toHaveLength(1)
    expect(allowanceDiagnostics(findings, [allowance])[0]).toContain('unreviewed identity sink')
  })

  test('resourceAcl and skill ZIP allowances do not cover adjacent name selectors', () => {
    const aclFindings = analyzeIdentitySource(
      `
      function updateResourceAcl() {
        eq(table.name, cur.name)
        eq(agents.name, selector)
      }
      `,
      'packages/backend/src/services/resourceAcl.ts',
    )
    const aclAllowance = exactAllowance(
      'packages/backend/src/services/resourceAcl.ts',
      'updateResourceAcl',
      'CallExpression:76ab257c288c5be30912',
    )
    expect(allowanceDiagnostics(aclFindings, [aclAllowance])).toHaveLength(1)

    const zipFindings = analyzeIdentitySource(
      `
      function listTargetRowsByName() {
        inArray(skills.name, [...new Set(names)])
        eq(skills.name, selector)
      }
      `,
      'packages/backend/src/services/skill-zip.ts',
    )
    const zipAllowance = exactAllowance(
      'packages/backend/src/services/skill-zip.ts',
      'listTargetRowsByName',
      'CallExpression:d4aacb57560033abf229',
    )
    expect(allowanceDiagnostics(zipFindings, [zipAllowance])).toHaveLength(1)
  })

  test('skill ZIP Map allowance is exact and cannot absorb another collection sink', () => {
    const findings = analyzeIdentitySource(
      `
      function parseSkillZipBuffer() {
        byName.get(row.name)
        skills.find((skill) => skill.name === selector)
      }
      `,
      'packages/backend/src/services/skill-zip.ts',
    )
    const allowance = exactAllowance(
      'packages/backend/src/services/skill-zip.ts',
      'parseSkillZipBuffer',
      'CallExpression:a68e1be588b0b8918920',
    )
    expect(allowanceDiagnostics(findings, [allowance])).toHaveLength(1)
  })

  test('copying an identical allowed sink fails the multiset count', () => {
    const findings = analyzeIdentitySource(
      `
      function validateWorkflowDef() {
        new Set([...declared.dataOutputs, ...declared.systemOutputs].map((p) => p.name))
        new Set([...declared.dataOutputs, ...declared.systemOutputs].map((p) => p.name))
      }
      `,
      'packages/backend/src/services/workflow.validator.ts',
    )
    const allowance = exactAllowance(
      'packages/backend/src/services/workflow.validator.ts',
      'validateWorkflowDef',
      'NewExpression:7e4d470a28695735ce47',
    )
    const diagnostics = allowanceDiagnostics(findings, [allowance])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('2 actual > 1 allowed')
  })
})
