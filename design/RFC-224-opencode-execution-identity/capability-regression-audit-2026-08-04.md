# RFC-224 能力回退全面审计（2026-08-04）

## 0. 触发、方法与事故史

**触发**：一台 Linux 生产部署的全部运行以 `execution-identity-auth-invalid` 失败——自定义
baseURL 私有网关（OpenAI-compatible）在 verified 密封路径里不存在。排查定性为
**RFC-224（`b4b3e082`，2026-07-24）密封化的附带能力回退**，且从未作为 breaking change
呈报（→ RFC-255 受控恢复，进行中）。用户随即要求对 RFC-224 的全部能力回退做一次性盘点。

**方法**：以 `b4b3e082^`（pre-224 inline 路径）为基线，对比当前 verified 路径逐面枚举；
事实层由独立考古子代理产出并经主线复核（opencode 参考 checkout `cb562b2c62`，≈v1.18.4）。
每项裁决三选一：**A 保持排除**（安全边界 / 平台语义替代，有意且合理）、**B 受控恢复**
（已立项或挂 `docs/audit-backlog.md` 候选）、**C 已恢复**（记档）。

**pre-224 基线的关键事实**（锚：`b4b3e082^` 的 `spawn.ts` / `runner.ts`）：业务 opencode
以 `opencode run` CLI 子进程执行，**全量继承 daemon `process.env`**（pre-224 spawn.ts:180），
HOME/XDG 不重定向，无任何 `OPENCODE_DISABLE_*`；`OPENCODE_CONFIG_CONTENT` 只是合并顺序
最高的 overlay（pre-224 runner.ts:8-9 注释明言 repo/`$HOME` 面正常合并）。

**RFC-224 事故史（实锤 6 件 + 收尾修复 16 条）**：
①以三条 opencode 行为论断禁掉已完工的 RFC-022/031，后经 RFC-251 核验**两条与源码不符、
一条系误读**（`design/RFC-251-*/proposal.md` 对照表）；②静默切断自定义 baseURL provider
（本次事故，→ RFC-255）；③内置 skill 钉单一 digest，opencode 1.18.8 重写正文 → 该版本
每次 verified 运行必挂（`d4c42934` 修复为已审阅白名单）；④落地当天绑死 OpenCode 版本，
同日 RFC-227（`c6e9b40d`）撤销；⑤落地时不认 `opencode auth login` 原生 API key，两天后
`3a13a166` 补兜底；⑥attestation 证明链成本高且未证明到位，RFC-251 整层移除。
收尾修复提交：`a7f6814e` `3f7683f7` `3a13a166` `7cf56eec` `0860c8d8` `41f8ee31`
`c31c69d6` `b6532b29` `7b0ee08f` `d4c42934` `3975966f` `4c57fd01` `36b02214`
`37496943` `3a06d82a` `21c9cf6e`（2026-07-24 → 08-04，16 条，另 1 条 grep 误中已剔）。

## 1. 裁决表

### 1.1 配置面

