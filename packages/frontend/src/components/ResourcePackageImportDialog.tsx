// RFC-271 T36 —— 配置包导入对话框。
//
// **零自写 chrome**（CLAUDE.md 的前台风格强制原则）：overlay / focus trap / ESC /
// footer 全部来自 `<Dialog>`，逐条选择走 `.segmented`，候选下拉走 `<Select>`，
// 改名走 `<Field>+<TextInput>`，状态走 `<StatusChip>`，错误/空/加载走 `<ErrorBanner>`
// / `<EmptyState>` / `<LoadingState>`。这里一个 `.xxx__overlay` 都不该出现。
//
// 交互形态是两步（与技能 zip 导入同姿势）：选文件 → 预检 → 逐条决策 → 提交。
// 文件由前端持有并传两次，服务端不存暂存态；两次之间靠 `importId` 与
// `previewToken` 绑定，前端**原样回传**、不解读也不重算。

import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/Dialog'
import { Field, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { ErrorBanner } from '@/components/ErrorBanner'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { StatusChip } from '@/components/StatusChip'
import {
  commitResourcePackage,
  previewResourcePackage,
  type ImportAction,
  type ImportDecision,
  type PackageImportReceipt,
  type PackagePreview,
} from '@/api/resourcePackages'

export interface ResourcePackageImportDialogProps {
  open: boolean
  onClose: () => void
  /** 导入完成后让调用方刷新列表。 */
  onImported?: (receipt: PackageImportReceipt) => void
}

type Phase = 'pick' | 'previewing' | 'decide' | 'committing' | 'done'

export function ResourcePackageImportDialog(
  props: ResourcePackageImportDialogProps,
): ReactElement | null {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('pick')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<PackagePreview | null>(null)
  const [decisions, setDecisions] = useState<Record<string, ImportDecision>>({})
  const [receipt, setReceipt] = useState<PackageImportReceipt | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reset = (): void => {
    setPhase('pick')
    setFile(null)
    setPreview(null)
    setDecisions({})
    setReceipt(null)
    setError(null)
  }

  const runPreview = async (picked: File): Promise<void> => {
    setError(null)
    setPhase('previewing')
    try {
      const next = await previewResourcePackage(picked)
      setPreview(next)
      // 默认动作：能复用就复用（最小惊讶——用户多半不想凭空多出一份副本），
      // 否则新建。这只是**默认值**，每条都可改。
      setDecisions(
        Object.fromEntries(
          next.entries.map((e) => [
            e.localSlug,
            e.allowedActions.includes('reuse') && e.candidates[0] !== undefined
              ? { localSlug: e.localSlug, action: 'reuse' as const, targetId: e.candidates[0].id }
              : { localSlug: e.localSlug, action: 'new' as const, finalName: e.suggestedName },
          ]),
        ),
      )
      setPhase('decide')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('pick')
    }
  }

  const runCommit = async (): Promise<void> => {
    if (file === null || preview === null) return
    setError(null)
    setPhase('committing')
    try {
      const out = await commitResourcePackage(file, preview, Object.values(decisions))
      setReceipt(out)
      setPhase('done')
      props.onImported?.(out)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('decide')
    }
  }

  const setAction = (
    slug: string,
    action: ImportAction,
    entry: PackagePreview['entries'][number],
  ): void => {
    setDecisions((prev) => ({
      ...prev,
      [slug]:
        action === 'new'
          ? { localSlug: slug, action, finalName: prev[slug]?.finalName ?? entry.suggestedName }
          : {
              localSlug: slug,
              action,
              targetId: prev[slug]?.targetId ?? entry.candidates[0]?.id,
            },
    }))
  }

  return (
    <Dialog
      open={props.open}
      size="full"
      title={t('resourcePackage.importTitle')}
      onClose={() => {
        reset()
        props.onClose()
      }}
      footer={
        <>
          <button
            type="button"
            className="btn"
            onClick={() => {
              reset()
              props.onClose()
            }}
          >
            {t('common.close')}
          </button>
          {phase === 'decide' ? (
            <button
              type="button"
              className="btn btn--primary"
              data-testid="package-import-commit"
              onClick={() => void runCommit()}
            >
              {t('resourcePackage.commit')}
            </button>
          ) : null}
        </>
      }
    >
      {error !== null ? <ErrorBanner error={error} /> : null}

      {phase === 'pick' ? (
        <Field label={t('resourcePackage.file')} hint={t('resourcePackage.fileHint')}>
          <input
            type="file"
            accept=".zip"
            data-testid="package-import-file"
            onChange={(e) => {
              const picked = e.target.files?.[0]
              if (picked === undefined) return
              setFile(picked)
              void runPreview(picked)
            }}
          />
        </Field>
      ) : null}

      {phase === 'previewing' || phase === 'committing' ? (
        <LoadingState label={t('resourcePackage.working')} />
      ) : null}

      {phase === 'decide' && preview !== null ? (
        preview.entries.length === 0 ? (
          <EmptyState title={t('resourcePackage.emptyPackage')} />
        ) : (
          <div className="page__section">
            {preview.secrets.length > 0 ? (
              <p data-testid="package-import-secrets">
                {t('resourcePackage.secretsNotice', { count: preview.secrets.length })}
              </p>
            ) : null}
            {preview.entries.map((entry) => {
              const decision = decisions[entry.localSlug]
              return (
                <div key={entry.localSlug} className="page__section">
                  <div className="page__header--row">
                    <strong>{entry.name}</strong>
                    <StatusChip kind="neutral">{entry.type}</StatusChip>
                  </div>
                  <div className="segmented" role="group" aria-label={entry.name}>
                    {entry.allowedActions.map((action) => (
                      <button
                        key={action}
                        type="button"
                        className={decision?.action === action ? 'is-active' : ''}
                        data-testid={`package-action-${entry.localSlug}-${action}`}
                        onClick={() => setAction(entry.localSlug, action, entry)}
                      >
                        {t(`resourcePackage.action.${action}`)}
                      </button>
                    ))}
                  </div>
                  {decision?.action === 'new' ? (
                    <Field label={t('resourcePackage.finalName')}>
                      <TextInput
                        value={decision.finalName ?? entry.suggestedName}
                        data-testid={`package-name-${entry.localSlug}`}
                        onChange={(v) =>
                          setDecisions((prev) => ({
                            ...prev,
                            [entry.localSlug]: { ...prev[entry.localSlug]!, finalName: v },
                          }))
                        }
                      />
                    </Field>
                  ) : null}
                  {decision?.action !== 'new' && entry.candidates.length > 0 ? (
                    <Field label={t('resourcePackage.target')}>
                      <Select
                        value={decision?.targetId ?? entry.candidates[0]!.id}
                        data-testid={`package-target-${entry.localSlug}`}
                        options={entry.candidates.map((c) => ({
                          value: c.id,
                          // 「别人的」要看得出来——它可以复用但**不能覆盖**。
                          label: c.owned ? c.name : `${c.name} (${t('resourcePackage.notYours')})`,
                        }))}
                        onChange={(v) =>
                          setDecisions((prev) => ({
                            ...prev,
                            [entry.localSlug]: { ...prev[entry.localSlug]!, targetId: v },
                          }))
                        }
                      />
                    </Field>
                  ) : null}
                </div>
              )
            })}
          </div>
        )
      ) : null}

      {phase === 'done' && receipt !== null ? (
        <div data-testid="package-import-report">
          <p>{t('resourcePackage.importedCount', { count: receipt.applied.length })}</p>
          <ul>
            {receipt.applied.map((a) => (
              <li key={a.opId}>
                {a.resourceType} · {a.name} · {a.action}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Dialog>
  )
}
