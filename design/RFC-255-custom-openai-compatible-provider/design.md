# RFC-255 · 受控自定义 OpenAI-compatible Provider 准入 — design

> 2026-08-04 设计门后修订版；逐条折入见 `design-gate-2026-08-04.md`（1 P0 + 5 P1 + 8 P2 +
> 9 遗漏面，全部折入零驳回）。

## 0. 结论综述

在受控 opencode 路径上开一条**平台构造**的 `provider` 通道：管理员配置存 daemon config
文件（apiKey 以 secretBox 密封、任何出站面掩码），运行时由平台把「选中的自定义 provider」
编成受控 config 的 `provider` 段（无密钥、无显示名）+ 把解封的 key 编成
`OPENCODE_AUTH_CONTENT` 严格条目；boot 后按 `manifest.expectedConfig.provider` 同源推导
的准入值逐字节校验报告面。端点因随受控 config 进入计划面 identityDigest 而自动冻结；
key 与显示名都不进 digest 输入，轮换/改名均不破坏 resume。四个消费面（密封枚举 / 三个
计划面 / launcher 准入 / 运行与 resume）共用一个单一事实源模块。

## 1. opencode 侧机制依据（源码锚，1.18.x；设计门经源码 + 1.18.8 行为探针复核）

- SDK 生效端点取 `options.baseURL ?? model.api.url`（`packages/opencode/src/provider/provider.ts:1693-1695`），
  随后对 URL 做 varsLoader 与 env `${VAR}` 替换（`provider.ts:1698-1710`，见 R2）。
- config 定义模型的装配（`provider.ts:1434-1451`）：`api.npm` 解析链
  `model.provider?.npm ?? provider.npm ?? existingModel?.api.npm ?? modelsDev[id]?.npm ??
  "@ai-sdk/openai-compatible"`；`api.url` 解析链
  `model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelsDev[id]?.api ?? ""`
  —— provider 级 `api` 字段直接决定报告面的 `model.api.url`。
- 凭据链：auth store（含 `OPENCODE_AUTH_CONTENT`，上游只 `JSON.parse` 不校验 ——
  `packages/opencode/src/auth/index.ts:59-63`）条目并入 provider（`provider.ts:1530-1541`
  `source:"api"` + key；config 段随后 re-apply 为 `source:"config"`，partial 只含
  source/env/name/options，**key 保留**——`provider.ts:1583-1590`、merge 语义 `:1365-1376`），
  SDK 构造时 `options.apiKey === undefined && provider.key` 兜底注入（`provider.ts:1715`）。
- 危险面（本 RFC 必须保持不存在）：`model.api.npm` 不在 `BUNDLED_PROVIDERS`
  （`provider.ts:1765` 查表；`@ai-sdk/openai-compatible` 在表内 `provider.ts:117`）时
  opencode **运行时 `Npm.add` 下载实现包**（`provider.ts:1780`），`file://` npm 串还可
  直接 dynamic import（`:1777-1779`）——npm 由 closed enum 挡死，两个面按构造不可达。
- `/config/providers` 响应不做密钥编辑：`toPublicInfo`（`provider.ts:1074-1088`）原样带
  `options` 与 `key`（server handler `handlers/config.ts:24-30`）。该响应仅在 DirectClient
  loopback + basic auth 私有面上被单次读取（`verifiedLauncher.ts:1144`），失败面是闭集
  失败码 + JSON pointer、不回显值（`:298-301` 注释）。
- **枚举注入实测成立**（设计门行为探针，1.18.8）：密封 env + `OPENCODE_AUTH_CONTENT='{}'`
  下注入 `OPENCODE_CONFIG_CONTENT={"provider":{…}}`，`opencode models` 输出含自定义模型
  （instance config 合并 `config/config.ts:468-476` → `cli/cmd/models.ts:33-34`）；
  **零凭据即可枚举**。同一探针证实：**零凭据下目录 provider 不出现**（只见 `opencode/*`
  免费档）——见 §2 冲突校验与 dev-gotchas 沉淀项。

## 2. 存储与 API（AC-1/2）

daemon config 文件（既有 `GET/PUT /api/config`，`config/index.ts` `loadConfig`/
`applyConfigPatch`/`previewConfigPatch`）新增顶层键 `customProviders`。

