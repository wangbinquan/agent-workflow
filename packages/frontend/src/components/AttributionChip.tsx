// RFC-099 (D7) — "displayName（角色）" attribution chip shown next to review
// comments / decisions and clarify answers. Pure display: the identity it
// renders lives in audit columns only and never reaches agent prompts.
//
// Fallbacks:
//   - userId 'local' / null  → 本地用户（历史）  (pre-multi-user rows)
//   - unresolvable id        → shortened id (user row deleted)

import { useTranslation } from 'react-i18next'
import { PresenceDot } from '@/components/PresenceDot'
import { usePresenceOf } from '@/hooks/usePresence'
import type { UserPublic } from '@agent-workflow/shared'

// RFC-222 — 'manager' added: a resource admin acting on a task is attributed
// truthfully (not folded into admin). Kept aligned with shared TaskActorRole.
export type AttributionRole = 'owner' | 'user' | 'admin' | 'manager' | null | undefined

interface AttributionChipProps {
  userId: string | null | undefined
  role?: AttributionRole
  /** Resolved public row from useUserLookup (undefined while loading / unknown). */
  user?: UserPublic | undefined
  /** Optional verb prefix, e.g. t('attribution.submittedBy') → "由 X（角色）提交". */
  className?: string
}

export function AttributionChip({ userId, role, user, className }: AttributionChipProps) {
  const { t } = useTranslation()
  // RFC-312 —— 历史行（null / 'local' / '__system__'）由 usePresenceOf 的哨兵表返回 undefined。
  // 但那张表只认哨兵值：**一个形态正常却查不到的 id**（lookup 尚未解析、或用户已被删除）
  // 拿到的是 `false`，于是会给一个可能不存在的人画上"离线"点——实现门 P2 指出的正是这个。
  // 判据用 `user`：五个调用点都从 lookup map 传它，未解析即 undefined ⇒ 传 undefined 进去，
  // 得到"未知"而不是"离线"，与本组件"未知就不渲染任何东西"的既有契约一致。
  const presence = usePresenceOf(user === undefined ? undefined : userId)
  const isLegacy = userId === null || userId === undefined || userId === 'local'
  const name = isLegacy ? t('attribution.localHistoric') : (user?.displayName ?? shortenId(userId))
  const roleLabel =
    role === 'owner'
      ? t('attribution.role.owner')
      : role === 'user'
        ? t('attribution.role.user')
        : role === 'admin'
          ? t('attribution.role.admin')
          : role === 'manager'
            ? t('attribution.role.manager')
            : null
  return (
    <span className={`chip chip--tight attribution-chip${className ? ` ${className}` : ''}`}>
      <PresenceDot online={presence} />
      {name}
      {roleLabel !== null && (
        <span className={`attribution-chip__role attribution-chip__role--${role}`}>
          {roleLabel}
        </span>
      )}
    </span>
  )
}

function shortenId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
}
