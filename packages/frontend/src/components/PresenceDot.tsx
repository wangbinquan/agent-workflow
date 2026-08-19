// RFC-312 —— 在线状态的唯一渲染原语。五处界面（用户管理页 / 署名 chip / 任务成员面板两个分支 /
// 工作组花名册）都用它，避免各写各的圆点。
//
// `online === undefined` 时**渲染 null**：未水化、无权限、或非真实用户 id 都走这一档，
// 于是没有 `users:presence` 的账号看到的界面与今天逐字节一致。

import { useTranslation } from 'react-i18next'

export interface PresenceDotProps {
  /** true = 在线；false = 离线；undefined = 未知（不渲染）。 */
  online: boolean | undefined
  className?: string
}

export function PresenceDot({ online, className }: PresenceDotProps) {
  const { t } = useTranslation()
  if (online === undefined) return null
  const label = online ? t('presence.online') : t('presence.offline')
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`presence-dot presence-dot--${online ? 'online' : 'offline'}${
        className ? ` ${className}` : ''
      }`}
    />
  )
}
