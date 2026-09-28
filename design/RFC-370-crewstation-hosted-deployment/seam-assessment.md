# RFC-370 阶段 A 切面核对

2026-09-28。基线 `68ecb2664a644982bf62a8b5bdce0828b3c5caf2`，generation 与 provider artifact 启动入口已发布，安装准备应用层／本地 adapter 分离为本批候选。此表记录已沿源码确认的部分，不替代[全入口候选清单](./seam-inventory.md)，也不声明 A-G 已通过。

| 切面            | 已有可复用合同／机制                                                                                                                                                                                                              | 已确认的缺口与下一步                                                                                                                                                                          | 状态                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| H1 配置／启动   | `system-operations/application/ports/databaseConfiguration.ts`；现 PG provider；`auth/secretBox.ts:createSecretBoxFromKey` 已允许提供密钥字节，不能重复造一套加解密                                                               | 全量配置仍有文件调用者；generation 验证与文件 IO 本批分离，迁移写入／安装元数据尚需 owner 端口；托管新安装还不能直接绕过当前 PG 必须有迁移 manifest 的规则                                    | 配置／generation 已发布，启动接线候选待 CI |
| H2 身份         | `identity-access/public/participants.ts` 的 direct authority；`auth/application/authRuntime.ts` 的 session／PAT 查验；HTTP／WS 使用同一身份 owner                                                                                 | `auth/session.ts:multiAuth` 固定 Bearer 提取；`ws/server.ts:tryUpgrade` 固定 query token 和本地 credential 指纹。应分离凭据适配与已有 Actor／业务权限，不能另造 ACL                           | 待抽入站适配；已有 authority 复用          |
| H3 工作区       | `source-control/application/ports/repositoryPreparationEffects.ts`；`source-control/application/ports/workspaceMaintenance.ts`；Task 的 `workspaceLaunch.ts` 读取端口                                                             | 准备效果已有可替换边界；维护仍有同步 exists 和物理 path，Git／merge／读取各路径须逐项确认远程引用语义，不能仅按目录改名认为完成                                                               | 部分可复用；调用链待收口                   |
| H4 执行         | `task-execution/application/ports/taskEngine.ts`、各 NodeExecutor 的执行合同；本地 `managedProcess` 生命周期                                                                                                                      | `services/runner.ts`、`systemAgentRun.ts`、`runtimeSmoke.ts` 使用 `runAgentProcess`；脚本、依赖安装、插件安装和 observer 也能启动进程。cmd／cwd／env／PID 混入当前收据，尚无完整中立效果端口  | 待重构关键切面                             |
| H5 Runtime      | `runtime-management/application/ports/runtimeManagement.ts` 的 driver management／model discovery／config 合同；两种 RuntimeDriver                                                                                                | 管理端口仍以本地 binary 为输入，执行 driver 的 buildSpawn 和材料物化交织。需将协议解析／能力需求与物理执行目标分开；平台 profile 映射归后续 B                                                 | 管理合同复用，执行材料待分离               |
| H6 内容         | `resource-catalog/application/skills/ports.ts:SkillRepository` 已统一技能 CRUD／版本／文件；`application/skills/skillCatalogBootParticipant.ts` 有启动 adapter；`application/plugins/ports.ts:PluginInstallerPort` 已分离安装效果 | `infrastructure/skillRepository.ts` 背后的 legacy skill 状态机仍以本地文件为事实；需要抽物理内容／发布效果并复用原版本状态机。插件 cachedPath、执行物化、归档和下载也需覆盖，不能只改创建页面 | 已有业务端口复用；耐久内容机制未完成       |
| H7 执行权／恢复 | Task 已有 ownership、effect intent 和终止／恢复合同；bootstrap 管单实例与后台 worker 生命周期                                                                                                                                     | 不能只给 node dispatch 增加 lease。`cli/start.ts` 的 observer、schedule、GC、蒸馏和恢复入口均需受同一宿主执行权接线；本地恢复行为必须保持                                                     | 全效果入口待收口                           |
| H8 事件         | `integration/application/ports/verifiedWebhookDeliveryPersistence.ts`；`acceptVerifiedWebhookDelivery.ts`；既有 provider 归一化和 EC observations                                                                                 | 需要分离原始 HTTP 信封与统一受理事务。CS transport 的永久 receipt 与原业务重放不是同一去重边界；CS adapter 在 B 阶段编写                                                                      | 受理合同复用；transport 切面待补           |