**三形状显式分离**（设计门 P1-2）：

```ts
// packages/shared —— wire 形状（GET/PUT 皆用；掩码合法、apiKey 可省略）
interface CustomProviderEntryWire {
  id: string        // ^[a-z0-9][a-z0-9._-]*$；互相唯一（仅按 id，不做 URL 归一化——P2-8）
  name?: string     // 显示名，仅枚举/picker 用；不进运行段（P2-2）
  npm: '@ai-sdk/openai-compatible'   // closed enum；v1 唯一合法值（D1/D8）
  baseURL: string   // http(s):// 绝对 URL；无 "${"、无 \0、trim 后非空
  apiKey?: string   // 省略或等于掩码串 ⇒ 保留存量；否则为新值（掩码串不得作为新值存入）
  models: { id: string; name?: string }[]  // 非空；id 去重、非空、无 \0
  enabled: boolean
}
// backend 存储形状：apiKey 为 secretBox 密封串（sealed:v1:… 形态，非明文非掩码）
// backend 出站变换 maskConfigForOutput：apiKey → 固定掩码串 '••••••••'
```

- **掩码与保留语义**（P1-2/P1-3）：
  - 出站：`maskConfigForOutput` 覆盖 **GET 响应、PUT 响应（`routes/config.ts` 现状
    `c.json(updated)` 回全量——必须过同一变换）、CLI `config get`**。
  - 入站（PUT 语义门，不进共享 schema）：按 `id` 配对——省略/掩码 ⇒ 保留存量密封值；
    新串 ⇒ secretBox 密封后替换；**新条目或改 id（视同新条目）必须携带真 key**；掩码串
    作为新值被拒。
  - CLI `config set` 与路由**共用同一套语义纯函数**（校验 + 保留合并 + 密封），不留旁路。
- **密钥 at-rest**（P1-4，v1 即做）：apiKey 用 `auth/secretBox.ts`（RFC-036 AES-256-GCM，
  与 OIDC client_secret 同一平台密钥 `ensureSecretKey`）密封落盘；计划面构造凭据时解封。
  `saveConfigRaw` 补 `writeFileSync(..., {mode:0o600})` + 存量文件 chmod（现状无 mode，
  实为 0644——orig 设计的「0600」声明系事实错误，已订正）。备份面：config 文件若入备份包，
  携带的是密封值（T2 验证备份路径并记档姿态）。
- **id 与内置目录冲突（双层校验，P0-1）**：
  - **静态快照集**即时拒绝：`PROVIDER_API_KEY_ENV` 全部键 ∪ pinned 目录 id 快照
    （anthropic/openai/google/azure/bedrock 系等，shared 常量、显式维护）。
  - **canary 探针**（仅新增/改 id 时）：向密封枚举注入
    `{provider:{<候选id>:{models:{__aw_canary__:{}}}}}`——输出该 id 下**非恰好一个**
    canary 模型 ⇒ 存在目录继承 ⇒ 目录 id ⇒ 拒绝。依据：零凭据下目录 provider 不进
    枚举（§1 探针），直接拿枚举结果当全集**无效**；canary 借目录继承机制
    （`provider.ts:1428,1450`）反向探测。
  - 探针不可用（枚举失败/超时）⇒ 可指认错误（不泛化 500）；禁用/改 key/改清单不触发
    探针（P2-3）。
  - 语义依据：与内置 id 同名的 config 段会**改写内置 provider 端点并继承其全部目录模型**
    （`provider.ts:1583-1590,1428`，设计门实测 18 个 anthropic 模型挂网关 url）——必须
    按构造防绝，「anthropic 被静默指到私有网关」不允许存在。
- 权限：沿用 /api/config 既有 admin 权限点（D4，无新权限面）。

## 3. 单一事实源模块

新增 `packages/backend/src/services/runtime/opencode/customProvider.ts`：

- `findCustomProvider(cfg, providerID): { entry, enabled } | undefined`
  —— 查找 + 全量结构校验（防手改 config 文件绕过 PUT 校验；不合法 = 视同不存在并记
  diagnostics）。**返回禁用态**，供计划面显式判定（§4.2/§6）。
- `buildControlledProviderSection(entry)` —— 运行段（**无 apiKey、无 name**——name 进
  digest 会让改显示名破 resume，P2-2）：

