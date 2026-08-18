// RFC-198 — two-way UX inventory for every shared Dialog/ConfirmDialog callsite.
//
// Adding a modal is an all-interface change: it must join an explicit product
// family with a rendered behavior owner, while mobile sizing remains owned by
// the shared primitive contract below.  The AST walk resolves imports, so prose
// and unrelated local components named "Dialog" cannot satisfy the manifest.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { toPortableRelativePath } from './portable-path'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

type OverlayFamily =
  | 'primitive-and-guard'
  | 'access-and-settings'
  | 'resource-management'
  | 'workflow-authoring'
  | 'task-execution'
  | 'review-and-clarify'
  | 'memory-and-fusion'
  | 'workgroup'
  | 'shell-navigation'

interface OverlayCallsite {
  family: OverlayFamily
  count: number
}

interface OverlayFamilyOwner {
  owner: string
  /** Shared <=720px sizing/scroll/action contract; this test owns it centrally. */
  mobileOwner: string
}

const MOBILE_OWNER = 'overlay-ux-inventory.test.ts'

const OVERLAY_FAMILY_OWNERS = {
  'primitive-and-guard': {
    owner: 'confirm-dialog.test.tsx',
    mobileOwner: MOBILE_OWNER,
  },
  'access-and-settings': {
    owner: 'users-page-actions.test.tsx',
    mobileOwner: MOBILE_OWNER,
  },
  'resource-management': {
    owner: 'agent-import-dialog.test.tsx',
    mobileOwner: MOBILE_OWNER,
  },
  'workflow-authoring': {
    owner: 'workflow-canvas-delete-dialog.test.tsx',
    mobileOwner: MOBILE_OWNER,
  },
  'task-execution': {
    owner: 'repair-choice-dialog.test.tsx',
    mobileOwner: MOBILE_OWNER,
  },
  'review-and-clarify': {
    owner: 'clarify-detail-route.test.tsx',
    mobileOwner: MOBILE_OWNER,
  },
  'memory-and-fusion': {
    owner: 'memory-all-list.test.tsx',
    mobileOwner: MOBILE_OWNER,
  },
  workgroup: {
    owner: 'workgroup-room.test.tsx',
    mobileOwner: MOBILE_OWNER,
  },
  'shell-navigation': {
    owner: 'inbox-drawer.test.tsx',
    mobileOwner: MOBILE_OWNER,
  },
} as const satisfies Record<OverlayFamily, OverlayFamilyOwner>

