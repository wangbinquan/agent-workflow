# RFC-255 · 受控自定义 OpenAI-compatible Provider 准入 — proposal

状态：**Draft**（2026-08-04，设计门 + 用户批准前不动代码）

## 1. 背景

真实故障驱动：一台 Linux 部署机的所有业务运行以 `execution-identity-auth-invalid`
（「所选 provider 凭据不符合已验证的认证契约」）失败。排查结论不是凭据配错，而是 **RFC-224 密封化造成的能力回退**（该部署此前经机器级配置一直正常工作）：

- 该机器的模型供给是**自定义 baseURL 私有网关**（one-api / new-api / vLLM 一类
  OpenAI-compatible 端点），用户在交互 opencode 里通过机器级 `opencode.json` 的
  `provider.{id}.options.baseURL/apiKey` 使用，一直正常。
- 平台的受控执行路径（RFC-224/227/251）**从设计上整体屏蔽机器级 / 项目级 opencode 配置**
  （私有 HOME/XDG + `OPENCODE_DISABLE_PROJECT_CONFIG`），受控 config 由
  `buildControlledOpencodeConfig` 从零构建且**没有 `provider` 段**
  （`packages/backend/src/services/runtime/opencode/hermetic.ts`）。
- 因此自定义 provider 在密封子进程里**不存在**：本次故障机的 key 在机器级 opencode.json 的
  `options.apiKey`，凭据解析三通道（`OPENCODE_AUTH_CONTENT` / provider 专属 env / 原生
  auth.json）确实全部落空 → plan 阶段 `auth-invalid`（注意这不是普适断言——若宿主 auth.json
  残留该 id 条目会晚至 boot 后以 `provider-untrusted` 失败，两分支语义见 design §6）；
  即便硬塞凭据，boot 后 `/config/providers` 校验（provider 存在性 + npm 白名单）与
  「baseURL 无法跨界」也会继续拦截。**受控路径现状只能使用 opencode 内置目录 provider 的
  官方端点。**
- **回退起点（git 考古）**：2026-07-24 `b4b3e082`「Implement verified OpenCode execution
  identity」（RFC-224）及同日 `c6e9b40d`（RFC-227）把业务执行从「继承机器 opencode 面的
  inline 路径」切换为**无条件** verified 密封路径（现状分支 `driver.ts:159-163`；inline
  仅剩 test seam，`verifiedPlan.ts:370-375`）。在此之前自定义网关经机器级配置正常工作。
  因此本 RFC 的性质是**受控恢复**——与 RFC-251「恢复 OpenCode 运行时的插件与多代理支持」
  同款（同为 RFC-224 密封化的附带移除、事后以受控形态恢复），不是全新能力。

私有网关是真实且常见的部署形态（内网合规网关、聚合计费、self-host 推理）。本 RFC 把它变成
受控路径的一等能力，而不是让用户绕开受控路径。

## 2. 拍板决策（与用户四问两问逐条确认，2026-08-04）

- **D1 协议形态 = OpenAI-compatible**。npm 实现钉死 `@ai-sdk/openai-compatible`
  （closed enum 单值；Anthropic-compatible 等留作 enum 扩展位，本 RFC 不开）。
- **D2 模型清单 = 手动录入**。管理员显式列出模型 id（可选显示名）；**不做**运行时
  `/v1/models` 自动发现（零新增运行时发现面，与冻结身份一致）。
- **D3 API key = 存平台配置里**。与 baseURL / 模型清单同表单录入；平台**不读取**那台机器的
  `~/.config/opencode/opencode.json`——那正是 RFC-224 关闭的不受控可变面，读回来等于开后门。
  读接口对 key 掩码（write-only 语义）。
- **D4 归属 = 全局、管理员配置**。与运行时二进制选择同层（daemon config 文件 +
  `GET/PUT /api/config` 既有机制），所有用户的模型下拉全局可见。**不做** per-user ACL
  资源化（如未来需要，另立 RFC）。
- **D5（推导）key 不进受控 config**。密钥经 `OPENCODE_AUTH_CONTENT` 严格形状直供
  （opencode 侧 auth store → `provider.key` → SDK `options.apiKey` 兜底链），使
  execution identity / config digest 与密钥解耦：**轮换 key 不破坏 resume 身份**，
  `OPENCODE_CONFIG_CONTENT` 全程无密钥。
- **D6（推导）端点冻结进身份**。provider 段（id/npm/baseURL/模型清单）随受控 config 进入
  既有 identity digest —— baseURL 或清单变更即身份变更（旧会话 resume 被拒，新 run 正常）。
- **D7（推导）计划面最小闭包**。单次运行只注入**选中的那一个**自定义 provider 段
  （与 MCP「只带选中闭包」同原则）；密封模型枚举则注入全部 enabled 条目（picker 需要全量）。
- **D8（推导）npm 白名单不放宽**。`PINNED_BUNDLED_PROVIDER_NPM` 原样；schema 层 closed enum
  挡死自由 npm 串——opencode 对未捆绑 npm 会**运行时从 npm 下载实现包**
  （opencode `provider/provider.ts:1765-1780`），这个面必须继续不存在。

以下 D9–D13 为 **2026-08-04 设计门后修订拍板**（记档 `design-gate-2026-08-04.md`）：

- **D9（P1-4）key v1 即以 secretBox 密封落盘**（复用 RFC-036 `auth/secretBox.ts`，与 OIDC
  client_secret 同一平台密钥），config 文件补 0600；原案「明文 + 加密进 backlog」作废。