```jsonc
{ "<id>": {
    "npm": "@ai-sdk/openai-compatible",
    "api": "<baseURL>",                    // → 报告面 model.api.url（§1 装配链）
    "options": { "baseURL": "<baseURL>" }, // → SDK 生效端点；两处同源，报告面=生效面
    "models": { "<modelID>": {} }
} }
```

- `buildCustomProviderAuth(entry, unseal): StrictProviderAuth` —— 解封存储 key 构造
  `{"<id>":{"type":"api","key":<key>}}`，构造后仍过 `strictApiEntry` 同级断言（复用
  `hermetic.ts:149-161`，不是平行实现）。
- `customProvidersEnumerationConfig(cfg)` —— 全部 enabled 条目的合并 provider 段
  （**带 name** 供 picker 显示、无 key）+ canonical 投影摘要（枚举缓存键分量）。
- `admittedCustomFromExpectedConfig(expectedConfig)` —— 从受控 config 的 `provider` 段
  反推准入值供 launcher 校验（§4.3；与注入值按构造同源）。

## 4. 四个消费面的接线

1. **密封模型枚举**（`models.ts:listOpencodeModelsHermetic`）：env 增加
   `OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: <§3 枚举段> })`；缓存改**两级键**
   `binary → 投影摘要`（单 Map 无界增长——P2-6；`evictOpencodeModelsCache` 按 binary 级
   整体逐出）。`OPENCODE_AUTH_CONTENT` 维持 `'{}'`——枚举面零密钥（§1 探针证实可行）。
2. **计划面 ×3**（`verifiedPlan.ts` / `verifiedSystemPlan.ts` / `verifiedMcpTestPlan.ts`）：
   `findCustomProvider(cfg, selectedModel.providerID)` 三态判定——
   - **enabled**：`buildControlledOpencodeConfig` 新增可选入参 `customProvider?` 并入
     返回 config（**只注入选中的一个**，D7）；凭据走 `buildCustomProviderAuth`，**不经过**
     `resolveStrictProviderAuth`（机器态不影响自定义 provider；`PROVIDER_API_KEY_ENV` 不动）。
   - **disabled**：立即 `executionIdentityFailure('execution-identity-custom-provider-disabled')`
     （新码，见 §6——**不得** fall-through，P1-1）。
   - **absent**：现状路径逐字节不变（真目录 provider 走三通道）。
3. **准入校验**（`verifiedLauncher.verifySelectedProviderInventory`）：launcher 侧从
   `manifest.expectedConfig.provider`（`admittedCustomFromExpectedConfig`）推导准入值
   （**零新 manifest 字段**，与注入值天然同源——P1-5；T4 验证 manifest codec 对
   expectedConfig 新键的兼容），选中为自定义时追加——`source === 'config'`；
   `model.api.npm === entry.npm`；`model.api.url === entry.baseURL`（逐字节，不归一化）；
   `selectedProvider.options.baseURL === entry.baseURL`；报告 `models` 键集 ⊆ 准入清单。
   任何不符 → 既有 `execution-identity-provider-untrusted`。**⊆ 检查是不可放宽的安全锁**
   （P0-1 次生面：冲突条目会让它全红——正确反应是修条目，不是放宽检查）。行/模型的
   exactKeys 键集清单不变（R1 fixture 锁定）。
4. **运行 / resume**：受控 config（含 provider 段）进计划面
   `businessOpencodeIdentityDigest`（`verifiedPlan.ts:649-655`，`executionIdentity.ts:174-227`
   整份 config 参与哈希；system plan 同构 `verifiedSystemPlan.ts:214-220`），resume 与
   `owner.identityDigest` 比对（`verifiedPlan.ts:668`）⇒ baseURL/npm/模型清单变更即身份
   变更。**注意机制表述**（P2-1 订正）：哈希发生在计划面，不在 `buildHermeticServerEnv`
   （那里的 `canonicalizeIdentity` 仅校验、显式不采用其序列化，`hermetic.ts:558-564`）；
   `sessionContractDigest` **不含** config（`verifiedPlan.ts:636-648`）。key 只进
   `serverEnv.OPENCODE_AUTH_CONTENT`（`hermetic.ts:565`），serverEnv 不参与任何 digest ⇒
   轮换安全（D5）；`name` 不进运行段 ⇒ 改名安全（P2-2）。owner 冻结面无新增列、无迁移。

