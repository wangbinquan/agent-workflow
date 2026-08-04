# RFC-255 设计门记档（2026-08-04）

## 评审方式（替代关系声明）

本机 Codex 处于记录在案的不可用组合（插件 1.0.6 × CLI 0.146.0：companion review 与
`codex exec` 双双 wedge，2026-07-31 实锤，见 per-machine memory 与 `docs/dev-gotchas.md`
§Codex「rescue job 会僵尸」）。按既定止损姿势（RFC-253 实现门亦有先例），本门改由
**全新上下文的对抗式子代理**执行同强度评审：pin 在 `0bd78d53` 的分离 worktree、强制实读
平台与 opencode 源码核验每条断言、另以本机 opencode 1.18.8 二进制做只读行为探针。
产出强度：28 条事实核验（4 条 ⚠️/❌）、1 P0 + 5 P1 + 8 P2、9 条遗漏面。

## 裁决总表（全部折入，零驳回）

| Finding | 裁决 | 折入方式 |
| --- | --- | --- |
| **P0-1** 内置 id 冲突校验的 id 全集错误（密封枚举零凭据下只见 `opencode/*` 免费档；实测 id=`anthropic` 必然通过校验并污染 picker——18 个目录模型挂到网关 url） | **折入（组合方案）** | 冲突校验改为**双层**：①静态快照集（`PROVIDER_API_KEY_ENV` 全部键 ∪ pinned 目录 id 快照）即时拒绝；②新增/改 id 时跑 **canary 探针**（向密封枚举注入 `{provider:{<id>:{models:{__aw_canary__:{}}}}}`，输出非恰好一个 canary 模型 ⇒ 目录 id ⇒ 拒绝）。AC-5 的 ⊆ 检查在 design 中显式标注为**不可放宽的安全锁** |
| **P1-1** 「禁用/删除 → auth-invalid」不成立：宿主 auth.json 命中 → boot 后 provider-untrusted；表内 id + daemon env → 以真凭据打官方端点 | **折入（新失败码 + 结构性防绝）** | 计划面显式判定：providerID ∈ customProviders 且 disabled ⇒ 新码 `execution-identity-custom-provider-disabled`（闭集词汇表 + 双语 + 棘轮测试全套同步）；「表内 id 冲突」一类由 P0-1 双层校验按构造防绝；删除态 fall-through 仅可能命中宿主 auth.json → boot `provider-untrusted`，该码 i18n hint 增补自定义 provider 指引并在 §6 如实记两分支 |
| **P1-2** 掩码/存储 schema/wire schema 三方矛盾（共享 schema 拒掩码则前端 parse GET 响应即炸；`ConfigPatchSchema` 顶层 partial 使「省略 key」在 preview 就 400） | **折入** | 三形状显式分离：`Stored`（真 key，secretBox 密封）/ `Wire`（apiKey optional，掩码合法）/ PUT 语义门（按 `id` 配对保留；改 id 视同新条目须携真 key；「拒收掩码为新值」只在路由语义门） |
| **P1-3** PUT 响应回整份真 key；CLI `config get` 明文、`config set` 绕过语义门 | **折入** | 单一 `maskConfigForOutput` 变换覆盖 GET + PUT 响应 + CLI `config get`；校验与掩码保留语义提取为纯函数，路由与 CLI `config set` 共用；AC-2 措辞改为「任何 /api/config 响应与 CLI 输出」 |
| **P1-4** 「文件 0600」不属实（saveConfigRaw 无 mode，实为 0644）；明文落盘与仓内 secretBox 先例（RFC-036 OIDC、repo 凭据 sealed 备份）相悖 | **折入（升级方案）** | apiKey **v1 即 secretBox 密封**（复用 `auth/secretBox.ts`，与 OIDC client_secret 同一平台密钥）；config 文件补 `mode:0o600` + 存量 chmod；proposal 非目标改写：backlog 项变为「mcps.headers 迁移 secretBox」而非再添明文面 |
| **P1-5** `admittedCustom` 到 launcher 的传输未设计 | **折入（零新字段）** | 从 `manifest.expectedConfig.provider` 推导（与准入值按构造同源——它就是注入的那段）；T4 增补 manifest codec 对 config 新键的兼容验证 |
| P2-1 §4.4 机制表述两处错（digest 实际在计划面 `businessOpencodeIdentityDigest`；sessionContractDigest 不含 config；buildHermeticServerEnv 的 canonicalizeIdentity 仅校验） | 折入 | design §4.4 按实改写 |
| P2-2 改显示名破 resume 未告知 | 折入 | 运行段**不带 `name`**（枚举段保留 name 供 picker 显示）——改名不再触碰身份 |
| P2-3 PUT 冷路径同步 spawn 密封枚举 | 折入 | canary 仅在新增/改 id 时跑；枚举不可用给可指认错误；禁用/改 key 不触发探针 |
| P2-4 §1 引 355-358 系 bedrock 专属 loader（「endpoint 优先」对本类不成立） | 折入 | 改引 1693-1695，删 endpoint 表述 |
| P2-5 key 可达面缺 manifest 落盘（0600）与 /proc environ 两项既有面 | 折入 | proposal 密钥卫生条补「与既有内置 provider 同姿态」注记 |
| P2-6 枚举缓存 Map 无界（摘要槽位不逐出） | 折入 | 两级键（binary → 摘要）或前缀逐出；随 T5 |
| P2-7 计划漏 RFC 流程件与 ValidationError 棘轮 | 折入 | 登记已于 `0bd78d53` 完成（评审对象即含）；T2 补棘轮测试清单（`rfc203-validation-copy` / taxonomy / i18n-phase-b 等） |
| P2-8 同 baseURL 多条目、尾斜杠差异均合法 | 折入 | AC-1 明示：唯一性只按 id、**不做 URL 归一化**（归一化会破坏报告面逐字节承诺） |
| 遗漏面 1-9（备份面 / CLI 面 / PUT 掩码 / 模型引用自由文本注记 / provider-untrusted hint / 多 runtime 语义 / 删除后 UI 渲染 / dev-gotchas 沉淀 / backlog 条目改写） | 全部折入 | 分别进 design §6、plan T2/T8/T9；「密封枚举 ≠ 目录全集」作为通用认知坑沉淀 dev-gotchas（T9） |

## 事实核验的自我修正

评审对 RFC 原文四处 ⚠️/❌ 全部接受并订正：#1（bedrock 引用错位）、#17（digest 机制表述
半错）、#19（禁用 fall-through 语义）、#21（0600 不属实 + 取例避重就轻）。#20 注记：
「三通道全部落空 → auth-invalid」仅对本次故障机成立（其 key 在机器级 opencode.json 的
`options.apiKey`），不是普适断言——proposal §1 已按此收窄措辞。

## 门后状态

三件套已按上表修订（同批 commit）。实现门（Codex 或同强度替代）在代码完成后另行执行。