const OVERLAY_CALLSITES = {
  'components/ConfirmDialog.tsx': { family: 'primitive-and-guard', count: 1 },
  'components/split/UnsavedChangesGuard.tsx': { family: 'primitive-and-guard', count: 1 },

  'components/AclPanel.tsx': { family: 'access-and-settings', count: 2 },
  'components/account/AccountSecurityPanel.tsx': {
    family: 'access-and-settings',
    count: 1,
  },
  'components/account/AccountTokensPanel.tsx': {
    family: 'access-and-settings',
    count: 1,
  },
  // RFC-247 / RFC-250 — token issuance. Four Dialog renders separate editing /
  // creating, unreadable recovery storage, the secret shown exactly once, and
  // an unknown POST outcome that must reconcile inventory without offering a
  // second create attempt.
  'components/account/CreateTokenDialog.tsx': {
    family: 'access-and-settings',
    count: 4,
  },
  // Runtime edit/add dialog plus RFC-201's shared destructive confirmation.
  'components/RuntimeList.tsx': { family: 'access-and-settings', count: 2 },
  'components/users/CreateUserDialog.tsx': { family: 'access-and-settings', count: 1 },
  'components/users/EditUserDialog.tsx': { family: 'access-and-settings', count: 1 },
  'components/users/ResetUserPasswordDialog.tsx': {
    family: 'access-and-settings',
    count: 1,
  },
  // OIDC provider form/delete, its RFC-250 dirty-close confirmation, backup
  // restore, and password-login policy confirmation.
  'routes/settings.tsx': { family: 'access-and-settings', count: 5 },
  'routes/users.tsx': { family: 'access-and-settings', count: 2 },
  // RFC-257: endpoint create + one-time secret reveal.
  'components/WebhookEndpointCard.tsx': { family: 'access-and-settings', count: 3 },

  'components/AgentImportDialog.tsx': { family: 'resource-management', count: 1 },
  // RFC-222 (D5): the shared resource-detail header owns More, ACL, and the
  // type-to-confirm delete dialog for agents / skills / mcps / plugins / workgroups.
  'components/DetailHeaderActions.tsx': { family: 'resource-management', count: 3 },
  'components/QuickCreateDialog.tsx': { family: 'resource-management', count: 1 },
  'components/RenameDialog.tsx': { family: 'resource-management', count: 1 },
  'components/agent-ports/AgentPortDialog.tsx': { family: 'resource-management', count: 1 },
  'components/agents/DependencyAutodetectDialog.tsx': {
    family: 'resource-management',
    count: 1,
  },
  // RFC-238: runtime playground plus its separate immediate-end confirmation.
  'components/mcps/McpRuntimeTestDialog.tsx': { family: 'resource-management', count: 2 },
  'components/repos/BatchImportDialog.tsx': { family: 'resource-management', count: 1 },
  // RFC-249: bulk-source dialog and its residual-draft confirmation.
  // RFC-271：配置包导入的主流程走一个 full-size Dialog；已做出逐条决策后替换/移除
  // 文件再走一个嵌套确认，避免误清空只存在组件 state 里的选择。
  'components/ResourcePackageImportDialog.tsx': { family: 'resource-management', count: 2 },
  'components/repos/RepoBulkAddDialog.tsx': { family: 'resource-management', count: 2 },
  // RFC-249: editor dialog, residual-draft confirmation, and subtree-delete confirmation.
  'components/repos/RepoGroupEditor.tsx': { family: 'resource-management', count: 3 },
  'components/skill/SkillVersionHistory.tsx': { family: 'resource-management', count: 1 },
  // RFC-201: replacing ZIP-import review state is an explicit shared Dialog.
  'components/skills/ImportZipPanel.tsx': { family: 'resource-management', count: 1 },
  'routes/repos.tsx': { family: 'resource-management', count: 3 },
  'routes/scheduled.tsx': { family: 'resource-management', count: 1 },
  // RFC-257: trigger editor + per-trigger fires; delivery raw-body detail.
  // RFC-295: switching an Agent target with target-specific draft adds an
  // explicit preservation confirmation inside the trigger editor.
  'components/webhooks/TriggersPanel.tsx': { family: 'resource-management', count: 4 },
  'components/webhooks/DeliveriesPanel.tsx': { family: 'resource-management', count: 1 },

  // RFC-239: the changes pane's deep views (graph/impact/call-chain/deps) overlay.
  'components/changes/DrilldownOverlay.tsx': { family: 'task-execution', count: 1 },
  // RFC-267: script bodies can expand from the inspector into a full-screen editor.
  'components/canvas/inspector/ScriptEdit.tsx': {
    family: 'workflow-authoring',
    count: 1,
  },
  'components/canvas/WorkflowCanvas.tsx': { family: 'workflow-authoring', count: 1 },
  'components/workflow-editor/ConnectionDialog.tsx': {
    family: 'workflow-authoring',
    count: 1,
  },
  'components/workflow-editor/ValidationPanel.tsx': {
    family: 'workflow-authoring',
    count: 1,
  },
  'components/workflow-editor/WorkflowDraftStatus.tsx': {
    family: 'workflow-authoring',
    count: 2,
  },
  'components/workflow-editor/WorkflowNodePicker.tsx': {
    family: 'workflow-authoring',
    count: 1,
  },
  'components/workflow-editor/WorkflowStarterDialog.tsx': {
    family: 'workflow-authoring',
    count: 1,
  },
  'routes/workflows.edit.tsx': { family: 'workflow-authoring', count: 5 },

  'components/ScheduleDialog.tsx': { family: 'task-execution', count: 1 },
  'components/tasks/QuestionAuthorForm.tsx': { family: 'task-execution', count: 1 },
  'components/tasks/RepairChoiceDialog.tsx': { family: 'task-execution', count: 1 },
  'components/tasks/RepairConfirmModal.tsx': { family: 'task-execution', count: 1 },
  'components/tasks/TaskDiagnosePanel.tsx': { family: 'task-execution', count: 1 },
  'components/tasks/TaskMembersPanel.tsx': { family: 'task-execution', count: 2 },
  'components/tasks/WorkflowSyncDialog.tsx': { family: 'task-execution', count: 1 },
  // RFC-222 (D5): +1 for the admin-only task-delete type-to-confirm dialog.
  'routes/tasks.detail.tsx': { family: 'task-execution', count: 2 },
  // RFC-244: dense task-list advanced filters use the shared Dialog shell.
  'routes/tasks.tsx': { family: 'task-execution', count: 1 },
  // RFC-250: persisted Task Wizard draft recovery is an explicit decision.
  'routes/tasks.new.tsx': { family: 'task-execution', count: 1 },

  'components/clarify/CentralizedAnswerDialog.tsx': {
    family: 'review-and-clarify',
    count: 1,
  },
  'components/review/MultiDocReviewView.tsx': { family: 'review-and-clarify', count: 1 },
  'routes/clarify.detail.tsx': { family: 'review-and-clarify', count: 1 },
  // RFC-304 — the two dialogs that make the code capability configurable at
  // all: a department framework, and the group binding that names which agent
  // fills each of its AI slots. Before them the matrix could switch a
  // capability on but never point it at a configuration.
  // T63 added the bulk-change dialog: preview → apply → undo, all in one
  // overlay because they are one decision the author is making.
  // RFC-309 — two dialogs, not three: the framework and binding creators
  // merged with the resources they create.
  'routes/code.tsx': { family: 'resource-management', count: 2 },
  // RFC-310 — mission launch dialog（三输入形态）与 requirement 文件预览。
  'routes/code.missions.tsx': { family: 'task-execution', count: 1 },
  // RFC-310 PR-8 T90 — assignment 编辑 Dialog。
  'routes/code.assignments.tsx': { family: 'resource-management', count: 1 },
  // RFC-310 PR-8 T87 — policy 创建对话框。
  'routes/code.policies.tsx': { family: 'resource-management', count: 1 },
  // RFC-310 PR-8 — +attach-MR dialog（T80 挂接命令的输入面）。
  'routes/code.missions.$id.tsx': { family: 'task-execution', count: 2 },
  // RFC-310 PR-8 — 配置资源的创建 Dialog（列表）与编辑/ACL Dialog + 归档
  // ConfirmDialog（详情）。
  'routes/code.config.tsx': { family: 'resource-management', count: 1 },
  'routes/code.config.detail.tsx': { family: 'resource-management', count: 3 },
  // RFC-307 — the stage drawer. An overlay rather than an inline panel because
  // it is a focused edit on ONE step of a sequence the user is looking at: the
  // flow behind it is the context, and pushing it out of view to make room
  // would lose exactly the connection between position and configuration this
  // RFC exists to create.
  // RFC-309 — renamed with its scope: the panel used to pick a capability and
  // then a configuration; it is now handed one template and edits that.
  'components/code/TemplateFlowEditor.tsx': { family: 'resource-management', count: 1 },
  'routes/reviews.detail.tsx': { family: 'review-and-clarify', count: 1 },

  'components/fusion/FuseDialog.tsx': { family: 'memory-and-fusion', count: 1 },
  'components/memory/MemoryAllList.tsx': { family: 'memory-and-fusion', count: 1 },
  'components/memory/MemoryConflictCompareDialog.tsx': {
    family: 'memory-and-fusion',
    count: 1,
  },
  'components/memory/MemoryDialogShell.tsx': { family: 'memory-and-fusion', count: 1 },
  'routes/fusions.detail.tsx': { family: 'memory-and-fusion', count: 1 },

  // RFC-234 intent builder — create-session dialog + slot-driven commit dialog,
  // add-mount dialog (T11), and the read-only expanded workflow preview.
  'routes/intent.tsx': { family: 'workflow-authoring', count: 1 },
  'routes/intent.detail.tsx': { family: 'workflow-authoring', count: 1 },
  'components/IntentMountDialog.tsx': { family: 'workflow-authoring', count: 1 },
  'components/intent/IntentOpPreview.tsx': { family: 'workflow-authoring', count: 1 },

  'components/workgroup/DynamicWorkflowPanel.tsx': { family: 'workgroup', count: 2 },
  'components/workgroup/WorkgroupMemberCards.tsx': { family: 'workgroup', count: 2 },
  'components/workgroup/WorkgroupDraftStatus.tsx': { family: 'workgroup', count: 2 },
  // RFC-217 T10 房间拆分：gate-reject 对话框留壳，交付表单对话框出文件。
  'components/workgroup/room/WorkgroupRoom.tsx': { family: 'workgroup', count: 1 },
  'components/workgroup/room/DeliverFormDialog.tsx': { family: 'workgroup', count: 1 },
  'components/workgroup/WorkgroupTaskConfigDialog.tsx': { family: 'workgroup', count: 1 },
  'routes/workgroups.detail.tsx': { family: 'workgroup', count: 3 },

  'components/shell/InboxDrawer.tsx': { family: 'shell-navigation', count: 1 },
  'components/shell/MobileNavDialog.tsx': { family: 'shell-navigation', count: 1 },
} as const satisfies Record<string, OverlayCallsite>

