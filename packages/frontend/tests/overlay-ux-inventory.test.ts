// RFC-198 — two-way UX inventory for every shared Dialog/ConfirmDialog callsite.
//
// Adding a modal is an all-interface change: it must join an explicit product
// family with a rendered behavior owner, while mobile sizing remains owned by
// the shared primitive contract below.  The AST walk resolves imports, so prose
// and unrelated local components named "Dialog" cannot satisfy the manifest.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
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
  'components/RuntimeList.tsx': { family: 'access-and-settings', count: 1 },
  'routes/settings.tsx': { family: 'access-and-settings', count: 2 },
  'routes/users.tsx': { family: 'access-and-settings', count: 1 },

  'components/AgentImportDialog.tsx': { family: 'resource-management', count: 1 },
  'components/QuickCreateDialog.tsx': { family: 'resource-management', count: 1 },
  'components/RenameDialog.tsx': { family: 'resource-management', count: 1 },
  'components/SkillFileTree.tsx': { family: 'resource-management', count: 1 },
  'components/WorkflowImportDialog.tsx': { family: 'resource-management', count: 1 },
  'components/agent-ports/AgentPortDialog.tsx': { family: 'resource-management', count: 1 },
  'components/agents/DependencyAutodetectDialog.tsx': {
    family: 'resource-management',
    count: 1,
  },
  'components/repos/BatchImportDialog.tsx': { family: 'resource-management', count: 1 },
  'components/skill/SkillVersionHistory.tsx': { family: 'resource-management', count: 1 },
  'routes/repos.tsx': { family: 'resource-management', count: 1 },

  'components/canvas/WorkflowCanvas.tsx': { family: 'workflow-authoring', count: 1 },
  'components/workflow-editor/WorkflowDraftStatus.tsx': {
    family: 'workflow-authoring',
    count: 2,
  },

  'components/ScheduleDialog.tsx': { family: 'task-execution', count: 1 },
  'components/tasks/QuestionAuthorForm.tsx': { family: 'task-execution', count: 1 },
  'components/tasks/RepairChoiceDialog.tsx': { family: 'task-execution', count: 1 },
  'components/tasks/RepairConfirmModal.tsx': { family: 'task-execution', count: 1 },
  'components/tasks/TaskDiagnosePanel.tsx': { family: 'task-execution', count: 1 },
  'components/tasks/TaskMembersPanel.tsx': { family: 'task-execution', count: 2 },
  'components/tasks/WorkflowSyncDialog.tsx': { family: 'task-execution', count: 1 },
  'routes/tasks.detail.tsx': { family: 'task-execution', count: 1 },

  'components/clarify/CentralizedAnswerDialog.tsx': {
    family: 'review-and-clarify',
    count: 1,
  },
  'components/review/MultiDocReviewView.tsx': { family: 'review-and-clarify', count: 1 },
  'routes/clarify.detail.tsx': { family: 'review-and-clarify', count: 1 },
  'routes/reviews.detail.tsx': { family: 'review-and-clarify', count: 1 },

  'components/fusion/FuseDialog.tsx': { family: 'memory-and-fusion', count: 1 },
  'components/memory/MemoryAllList.tsx': { family: 'memory-and-fusion', count: 1 },
  'components/memory/MemoryConflictCompareDialog.tsx': {
    family: 'memory-and-fusion',
    count: 1,
  },
  'components/memory/MemoryDialogShell.tsx': { family: 'memory-and-fusion', count: 1 },
  'routes/fusions.detail.tsx': { family: 'memory-and-fusion', count: 1 },

  'components/workgroup/DynamicWorkflowPanel.tsx': { family: 'workgroup', count: 2 },
  'components/workgroup/WorkgroupMemberCards.tsx': { family: 'workgroup', count: 2 },
  'components/workgroup/WorkgroupRoom.tsx': { family: 'workgroup', count: 2 },
  'components/workgroup/WorkgroupTaskConfigDialog.tsx': { family: 'workgroup', count: 1 },

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
    if (count > 0) result.set(relative(SRC_ROOT, file), count)
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
