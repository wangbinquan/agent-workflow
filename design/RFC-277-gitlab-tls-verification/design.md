# RFC-277 · 技术设计

状态：In Progress（2026-08-10，功能与定向验证已完成；全仓门禁等待并行 RFC-276 收口）。产品与安全边界见
[`proposal.md`](./proposal.md)。

## 1. 当前源码事实

| 事实                                                    | 源码                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| wire / PUT / test 契约没有 TLS 字段                     | `packages/shared/src/schemas/codeHost.ts`                                       |
| 每 provider 一行，resolve 只返回 provider/baseUrl/token | `packages/backend/src/services/codeHost/connections.ts`                         |
| 探活直接调用 Bun `fetch`                                | `packages/backend/src/services/codeHost/connections.ts#probeCodeHostConnection` |
| 实际节点首跳直接调用 Bun `fetch`                        | `packages/backend/src/services/codeHost/call.ts#executeCodeHostCall`            |
| DB 当前没有 TLS 列                                      | `packages/backend/src/db/schema.ts#codeHostConnections`、migration 0140         |
| 设置卡片已有 base URL/token/save/test/remove            | `packages/frontend/src/components/settings/CodeHostsSection.tsx`                |
| 公共 toggle 已存在                                      | `packages/frontend/src/components/Form.tsx#Switch`                              |

Bun 1.3 类型把 `tls` 定义在 `BunFetchRequestInit` 上，官方请求形态为：

```ts
fetch(url, { tls: { rejectUnauthorized: false } })
```

## 2. 数据与 API 契约

### 2.1 DB

在实施时从 live journal 分配下一条 migration（当前候选 0143），只追加：

```sql
ALTER TABLE `code_host_connections`
ADD COLUMN `reject_unauthorized` integer NOT NULL DEFAULT 1
CHECK (
  `reject_unauthorized` IN (0, 1)
  AND (`provider` = 'gitlab' OR `reject_unauthorized` = 1)
);
```

Drizzle schema 使用 `integer('reject_unauthorized', { mode: 'boolean' }).notNull().default(true)`。
不得追改 migration 0140。同步 journal 与 migration-count / rolling-upgrade / schema-admission 锁。

### 2.2 shared schema

- `CodeHostConnectionWireSchema` 新增必填 `rejectUnauthorized: z.boolean()`；
- `UpsertCodeHostConnectionSchema` 新增可选布尔字段；
- `TestCodeHostConnectionSchema` 新增可选布尔字段。

请求字段可选保证旧客户端兼容；响应字段必填让前端不需要猜默认值。

### 2.3 service

`ResolvedCodeHostConnection` 与 `UpsertInput` 增加 `rejectUnauthorized`。统一归一化规则：

```text
GitLab first insert + omitted -> true
GitLab existing + omitted     -> existing value
GitLab explicit boolean       -> that value
GitHub false                  -> ValidationError
GitHub true/omitted           -> true
```

`unconfigured`、`toWire`、`resolve`、`upsert` 共享上述结果，避免 UI 与执行器各自设默认。

## 3. 请求装配

定义 backend-local `CodeHostFetchInit = BunFetchRequestInit` / 对应 `FetchLike`，使注入式测试可以
观察 Bun 的 `tls` 扩展而不使用 `as any`。

单一 helper 生成首跳 TLS 片段：

```ts
function codeHostTlsInit(connection): Pick<BunFetchRequestInit, 'tls'> {
  return connection.provider === 'gitlab' && !connection.rejectUnauthorized
    ? { tls: { rejectUnauthorized: false } }
    : {}
}
```

该 helper 由探活与实际执行器共同使用，或放在无状态小模块中供两处复用。要求：

- 默认 `true` 时完全省略 `tls`，保留 Bun 默认；
- 重试复用同一首跳 init；
- 认证剥离后的 redirect fetch 重新构造 init，不合入该 TLS 片段。

## 4. 路由语义

### PUT

路由把可选字段原样交给 service；provider 限制由 service 负责，任何内部调用也绕不过。

### test

候选值为：

```text
baseUrl            = body.baseUrl ?? stored?.baseUrl
token              = body.token ?? stored?.token
rejectUnauthorized = body.rejectUnauthorized ?? stored?.rejectUnauthorized ?? true
```

GitHub false 在发请求前拒绝。调用 `probeCodeHostConnection` 时传完整候选值。回写 `lastTest` 的
等值判据从两字段扩成三字段。

## 5. 前端状态

`Draft` 增加 `rejectUnauthorized`，初始化自 wire。仅 `row.provider === 'gitlab'` 渲染：

```tsx
<Switch
  checked={draft.rejectUnauthorized}
  onChange={(next) => setDraft((d) => ({ ...d, rejectUnauthorized: next }))}
  label={t('codeHostSettings.rejectUnauthorized')}
  hint={t('codeHostSettings.rejectUnauthorizedHint')}
/>
```

save 与 test body 都携带该值；remove 后草稿重置为 `true`；unconfigured fallback 也为 `true`。
复用公共组件、既有 spacing 与 busy disabled，不新增 CSS。

## 6. 失败与安全分析

| 场景                      | 结果                                                       |
| ------------------------- | ---------------------------------------------------------- |
| migration 未应用          | RFC-275 schema admission 拒绝 boot，不进入半工作状态       |
| 老客户端省略字段          | 新建默认 true；更新保留旧值                                |
| GitHub 伪造 false         | 422，绝不静默忽略                                          |
| false + token 错          | TLS 可建立后仍按 401/403 分类                              |
| false + 中间人            | 无法由 TLS 发现；UI 明示风险，这是管理员显式接受的能力影响 |
| 测草稿 false、保存仍 true | 探活结果不回写已保存行                                     |
| 第三方重定向              | 不继承 false，也不携认证头                                 |

## 7. 测试矩阵

### shared / migration

- 三个 schema 的 true/false/省略/strict unknown-key；
- fresh replay 与旧 0142 fixture 升级默认 true；
- DB CHECK 拒绝非 0/1 及 GitHub false；journal count 与 RFC-275 manifest。

### backend connection

- PUT false → DB/wire/resolve false；省略更新保留 false；默认 true；
- GitHub false 422；
- probe false 精确看到 TLS init，true/omitted 无 override；
- test 草稿三字段回写/不回写矩阵；
- token 不因新增字段出现在响应或错误中。

### backend execution

- GitLab false 首跳与网络/5xx 重试都携 override；
- GitLab true 与 GitHub无 override；
- redirect follow 无认证头且无 override。

### frontend

- GitLab 有公共 Switch、GitHub 无；默认/已存值正确；
- toggle 后 save/test body 精确带 false；
- remove 重置 true；中英文风险文案与 key 对称。

## 8. 实施门

- 实施前重读 live migration head 与上述精确路径，确认并发 RFC-276 未改变调用链；
- 精确路径改动，不回滚共享树 WIP；
- 定向测试先红后绿；
- 完整 `bun run gate:local`；
- Codex implementation gate 与 TLS 反向变异：删除 TLS 片段后相关测试必须红；
- 未经用户另行授权，不 commit / push。