const SRC_ROOT = resolve(import.meta.dirname, '../src')

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    return entry.isDirectory() ? tsxFiles(path) : entry.name.endsWith('.tsx') ? [path] : []
  })
}

function isSharedOverlayImport(moduleName: string, importedName: string): boolean {
  if (importedName === 'Dialog') {
    return moduleName === '@/components/Dialog' || /(^|\/)Dialog$/.test(moduleName)
  }
  if (importedName === 'ConfirmDialog') {
    return moduleName === '@/components/ConfirmDialog' || /(^|\/)ConfirmDialog$/.test(moduleName)
  }
  return false
}

/** Return direct shared primitive render counts keyed relative to src/. */
function findOverlayCallsites(): Map<string, number> {
  const result = new Map<string, number>()

  for (const file of tsxFiles(SRC_ROOT)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    const overlayLocals = new Set<string>()

    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue
      }
      const bindings = statement.importClause?.namedBindings
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text
        if (isSharedOverlayImport(statement.moduleSpecifier.text, importedName)) {
          overlayLocals.add(element.name.text)
        }
      }
    }

    let count = 0
    const visit = (node: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) &&
        overlayLocals.has(node.tagName.text)
      ) {
        count += 1
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (count > 0) result.set(toPortableRelativePath(relative(SRC_ROOT, file)), count)
  }

  return result
}