## 本批 generation 的边界

- `platform/persistence/generationValidation.ts` 保存原 schema、digest、manifest、历史升级和恢复候选判定；通过 `DatabaseGenerationArtifactReader` 读取已可用文档，不解析本机路径。
- `generationStore.ts` 作为本地文件 adapter，保持原路径 API、原子替换、fsync、读回与崩溃回调。现有 daemon／CLI／backup／migration 调用继续走该 adapter，再进入共同验证核心。
- 同步 reader 表示已加载快照的验证视图，不声称已支持异步 PG／CS 读取。后续宿主 adapter 必须先完成一致快照加载，再调用同一验证；metadata 写入／持久提交仍需单独接线。
- 新 conformance 用例对比本地文件和内存文档源的正常、缺失、损坏、历史 schema、manifest 失配与 owner 恢复拒绝；已有 RFC-349/359 文件崩溃／真实 DB 恢复测试保持生效。内存文档源不是 CS 运行验收。

- `resolveDatabaseProviderRuntimeFromArtifacts` 消费已加载的中立 generation 文档；PG 不要求 `sqlitePath`／`generationPointerPath`／`operationsRoot`。原文件启动委托同一 provider 判定，配置不能覆盖 generation。该入口不做 schema 迁移；standalone 升级和复制恢复仍经原 coordinator。

- 安装准备通过 `DatabaseInstallationPort` 调用读 generation／列举和读取迁移／写 generation／升级锁／恢复复制／准备 provider；应用层不持有本机路径或 Lock。`fileDatabaseInstallation` 包住原效果，旧入口委托同一编排。该端口支持异步完成，但 hosted 实现与前台服务生命周期仍待完成。

- Settings HTTP 的配置 read/update 现消费 system-operations public 合同；`ApplicationConfigurationPersistencePort` 支持异步存储，`fileApplicationConfiguration` 保持原文件 schema／patch 行为。两 provider 的 bootstrap 共用配置 application，已持久提交后才通知和热更新。托管存储与其他文件读取调用者仍未接齐。

- `platform/configuration/configurationValues` 提供无 IO 的存储值解析、patch 校验与合并规则；本地文件 adapter 和后续托管存储共用。RFC-276 文件迁移、缓存及原子替换仍由文件 adapter 负责；不能把纯值规则抽取等同于配置全调用者迁移完成。

- 六组 HTTP 消费方（maintenance、plantuml、cached-repos、repoGroups、tasks、taskArchive）的配置读取已改接 `ApplicationConfigurationQueries`，两 provider composition 提供 live file reader；保留错误／fallback 和每次调用读取行为。public origin／身份入口及后台、执行配置仍存在本地调用，不记全覆盖。

- 文档／发现、OIDC public origin、PAT 创建与 MCP transport 现接按需配置 query；完成态 HTTP 装配也以 query 代替 configPath。保留原地址优先级／读取失败回退与开关语义；身份认证本身仍为原实现，不据此关闭 H2。启动、后台、执行和 intent 的配置路径仍待迁移。

- Settings／CLI 数据库迁移 composition 与启动准备复用 DatabaseConfigurationPort；默认仍装配 file adapter，目标切换与源回退等待配置写入完成后才进入原 admission。该接线仅解除配置存储绑定，迁移元数据和复制机制仍为本地实现。

- Runtime Management 管理配置支持按需异步读取，file adapter 独立落位并保留原探针队列；registry boot 的原始旧配置文本读取已抽为 owner port，双 provider 启动显式装配 file adapter。原默认值迁移判定仍归应用，无 configPath 输入；这不替代远程 runtime driver／执行材料适配。