| 面（pre-224 可达） | 现状排除机制 | 裁决 | 依据 / 去向 |
| --- | --- | --- | --- |
| repo 内 `.opencode/`、`opencode.json[c]`、`.claude/skills`、`.agents/skills` | `scanOpencodeProjectSurface` 逐级向上存在即 fail（`sourceGuard.ts:8-16,59-106`）+ spawn 前后指纹比对 | **A** | 恶意仓库注入面（clone 即可向 agent 进程投配置/插件/skill），是密封的核心价值；保持 |
| 机器全局 config（`~/.config/opencode`、`~/.opencode`：agents/modes/commands/skills/opencode.json 深合并） | HOME/XDG/`OPENCODE_CONFIG_DIR` 全部指向私有 0500 密封 layout（`hermetic.ts:383-408,442-458,548-557`） | **A** | 「运行行为取决于机器可变状态」正是不可复现根源（本次事故的镜像问题）；平台受控 config 为替代语义 |
| config `provider` 键——**自定义 baseURL / OpenAI-compatible 自托管端点的唯一通道**（opencode `provider.ts:355-358,1693-1714`） | 受控 config 无 `provider` 段（`hermetic.ts:794-820`）+ npm 钉 24 项白名单（`:41-66,823-827`） | **B（进行中）** | **RFC-255**：管理员级 customProviders + 无密钥 provider 段注入 + 报告面逐字节准入 |
| instructions 自动发现（全局/项目 `AGENTS.md`、`CLAUDE.md`、`CONTEXT.md`，opencode `session/instruction.ts:60-133`） | `instructions:[]` + `OPENCODE_DISABLE_PROJECT_CONFIG`/`DISABLE_CLAUDE_CODE` | **A**（注意点） | 平台 agent prompt/skill 体系为替代语义；**行为差异要写用户文档**：repo 里的 AGENTS.md/CLAUDE.md 不再影响平台 agent |
| `{command,commands}`、`{mode,modes}`、`theme`、`keybinds`、`tui` 等 TUI/交互键 | 受控 config 无此类键 + 密封 config roots | **A** | 无头 server 场景无消费意义 |
| config 级 `skills.paths/urls` | `skills:{paths:[],urls:[]}` 硬编码 | **A** | managed skills（全树密封 + digest 注入）为替代 |
| `share` / `formatter` / `lsp` / autoupdate / models.dev 拉取 / embedded web UI / filewatcher | 硬编码 false + `OPENCODE_DISABLE_*`（消费点见考古 §2 表） | **A** | 外发面/无关面/网络面，密封语义一致 |
| `compaction.auto` / `prune` | 硬编码 false | **A**（注意点） | 节点粒度会话短；若未来出现超长单节点会话需求，另行评估 |
| `snapshot` | 硬编码 false | **A** | git wrapper 自管 diff/快照 |

### 1.2 凭据与 env 面

| 面（pre-224 可达） | 现状排除机制 | 裁决 | 依据 / 去向 |
| --- | --- | --- | --- |
| **OAuth 凭据**（`type:'oauth'`，opencode 泛化消费 `provider.ts:614,869-877`；具备完整 OAuth 流的有 openai ChatGPT Plus/Pro、github-copilot、opencode Console、xai、digitalocean、snowflake-cortex——考古 §3 锚） | `strictApiEntry` 恰好双键 `{type:'api',key}`（`hermetic.ts:149-161`）拒绝一切 oauth；且 `OPENCODE_DISABLE_DEFAULT_PLUGINS` 使 10 个内置 auth 插件不加载（token 刷新逻辑缺席） | **B 候选**（backlog P2） | 恢复形态复杂：refresh token 写回密封 store + 内置 auth 插件受控加载，须独立 RFC；有订阅用户需求时立项 |
| **wellknown 凭据**（`auth login <url>`，`cli/cmd/providers.ts:348`） | 同上 strict 拒绝 | **B 候选**（backlog P3，并入 OAuth RFC） | 使用面窄 |
| **api + `metadata` 条目**（provider 插件 callback 写入，`provider/auth.ts:203-209`） | strictApiEntry 多一键即拒 | **B 候选**（backlog P2） | 最小受控修：strict 校验放行已知形状 metadata 但**不透传**（或逐 provider 白名单）；须小型 RFC 裁决 |
| **非 auth.json 凭据链**：AWS bedrock（`AWS_*` env + `~/.aws` + IMDS/SSO，`amazon-bedrock.ts:85-101`）、vertex ADC（`GOOGLE_APPLICATION_CREDENTIALS` + gcloud 配置，`google-vertex.ts:7-22`）、azure `AZURE_RESOURCE_NAME`（`azure.ts:5`）、gitlab / cloudflare 专属 env | `SAFE_FORWARD_ENV` 15 键白名单（`hermetic.ts:89-105`）+ HOME 重定向使 `~/.aws`、gcloud 配置不可达 | **B 候选**（backlog P2，按需求分 provider 立项） | 企业云部署常见形态；恢复=受控 env 透传白名单 + 逐 provider 行为资格，须 RFC |
| PROVIDER_API_KEY_ENV 表覆盖 16 id vs opencode 目录 32 provider | 表外 id 无 env 兜底 | **记档（无独立回退）** | 表外 catalog id 仍可走机器 auth.json 的 strict api 条目通道（`hermetic.ts:209-226`）；真正断的是上面四类特殊凭据 |
| 用户/系统 gitconfig（credential helper、签名、alias） | `GIT_CONFIG_NOSYSTEM=1` + `GIT_CONFIG_GLOBAL=/dev/null`（`hermetic.ts:568-569`） | **A**（注意点） | 署名已由 GIT_AUTHOR/COMMITTER 四件套受控注入；agent 进程内 push/credential 非产品语义（任务提交由平台管理） |
| daemon PATH / 任意继承 env | `PATH='/usr/bin:/bin'` 硬编码 + 白名单 | **A** | 既定姿势：需要工具链时走 run-scoped seal（`docs/dev-gotchas.md` §「verified business plan 的 PATH」） |