describe('RFC-198 all-interface overlay UX inventory', () => {
  test('is a two-way AST ratchet for every direct Dialog/ConfirmDialog render', () => {
    const actual = [...findOverlayCallsites()].sort(([a], [b]) => a.localeCompare(b))
    const expected = Object.entries(OVERLAY_CALLSITES)
      .map(([file, entry]) => [file, entry.count] as const)
      .sort(([a], [b]) => a.localeCompare(b))

    expect(actual).toEqual(expected)
  })

  test('covers at least six product families and every family has behavior + mobile owners', () => {
    const referencedFamilies = new Set(
      Object.values(OVERLAY_CALLSITES).map((entry) => entry.family),
    )
    expect(referencedFamilies.size).toBeGreaterThanOrEqual(6)
    expect([...referencedFamilies].sort()).toEqual(Object.keys(OVERLAY_FAMILY_OWNERS).sort())

    for (const [family, owners] of Object.entries(OVERLAY_FAMILY_OWNERS)) {
      expect(
        existsSync(resolve(import.meta.dirname, owners.owner)),
        `${family} behavior owner`,
      ).toBe(true)
      expect(
        existsSync(resolve(import.meta.dirname, owners.mobileOwner)),
        `${family} mobile owner`,
      ).toBe(true)
    }
  })

  test('mobile owner keeps every shared overlay viewport-bounded with reachable actions', () => {
    const css = readFileSync(resolve(SRC_ROOT, 'styles.css'), 'utf8')
    const start = css.indexOf('@media (max-width: 720px) {', css.indexOf('RFC-198'))
    const end = css.indexOf('/* ---- RFC-198 responsive application shell ---- */', start)
    const mobile = css.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(mobile).toMatch(/\.dialog__panel,[\s\S]*?width:\s*100%/)
    expect(mobile).toMatch(/max-height:\s*calc\(100dvh\s*-\s*24px\)/)
    expect(mobile).toMatch(/\.dialog__footer\s*\{[\s\S]*?flex-wrap:\s*wrap/)
    expect(mobile).toMatch(/\.dialog__footer \.btn\s*\{[\s\S]*?flex:\s*1 1 auto/)
  })
})