- **D10（P1-1）新增失败码 `execution-identity-custom-provider-disabled`**：禁用态在计划面
  显式失败，不依赖 fall-through（fall-through 会因宿主机器态产生 provider-untrusted 晚失败
  甚至凭据错置，语义不可指认）。
- **D11（P0-1）内置 id 冲突改双层校验**：静态快照集即时拒 + 新增/改 id 时 canary 探针。
  依据：密封枚举在零凭据下**不含**目录 provider（设计门实测只见 `opencode/*` 免费档），
  拿枚举结果当冲突全集无效。
- **D12（P2-2）运行段不带显示名**：`name` 只进枚举段（picker 显示用）；改显示名不破 resume。
- **D13（P2-8）不做 URL 归一化**：唯一性仅按 id，同 baseURL / 尾斜杠差异条目合法——
  报告面「逐字节一致」承诺优先。

## 3. 目标

1. 管理员在 Settings 配置自定义 OpenAI-compatible provider：
   `id / 显示名 / baseURL / apiKey / 手动模型清单 / enabled`，全局生效。
2. 其模型出现在所有既有模型选择面（agent runtime profile、system/default 模型等）。
3. 受控执行路径端到端支持：密封枚举 → 计划 → 准入校验 → 运行 → resume，业务 /
   system / MCP-test 三个计划面同等覆盖。
4. 端点冻结：baseURL / npm / 模型清单进 execution identity；报告面与准入值逐字节一致，
   否则以既有 `execution-identity-provider-untrusted` 拒绝。
5. 密钥卫生：key 不进 `OPENCODE_CONFIG_CONTENT`、不出现在 GET /api/config 响应、不进任何
   identity digest 输入；仅以严格 `{type:'api',key}` 形状经 `OPENCODE_AUTH_CONTENT` 进入。

## 4. 非目标

- 自动模型发现（调网关 `/v1/models`）。
- OpenAI-compatible 之外的 npm 实现（Anthropic-compatible / bedrock / vertex 等）。
- per-user ACL 化（六类资源同款 owner/visibility/grants）。
- OAuth / wellknown 凭据类型；网关健康检查、用量与计费。
- 全仓既有明文凭据面（`mcps.config.headers`）的统一迁移——本 RFC 只密封**自身新增面**
  （apiKey secretBox v1 即做，D9）；迁移项挂 `docs/audit-backlog.md`（T9）。
- claude-code 驱动路径（本 RFC 只覆盖 opencode 驱动）。

## 5. 用户故事

1. 管理员配置 one-api 网关（baseURL + key + 模型清单 `deepseek-v3` / `qwen-max`）→
   用户在 agent profile 选 `mygw/deepseek-v3` → 发起任务全链路绿，diff/审计工作流照常。
2. 网关轮换 key：管理员在 Settings 更新 key → 进行中任务的 resume 不受影响（身份未变）。
3. 管理员改 baseURL → 旧会话 resume 被身份校验拒绝（配置即身份），新 run 使用新端点。
4. 管理员停用该 provider → 新发起的运行以明确失败码失败，前端提示可指认；模型从
   picker 消失；重新启用即恢复。

## 6. 验收标准

- **AC-1 配置 CRUD**：PUT /api/config 校验——id 正则 `^[a-z0-9][a-z0-9._-]*$`、互相唯一
  （**仅按 id**，同 baseURL / 尾斜杠差异条目合法、不做 URL 归一化，D13）、不得命中内置
  目录 id（**双层**：静态快照集即时拒 + 新增/改 id 时 canary 探针，D11）；baseURL 为
  http(s) 绝对 URL、无 `${`、无 NUL；模型清单非空、id 去重非空；**新条目 / 改 id 必须携带
  真 key**（掩码串不得作为新值，语义门拒收）。违规返回结构化 ValidationError。
- **AC-2 掩码语义**：**任何 /api/config 响应（GET 与 PUT 响应）与 CLI `config get` 输出**
  一律掩码；`config set` 与路由共用同一语义门（无旁路）。省略 / 掩码 → 保留存量；新串 →
  secretBox 密封替换（D9，磁盘不存明文）。读-改-写回环不丢 key。
- **AC-3 模型枚举**：enabled 条目的模型出现在 listModels；禁用后消失；枚举缓存键随
  customProviders 投影摘要变化；枚举 env / 注入 config 中无 key（文本断言级锁）。
- **AC-4 受控运行**：选中自定义模型的业务节点端到端跑通；system plan 与 MCP-test plan
  不回归且同样可选自定义模型。
- **AC-5 准入校验**：报告的 provider `source === 'config'`、`model.api.npm` 与
  `model.api.url` 与准入值逐字节一致、报告模型键集 ⊆ 准入清单，否则
  `execution-identity-provider-untrusted`。**⊆ 检查为不可放宽的安全锁**（P0-1 次生面）。
- **AC-6 身份语义**：key 轮换后 resume 成功；修改显示名 `name` 后 resume 成功（D12）；
  baseURL / 模型清单变更后 resume 拒绝。
- **AC-7 失败路径**：禁用后发起 → 新码 `execution-identity-custom-provider-disabled`
  （D10，闭集 + 双语 + 棘轮测试全套同步）；删除后发起 → design §6 两分支语义，
  `provider-untrusted` 的 i18n hint 增补自定义 provider 指引；保存校验失败给出可指认
  错误码（中英双语）。
- **AC-8 文档**：`docs/OPENCODE_CONFIG.md` 契约段落更新；`docs/audit-backlog.md` 增补
  at-rest 加密未决项。