### 1.3 已恢复（C，记档）

| 项 | 恢复载体 |
| --- | --- |
| agent 插件（RFC-031 全链路）+ `dependsOn` 多代理（RFC-022 闭包） | RFC-251（`9baa5ea0`，2026-08-03）；禁用依据两条与源码不符、一条误读，逐条对照见其 proposal |
| attestation（启动后二读比对）整层 | RFC-251 移除 |
| OpenCode 版本无关准入、macOS Seatbelt 真实路径、enforce/warn/off 三模式、状态细分 | RFC-227（`c6e9b40d`，2026-07-24 同日撤销 224 的版本/OS 钉死） |
| 内置 skill 正文单 digest → 已审阅发行版白名单 | `d4c42934`（2026-07-28，1.18.8 事故） |
| `opencode auth login` 原生 API key 兜底（auth.json 第三通道） | `3a13a166`（2026-07-26） |
| 自定义 baseURL provider（OpenAI-compatible） | **RFC-255（进行中）** |

## 2. 归入 audit-backlog 的未决项

以下 4 条以「RFC-224 能力回退审计（2026-08-04）」小节挂入 `docs/audit-backlog.md`，
按需求触发立项，每条须独立走 RFC（含 CLAUDE.md 第 7 条能力影响清单门槛）：

1. **OAuth/订阅凭据受控恢复**（P2）——refresh 写回密封 store + 内置 auth 插件受控加载。
2. **api+metadata 条目受控放行**（P2）——已知形状校验、不透传或白名单。
3. **云凭据链 provider**（P2）——bedrock/vertex/azure 等受控 env 透传 + 逐 provider 资格。
4. **wellknown 凭据**（P3）——并入 1 的 RFC。

## 3. 存疑项（如实记录，不作依据）

- **anthropic Claude Pro/Max OAuth**：当前 opencode checkout（`cb562b2c62`）源码中**未找到**
  任何 anthropic OAuth 流（`core/src/plugin/provider/anthropic.ts` 无 auth methods）。
  「anthropic 订阅登录属被回退能力」不成立于当前版本；历史版本是否曾有未查证。
  机器 auth.json 中已存的任意 provider oauth 条目 pre-224 可用、现被拒——这一层是证实的。
- **env 形式的 provider baseURL**（如 `OPENAI_BASE_URL`）：opencode 源码无消费点；
  自定义 baseURL 的唯一已证实通道是 config `provider` 键。
- **azure 在 hermetic 环境的确切失败形态**：未实测。

## 4. 流程沉淀（已落）

- `CLAUDE.md` RFC workflow 第 7 条：能力收缩型 RFC 必须带「能力影响清单」呈用户逐项确认 +
  禁用分支必须有测试 + 判据可复跑（`b2bd5afd`）。
- `docs/dev-gotchas.md` §opencode 断言复核教训补第 (d) 层（能力影响呈报）。