- H8 直连 transport 的 verified 投递已通过 integration public command 接应用受理／Event Center 发布。共同命令保留原持久化、MR 效果、重复重发与失败语义；provider 验签／normalize 仍由各入站 adapter 负责，人工业务 replay 保留原独立路径。CS 运输 receipt／ACK及事件适配在 B 阶段实现，不混为业务重放。

- MCP diagnostics 的配置读取改接窄 runtime 配置 query，支持异步／按次热读；SQLite／PG／daemon 显式注入原文件 reader。该测试台仍有 scratch／本地执行效果，配置切面完成不代表 H4／H5 或 CS MCP 能力完成。

- H2 HTTP 完成态装配新增 `HttpAuthenticationParticipant`；两个 provider root 选择 local adapter，公共 transport 不固定凭据方案。原 HTTP 与 WS 凭据算法已归 identity-access 本地 infrastructure，legacy facade 委托同一实现；WS 握手提取、credential DTO 与重验装配仍需继续收口。CS 身份映射、首个管理员及前端登录在 B/M0 实现。

## H2 后续 WS 闭环核对（当前源码）

HTTP participant 不能替代 WS 全链路。后续 A-T3 须一起迁移下面这些机制，才能在 B/M0 选择同一外部身份来源；不能仅让握手接受新身份、重验仍去本地 session/PAT 表查询。当前仍为 local 行为，不声称以下缺口已经实现。

| 调用点 | 当前依赖 | 后续切面要求 |
| --- | --- | --- |
| `ws/server.ts:217`、`:292` | daemon token Buffer 与 query token，调用 realtime credentials.resolveUpgrade | 请求凭据提取／解析由 identity-access 所选 adapter 完成；WS 保留升级生命周期与通道准入 |
| `modules/runtime-management/application/realtimeCredentialAccess.ts:14`、`:23` | 固定转调本地 resolveActorWithWsCredential／reresolveIdentity | 凭据机制归 identity-access；runtime-management 继续拥有实时通道数据，不再选择身份机制 |
| `ws/connections.ts:73`、`:183` | 按 daemon／session／PAT hash 构造重验合并键，再查原 credential store | adapter 提供连接凭据引用／稳定合并标识与重验行为；同一 adapter 内同凭据仅查一次，连接各自完成刷新 |
| `ws/registry.ts:1085` | 通过本地凭据 kind 与 expiresAt 判断帧发送时过期 | 暴露中立到期事实，保持同步帧路径和原过期关闭时机，不因远程身份引入每帧 IO |
| `ws/server.ts:413` | 打开时再次调用同一 credential resolver | 升级与 open 之间的既有 revalidation epoch 行为必须随端口保留，不能只替换第一次解析 |

本轮只记录源码定位。后续用既有 WS 多 token、provider、去重及重验行为用例固定原结果，再增加替换 adapter 的升级／open／广播过期／主动重验闭环用例；真实 CS token／网关／重新连接在 B/M0 验收。

## H2 WS 续批实现（待本批 CI）

上述五处接线现统一消费 identity-access 的 `WebSocketAuthenticationParticipant`：升级传递 URL／header 事实，连接持有 adapter-owned object，合流键与同步到期事实经所选 participant 获取，open／主动重验返回同一 IA authority 投影。本地原 token 解析位于 `infrastructure/local/webSocketAuthentication.ts`，runtime-management composition 只收已选 participant，不再构造身份机制。H2 的外部身份映射／首个管理员／浏览器模式仍留阶段 B；本批只能作为 A 的切面证据，不能替代完整阶段 A 验收。

## H6 评审文稿切面（待本批 CI）

collaboration 保留原 operation／artifact 状态机，所有写效果支持并等待异步 receipt；`ReviewArtifactContentPort` 按日志中的逻辑 key 读取字节，DB reader 继续拥有当前读／staged fallback 与摘要判定。`commandContext` 可注入成对的 store／content，无 appHome 也能完成装配。已有 local helper 与测试显式选择文件 reader；这不表示 Skills／plugin 版本发布或全量 ContentStore 已完成，亦不代表 hosted PG 内容已实现。
