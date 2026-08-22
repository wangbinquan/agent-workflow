// Dev-only role fixtures behind the one-click login page (see ./server.ts).
//
// The four keys mirror the platform's role enum (shared/schemas/permission.ts
// `Role`). They are duplicated as plain strings on purpose: this package is
// test/dev infrastructure and does not depend on @agent-workflow/shared, and a
// role that disappears upstream must surface as a loud seed failure here rather
// than a silent type error in a package nobody builds.

import type { MockOidcUser } from '../types'

export type DevRoleKey = 'admin' | 'manager' | 'user' | 'guest'

export interface DevRoleSpec {
  /** Platform role written onto the seeded account. */
  readonly key: DevRoleKey
  /** Mock IdP subject — stable, so re-seeding rebinds the same account. */
  readonly sub: string
  /** Username the daemon derives from `preferred_username`. */
  readonly username: string
  readonly displayName: string
  readonly email: string
  /** Page copy. */
  readonly title: string
  readonly summary: string
}

export const DEV_ROLES: readonly DevRoleSpec[] = [
  {
    key: 'admin',
    sub: 'dev-role-admin',
    username: 'dev-admin',
    displayName: '[dev] 管理员 admin',
    email: 'dev-admin@dev.local',
    title: 'admin · 系统管理员',
    summary: '权限目录里的全部权限点，含 resource-acl:bypass 与用户管理。',
  },
  {
    key: 'manager',
    sub: 'dev-role-manager',
    username: 'dev-manager',
    displayName: '[dev] 资源管理员 manager',
    email: 'dev-manager@dev.local',
    title: 'manager · 资源管理员',
    summary: '普通用户权限 + 仓库/仓库组维护、tasks:read:all 等资源管理档。',
  },
  {
    key: 'user',
    sub: 'dev-role-user',
    username: 'dev-user',
    displayName: '[dev] 普通用户 user',
    email: 'dev-user@dev.local',
    title: 'user · 普通用户',
    summary: '默认基线：自建资源、跑任务，只看得见自己有权看的资源。',
  },
  {
    key: 'guest',
    sub: 'dev-role-guest',
    username: 'dev-guest',
    displayName: '[dev] 访客 guest',
    email: 'dev-guest@dev.local',
    title: 'guest · 访客',
    summary: '最小基线，用来验证「权限不足时界面到底长什么样」。',
  },
]

export function findDevRole(key: string): DevRoleSpec | undefined {
  return DEV_ROLES.find((role) => role.key === key)
}

/** The identity list handed to the mock IdP — one subject per platform role. */
export function devRoleMockUsers(): MockOidcUser[] {
  return DEV_ROLES.map((role) => ({
    sub: role.sub,
    email: role.email,
    name: role.displayName,
    preferredUsername: role.username,
    emailVerified: true,
  }))
}
