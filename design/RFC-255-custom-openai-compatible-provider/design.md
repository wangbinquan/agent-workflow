# RFC-255 · 受控自定义 OpenAI-compatible Provider 准入 — design

## 0. 结论综述

在受控 opencode 路径上开一条**平台构造**的 `provider` 通道：管理员配置存 daemon config
文件（掩码 API），运行时由平台把「选中的自定义 provider」编成受控 config 的 `provider`
段（无密钥）+ 把存储的 key 编成 `OPENCODE_AUTH_CONTENT` 严格条目；boot 后按准入值逐字节
校验报告面。端点因随受控 config 进入既有 identity digest 而自动冻结；key 不进任何 digest
输入，轮换安全。四个消费面（密封枚举 / 三个计划面 / launcher 准入 / 运行与 resume）共用
一个单一事实源模块。

## 1. opencode 侧机制依据（源码锚，1.18.x）

- 自定义 provider 是一等公民：config `provider.{id}` + `options.baseURL`（`endpoint` 优先）
  即可改端点 —— `packages/opencode/src/provider/provider.ts:355-358`；SDK 生效端点取
  `options.baseURL ?? model.api.url`（`provider.ts:1693-1714`，含 `${VAR}` 替换，见 R2）。
- config 定义模型的装配（`provider.ts:1435-1451`）：`api.npm` 解析链
  `model.provider?.npm ?? provider.npm ?? existingModel?.api.npm ?? modelsDev[id]?.npm ??
  "@ai-sdk/openai-compatible"`；`api.url` 解析链
  `model.provider?.api ?? provider.api ?? existingModel?.api.url ?? modelsDev[id]?.api ?? ""`
  —— 即 provider 级 `api` 字段直接决定报告面的 `model.api.url`。
- 凭据链：auth store（含 `OPENCODE_AUTH_CONTENT`，上游只 `JSON.parse` 不校验 ——
  `packages/opencode/src/auth/index.ts:60-64`）条目并入 provider（`provider.ts:1537`
  `source:"api"` 合并，config 段随后以 `source:"config"` 复盖合并，`provider.ts:1583-1590`），
  SDK 构造时 `options.apiKey === undefined && provider.key` 兜底注入（`provider.ts:1715`）。
- 危险面（本 RFC 必须保持不存在）：`model.api.npm` 不在 `BUNDLED_PROVIDERS` 时 opencode
  **运行时 `Npm.add` 下载实现包**（`provider.ts:1765-1780`）。
- `/config/providers` 响应不做密钥编辑：`toPublicInfo`（`provider.ts:1074-1088`）只过滤
  非法模型，`options` 与 `key` 原样返回 —— 该响应仅在 DirectClient loopback + basic auth
  私有面上被单次读取，平台侧禁止落日志（现行规范延续，见
  `verifiedLauncher.ts:300-302` 注释「without logging values」）。

## 2. 存储与 API（AC-1/2）

daemon config 文件（既有 `GET/PUT /api/config`，`loadConfig`/`applyConfigPatch`）新增顶层键：

```ts
// packages/shared —— 单一 schema 事实源（zod）
interface CustomProviderEntry {
  id: string        // ^[a-z0-9][a-z0-9._-]*$；互相唯一；不得命中内置目录 provider id
  name?: string     // 显示名，缺省用 id
  npm: '@ai-sdk/openai-compatible'   // closed enum；v1 唯一合法值（D1/D8）
  baseURL: string   // http(s):// 绝对 URL；无 "${"、无 \0、trim 后非空
  apiKey: string    // 非空、无 \0；write-only
  models: { id: string; name?: string }[]  // 非空；id 去重、非空、无 \0
  enabled: boolean
}
// config.customProviders?: CustomProviderEntry[]
```

- **掩码语义**：GET 一律返回 `apiKey: '••••••••'`（固定串常量）；PUT 收到该固定串或省略
  字段 → 保留存量；否则替换。掩码串本身被校验拒绝作为新 key 存入（防「掩码当真值」回环）。
- **id 与内置目录冲突**：校验依据是**密封模型枚举**（§4）结果里的 provider id 集（枚举缓存
  可得；无缓存时触发一次枚举）。与内置 id 同名会让 config 段**改写内置 provider 的端点**
  （opencode merge 语义，`provider.ts:1583-1590`）——一律拒绝，杜绝「anthropic 被静默指到
  私有网关」这类影子面。
- 权限：沿用 /api/config 既有 admin 权限点（D4，无新权限面）。
- at-rest 姿态：与 `mcps.config`（remote MCP `headers` 携带 Authorization）同为明文常态，
  文件 0600；`docs/audit-backlog.md` 增补统一加密未决项（非目标 §4）。