## 5. 与现有模块的耦合点

| 模块 | 变化 | 性质 |
| --- | --- | --- |
| `shared`（schema） | `CustomProviderEntryWire` + 校验纯函数 + 静态目录快照集 + 新失败码入 `EXECUTION_IDENTITY_FAILURE_CODES` | 新增/扩展 |
| `@/config` | 新顶层键 + secretBox 密封 + 0600 + `maskConfigForOutput`（GET/PUT/CLI 三面）+ PUT 语义门 | 扩展 |
| `cli/config-cli.ts` | `config get` 掩码、`config set` 走共用语义门 | 扩展（堵旁路） |
| `hermetic.ts` | `buildControlledOpencodeConfig` 可选 `customProvider` 入参 | 向后兼容扩展 |
| `models.ts` | 枚举注入 + 两级缓存键 + canary 探针复用入口 | 扩展 |
| `verifiedPlan/SystemPlan/McpTestPlan` | 三态判定分支 + 凭据分支 | 扩展 |
| `verifiedLauncher.ts` | expectedConfig 推导 + 追加校验 | 扩展 |
| `PINNED_BUNDLED_PROVIDER_NPM` / `assertBundledProviderImplementation` | **不动**（D8） | 不变 |
| 失败码词汇表 | **+1**：`execution-identity-custom-provider-disabled`（P1-1）——同步 shared 闭集、前端 zod、双语 i18n、全部棘轮测试（taxonomy / i18n-phase-b / rfc203 系） | 扩展 |
| 前端 Settings / picker | CRUD 表单 + 掩码回显 + 模型入列 + unknown provider 渲染兜底 | 新增 |

## 6. 失败模式（设计门 P1-1 后重写）

| 场景 | 行为 |
| --- | --- |
| 保存：id 命中静态快照集 / canary 探针检出目录 id | PUT 400，错误码区分 `config-custom-provider-id-reserved` / `-id-catalog`（i18n 双语） |
| 保存：正则不合 / 互相重复 / URL 带 `${` / 清单空 / 新条目缺真 key / 掩码当新值 | PUT 400 `config-custom-provider-*` 结构化 ValidationError（棘轮测试同步——`rfc203-validation-copy` 等） |
| 保存：canary 探针不可用（二进制缺失/枚举失败） | 可指认错误（仅阻断新增/改 id；禁用、改 key、改清单不受影响——P2-3） |
| 发起：条目 **disabled** | 计划面立即 `execution-identity-custom-provider-disabled`（新码；hint：启用该 provider 或更换模型） |
| 发起：条目已**删除** | 计划面 absent → 走既有三通道：通常 `auth-invalid`；若宿主 auth.json 残留该 id 的 api 条目则 plan 通过、boot 后 `provider-untrusted`（两分支都在 hint 覆盖内——`provider-untrusted` 的 i18n hint 增补「若为自定义 provider，请检查其配置与启用状态」） |
| 运行中网关不可达 / 5xx / 流中断 | 上游 provider 错误 → 既有 `execution-identity-stream-failed` 语义与重试策略 |
| 报告面漂移（url / npm / source / 模型超集） | `execution-identity-provider-untrusted`（§4.3 安全锁） |
| 手改 config 文件塞非法条目 | `findCustomProvider` 全量校验判不存在 + diagnostics（不 crash、不静默采用） |
| 枚举面：禁用条目 | 模型从 picker 消失（缓存键随投影变化） |
| 存量引用残留（agent profile / 节点 override 里的 `<id>/<model>`） | 模型引用是自由文本（workflow YAML 与 agent 保存均**不校验**模型合法性——设计门核实为既有事实，记档防重查）；前端对 unknown provider 原样字符串渲染（T8 RTL 锁定不空白） |

**多 runtime 语义**：customProviders 对**所有 opencode-kind runtime** 的枚举与计划面生效；
R1 fixture 只锁 admin 所选 qualified 二进制，fork 二进制若改 provider 装配语义由行为资格
兜底（与现状一致）。

## 7. 风险与验证锚点

