# RFC-443 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`。以 RFC-442 落地后的源码（`9c1a6f2a9`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：identity-access 的现址 `S/auth/oidc/`（尚未并入 `modules/identity-access`）。
- **承担的演进**：W4 B / D 第九步。import `services/` 的路由 12 → 10；`auth/` 不再 import `services/`（`no-auth-to-services` 连类型边也清零）。
- **不新增** DAG 之外的边、R1 边与 R2 边：`providers.ts` 对 identity-access 仍只经 `public/operations`；`S/auth/` 不是模块路径，也不在
  legacy 目标前缀里。
- **留下的债**：`S/auth/` 整体并入模块；其余 10 个路由。
- **偏离项**：无。

## 1. 文件去向

| 原文件                            | 新位置                        | 说明     |
| --------------------------------- | ----------------------------- | -------- |
| `S/services/oidcProviders.ts`     | `S/auth/oidc/providers.ts`    | 原样搬迁 |
| `S/services/oidc/provisioning.ts` | `S/auth/oidc/provisioning.ts` | 原样搬迁 |

## 2. 连接（只改 import，调用不变）

- `routes/oidc.ts`、`bootstrap/daemonHttpComposition.ts` → `@/auth/oidc/providers`。
- `routes/oidc-auth.ts` → `@/auth/oidc/provisioning`；`auth/oidc/identity.ts` → `./provisioning`。
- `auth/oidc/discovery.ts` 注释里的旧路径一并改。

## 3. 守卫与用例

- **改 import 的用例**：九个后端用例（`rfc220-*`、`rfc221-*`、`oidc-providers-service`、`rfc312-default-grant`）与 shared 的
  `oidc-provisioning` 用例。
- **RFC-305 架构锁**：identity-access 的模块外消费者清单里，`services/oidcProviders.ts -> …/public/operations` 改为
  `auth/oidc/providers.ts -> …/public/operations`（按字典序挪位，行数不变）。
- **架构报告**：legacy 归属表的两个 `services/` 文件改登记为 `auth/oidc/` 下的新路径，仍归 identity-access。
- **新用例** `T/rfc443-oidc-into-auth.test.ts`：原文件与 `services/oidc/` 目录不存在、新文件就位；源码里没有文件 import 旧路径
  （带负对照）；两个路由不 import `services/`；`auth/` 下没有任何对 `services/` 的 import（含类型）。
- **行为由既有用例覆盖**：提供方服务、OAuth2 回调路由、登录策略、开通决策六分支、邮箱信任与探测。

## 4. 账本与计数（实测为准）

- `commons-debt.json`、`guard-manifest.json`（RFC-305 锁行数不变）、`counts.json`：不变。
- 注释：前端 `settings.tsx` 一处、e2e 三个文件里的旧路径改指新位置，行号不变。

## 5. 失败模式

- **漏改引用**：tsc、依赖规则与新用例的「旧路径零引用」兜底；shared 的用例走相对路径，靠 shared 测试覆盖。

## 6. 测试策略

全部实现与用例写完后集中验证一次：静态检查；全量 SQLite（含 shared 的相关用例）；导出仓库（含 PostgreSQL 真库）跑全部架构测试与受影响用例；
P0 变异 lane。