## 3. 单一事实源模块

新增 `packages/backend/src/services/runtime/opencode/customProvider.ts`：

- `findEnabledCustomProvider(cfg, providerID): CustomProviderEntry | undefined`
  —— 查找 + 全量结构校验（防手改 config 文件绕过 PUT 校验；不合法 = 视同不存在并记
  diagnostics）。
- `buildControlledProviderSection(entry)` —— 受控 config `provider` 段（**无 apiKey**，D5）：

```jsonc
{ "<id>": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "<name ?? id>",
    "api": "<baseURL>",                 // → 报告面 model.api.url（§1 解析链）
    "options": { "baseURL": "<baseURL>" }, // → SDK 生效端点；两处同源，报告面与生效面不可漂移
    "models": { "<modelID>": { /* name? */ } }
} }
```

- `buildCustomProviderAuth(entry): StrictProviderAuth` —— 从存储 key 构造
  `{"<id>":{"type":"api","key":<key>}}`，构造后仍过 `strictApiEntry` 同级断言（复用
  `hermetic.ts:149-161` 的校验函数，不是平行实现）。
- `customProvidersEnumerationConfig(cfg)` —— 全部 enabled 条目的合并 provider 段（枚举面用，
  同样无 key）+ 其 canonical 投影摘要（枚举缓存键分量）。

## 4. 四个消费面的接线

1. **密封模型枚举**（`models.ts:listOpencodeModelsHermetic`）：env 增加
   `OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: <§3 枚举段> })`；
   `cacheKey` 从 `binary` 变为 `binary + ':' + <投影摘要>`（AC-3 缓存失效）。
   `OPENCODE_AUTH_CONTENT` 维持 `'{}'` —— 枚举不需要凭据，枚举面零密钥。
2. **计划面 ×3**（`verifiedPlan.ts` / `verifiedSystemPlan.ts` / `verifiedMcpTestPlan.ts`）：
   `selectedModel.providerID` 命中 enabled 条目时 ——
   - `buildControlledOpencodeConfig` 新增可选入参 `customProvider?`，把 §3 单条 provider 段
     并入返回 config（**只注入选中的一个**，D7）；
   - 凭据改走 `buildCustomProviderAuth(entry)`，**不经过** `resolveStrictProviderAuth` 的
     env/auth.json 通道（机器态不再影响自定义 provider；`PROVIDER_API_KEY_ENV` 表不动）。
   未命中 → 现状路径逐字节不变。
3. **准入校验**（`verifiedLauncher.verifySelectedProviderInventory` 增可选入参
   `admittedCustom?`）：选中为自定义时追加——`source === 'config'`；
   `model.api.npm === entry.npm`；`model.api.url === entry.baseURL`（逐字节）；
   `selectedProvider.options.baseURL === entry.baseURL`；报告 `models` 键集 ⊆ 准入清单。
   任何不符 → 既有 `execution-identity-provider-untrusted`。行/模型的 exactKeys 键集清单
   **不变**（R1 用 fixture 锁定 config 模型形状确实满足）。
4. **运行 / resume**：provider 段在 `OPENCODE_CONFIG_CONTENT` 内 → 已被既有
   identityDigest / sessionContractDigest 覆盖（`buildHermeticServerEnv` →
   `canonicalizeIdentity`），端点或清单变更自然成为身份变更（AC-6）；key 不出现在 config、
   不进任何 digest 输入（D5）→ 轮换后 resume 身份不变。owner 冻结面无新增列、无迁移。

## 5. 与现有模块的耦合点

| 模块 | 变化 | 性质 |
| --- | --- | --- |
| `shared`（schema） | `CustomProviderEntry` + 校验纯函数 | 新增 |
| `@/config`（daemon config） | 新顶层键 + 掩码 GET/保留 PUT | 扩展 |
| `hermetic.ts` | `buildControlledOpencodeConfig` 可选 `customProvider` 入参 | 向后兼容扩展 |
| `models.ts` | 枚举注入 + cacheKey 掺摘要 | 扩展 |
| `verifiedPlan/SystemPlan/McpTestPlan` | provider 命中分支 + 凭据分支 | 扩展 |
| `verifiedLauncher.ts` | `admittedCustom` 追加校验 | 扩展 |
| `PINNED_BUNDLED_PROVIDER_NPM` / `assertBundledProviderImplementation` | **不动**（D8） | 不变 |
| 前端 Settings / picker | CRUD 表单 + 模型正常入列 | 新增/零特判 |
| 失败码词汇表 | **不新增码**（§6） | 不变 |