- **R1 config 模型的报告形状**：`verifySelectedProviderInventory` 模型行 exactKeys 11 必填
  （`verifiedLauncher.ts:343-358`）。设计门核实 config 模型经 `provider.ts:1445-1502` 补齐
  全部必填字段（上游 schema `limit`/`family` optional 处 `provider.ts:1025-1044`）——仍须
  **qualified 二进制行为 fixture 锁定**（T4）；上游漂移时按 RFC-227 版本中立原则显式调整。
- **R2 `${}` 变量替换注入**：生效 URL 会做 env `${VAR}` 替换（`provider.ts:1698-1710`）。
  baseURL 校验禁 `${`。
- **R3 loopback / 内网网关连通性**：`--unshare-net` 仅存在于 child wrapper 与 FFF 探针
  （`sealedSubprocess.ts:825,1034`、`fffCapability.ts:363`）；runner 外层 `networkDeny`
  仅 RFC-253 script 节点设置（`scheduler.ts:3955`），opencode 计划不设 → outer server 有网。
  e2e 用 `127.0.0.1` stub 直接证明（T7，双 OS；macOS Seatbelt outer network-allow 以 e2e
  实测补齐设计门未逐行验证的半边）。
- **R4 掩码回环**：三形状 + PUT 语义门 + 「掩码不得为新值」双向锁；测试覆盖
  GET→改→PUT 全回环与 PUT 响应掩码。
- **R5 canary 假阴性**：目录 provider 若全部模型被 status 过滤（alpha/deprecated）会伪装成
  非目录 id——静态快照集兜底大头；fixture 里放一个已知目录 id 的 canary 阴性断言。
- **R6 与既有 auth-invalid 语义相容**：absent 分支对**内置** provider 行为逐字节不变
  （回归锁定）。
- **R7 并发 RFC 面**：与 RFC-253（scheduler/脚本）、RFC-254（Windows）文件交集小；提交前
  rebase 并按并发保留原则处理。

## 8. 测试策略（随实现落地，无后补档）

- **shared**：wire schema 正/反 ≥24 例（正则 / 唯一 / 静态快照拒绝 / URL 协议 / `${` /
  NUL / 清单去重 / 掩码语义 / 新条目缺 key）；新失败码入闭集的棘轮全套同步
  （`rfc224-execution-identity-failure-taxonomy` / `i18n-phase-b` / `rfc203-validation-copy`）。
- **backend 纯函数**：运行段构造快照（含「`api` 与 `options.baseURL` 同源」「无 name 无 key」
  断言）；`buildCustomProviderAuth` 产物过 `strictApiEntry`；
  `OPENCODE_CONFIG_CONTENT` 构造结果 `includes(明文 key) === false` 文本级锁；
  `admittedCustomFromExpectedConfig` 与注入段互逆；launcher 追加校验正/反全组合
  （url 漂移 / npm 漂移 / source 漂移 / 模型超集 / 缺 provider）；三态判定
  （enabled/disabled/absent）各路径；absent 分支内置 provider 回归（R6）。
- **存储/API**：secretBox 密封落盘（磁盘文件不含明文 key 文本断言）+ 0600；GET/PUT 响应
  掩码；PUT 保留回环；CLI `config get` 掩码 + `config set` 语义门（旁路封堵）；canary
  探针正（自定义 id 通过）/ 反（目录 id 拒绝，R5 阴性断言）/ 降级（枚举不可用）。
- **行为 fixture（gated，qualified 二进制）**：注入 config provider →
  `/config/providers` 报告过 `verifySelectedProviderInventory`（R1 锁）。
- **枚举**：含 custom 模型 / 禁用消失 / 两级缓存键逐出 / 枚举 env 无 key。
- **e2e（gated）**：`127.0.0.1` OpenAI-compatible stub → 业务节点全链路绿；key 轮换后
  resume 绿；baseURL 变更后 resume 拒；改显示名后 resume 绿（P2-2 锁）；system / MCP-test
  面各一条冒烟。
- **前端**：Settings CRUD（复用 `Dialog` / `Field` / `TextInput` / `ChipsInput` / `Switch` /
  `Select`）、掩码回显与保留提交、picker 出现自定义模型、unknown provider 渲染兜底 RTL、
  i18n 中英；role 断言优先。