## 6. 失败模式

| 场景 | 行为 |
| --- | --- |
| 保存：id 冲突 / 正则不合 / URL 带 `${` / 清单空 / key 空 | PUT 400 结构化 ValidationError（`config-custom-provider-*` 错误码，i18n 双语） |
| 发起：条目被禁用 / 删除 | 计划面命中失败 → 落回既有三通道 → `execution-identity-auth-invalid`（语义成立：该 provider 无已验证凭据）。i18n `__hint` 补一句「若为自定义 provider，请检查其启用状态」 |
| 运行中网关不可达 / 5xx / 流中断 | 上游 provider 错误 → 既有 `execution-identity-stream-failed` 语义与重试策略，不新增码 |
| 报告面漂移（url / npm / source / 模型超集） | `execution-identity-provider-untrusted`（§4.3） |
| 手改 config 文件塞非法条目 | `findEnabledCustomProvider` 全量校验判不存在 + diagnostics 记录（不 crash、不静默采用） |
| 枚举面：禁用条目 | 模型从 picker 消失（缓存键随投影变化） |

## 7. 风险与验证锚点

- **R1 config 模型的报告形状**：`verifySelectedProviderInventory` 对模型行做 exactKeys
  （`cost/limit/status/options/headers/release_date` 等必填，`verifiedLauncher.ts:340-370`）。
  config 定义模型由 opencode 以缺省值补齐这些字段（§1 装配链下方的 Model 构造）——必须用
  **qualified 二进制的行为 fixture 实测锁定**（T4）；若未来版本缺字段，按 RFC-227 版本中立
  原则显式调整 optional 集（deliberate act，禁止静默放宽）。
- **R2 `${}` 变量替换注入**：opencode 对生效 URL 做 `${VAR}` env 替换（`provider.ts:1704-1710`）。
  baseURL 校验禁 `${`（AC-1），杜绝「baseURL 携带替换符探测密封 env」这一面。
- **R3 loopback / 内网网关连通性**：outer server 面本就允许网络（受控边界只对 local MCP /
  shell 子进程断网，RFC-227 §5）；Linux bwrap outer 不 `--unshare-net`、macOS Seatbelt 走
  network allow —— e2e 用 `127.0.0.1` stub 网关直接证明（T7），两 OS 各跑一次。
- **R4 掩码回环**：AC-2 的保留语义 + 「掩码串不可作为新值」双向锁，测试覆盖读-改-写回环。
- **R5 并发 RFC 面**：与 RFC-253（scheduler/脚本）、RFC-254（Windows）文件交集小
  （本 RFC 不触碰 runner 进程治理与 CI 矩阵）；提交前 rebase、按 CLAUDE.md 并发保留原则处理。
- **R6 与既有 auth-invalid 语义的相容**：自定义 id 走新分支后，`resolveStrictProviderAuth`
  的三通道对**内置** provider 行为逐字节不变（回归测试锁定）。

## 8. 测试策略（随实现落地，无后补档）

- **shared**：schema 正/反 ≥20 例（正则 / 唯一 / 内置冲突 / URL 协议 / `${` / NUL / 清单
  去重 / 掩码串拒收）。
- **backend 纯函数**：受控段构造快照（含「`api` 与 `options.baseURL` 同源」断言）；
  `buildCustomProviderAuth` 产物过 `strictApiEntry`；`OPENCODE_CONFIG_CONTENT` 构造结果
  `includes(apiKey) === false` 文本级断言（AC-3/6 锁）；identity 投影不含 key；
  launcher 追加校验正/反全组合（url 漂移 / npm 漂移 / source 漂移 / 模型超集 / 缺 provider）；
  内置 provider 三通道回归（R6）。
- **行为 fixture（gated，qualified 二进制）**：注入 config provider →
  `/config/providers` 报告过 `verifySelectedProviderInventory`（R1 锁）。
- **枚举**：含 custom 模型 / 禁用消失 / cacheKey 随投影变化 / 枚举 env 无 key。
- **e2e（gated）**：`127.0.0.1` OpenAI-compatible stub（chat/completions 流式最小实现）→
  业务节点全链路绿；key 轮换后 resume 绿；baseURL 变更后 resume 拒；system / MCP-test 面
  各一条冒烟。
- **前端**：Settings CRUD（复用 `Dialog` / `Field` / `TextInput` / `ChipsInput` / `Switch` /
  `Select` 公共组件，遵守 CLAUDE.md 前台一致性强制原则）、掩码回显、i18n 中英、picker 出现
  自定义模型；RTL 以 role 断言为主。
