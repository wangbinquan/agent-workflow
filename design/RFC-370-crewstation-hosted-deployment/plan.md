# RFC-370 实施计划

状态：In Progress · 2026-09-28。用户已批准实现、部署及提交上库到远端。用户已确认完整接入，以及“先补齐 adapter 切面，再编写 CS 独立 adapter”的顺序。CS adapter 采用必要能力先行、先部署再逐项收编策略。当前执行阶段 A，进度和门状态见末尾实施日志；尚未部署 aw。

## 1. 两阶段顺序与验收门

H1～H8 是职责边界，A-T／B-T 是实施任务。阶段 A 的独立退出门 A-G 通过后才能开始阶段 B 的生产实现；不能在抽取本地端口时并行夹带 CS adapter。B1～B4 保留原验证阻塞编号，不与 B-T 任务混用。

### 阶段 A：平台中立切面与本地 adapter

| 任务 | 内容／交付物                                                                                                        | 依赖             | 完成证据                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------- |
| A-T0 | 完成 RFC 功能设计门及实施批准记录；D1／D7／D8 已确认，其余设计决策与能力影响按实际批准记录处理                      | 本稿             | 不复用 CS RFC-033 的实施批准                                              |
| A-T1 | H1～H8 全调用者清单：复用／扩展／新抽取分类、owner、port、adapter、composition、迁移范围；固定原行为 oracle         | A-T0             | 逐入口源码和合同，含业务／系统 Agent、Git／脚本、MCP 测试台及所有后台效果 |
| A-T2 | H1／H6：抽配置、安装元数据、内容和启动生命周期切面；接现 provider／filesystem 实现                                  | A-T1             | 原路径、密钥、generation、导入导出与持久性语义不变；无 CS 运行依赖        |
| A-T3 | H2／H8：收口身份与 revalidation 接线、transport-neutral webhook 受理及事务参与者；保留原登录和直连 provider adapter | A-T1             | 原 HTTP／WS、ACL、PAT、webhook 去重／重放及 MR 行为回归                   |
| A-T4 | H3：复用 Task／SC 合同，抽物理 workspace／Git 效果，接 local adapter                                                | A-T1             | 两条 launch lane、多仓、隔离／共享 worktree、merge／上传／读取行为回归    |
| A-T5 | H4／H5：分离中立执行、runtime 配置／协议职责和本地启动材料；local adapter 包住 PID／spawn／流／取消，切全调用者     | A-T2、A-T4       | 双 Agent、系统执行、脚本及工作组等原行为回归；业务接口无 CS DTO           |
| A-T6 | H7：抽执行权／恢复生命周期端口，接现 local 单实例／owner 语义；后台效果统一接线                                     | A-T2、A-T3、A-T5 | 现重启、重试、取消、人工等待和后台派发语义不变                            |
| A-T7 | 收口 composition／public／依赖守卫与 owner 账本，消除本次入口的直连 FS／spawn 等效果，完成共同合同测试              | A-T2～A-T6       | 清单全覆盖；非假 adapter facade；无新增平台业务耦合                       |
| A-G  | 阶段 A 功能实现门、双 OS／双数据库精确 SHA CI，形成独立可发布版本                                                   | A-T7             | AC00 全部通过、候选内容／提交 SHA／证据记录；RFC 仍未 Done                |

A-T2／A-T3／A-T4 可在合同冻结后并行开发，遵守共享 main 的文件归属和发布串行规则。A 阶段只重构本 RFC 必经切面，已有合格端口无需再包装。不要求为推进阶段 A 启动 CS 资源或先完成远程容量验证。

### 阶段 B：必要适配先行，先部署，再逐项收编

部署不再是阶段 B 最后的单独任务。M0 必须先在实际 CS 可用；其后每个增量都在已有安装上发布和验收。B1～B4 按当期能力拆项，不形成“全部闭合才允许首次部署”的总门。

| 任务 | 里程碑及内容／交付物                                                                                                        | 依赖                                             | 完成证据                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| B-T0 | M0 合同冻结：只确定服务 Manifest、PG／配置／Secret、浏览器身份、内容存储及未就绪能力提示；建立后续能力清单                  | A-G                                              | M0 所需 schema、B3 当期持久性方案、B4 新身份／首个管理员方案；不等待插件／MCP／旧 PAT 迁移       |
| B-T1 | M0 必须 adapter：H1 托管入口与现 PG、H6 当期资源内容、H2 HTTP／WS 身份；最小中立客户端、镜像／Manifest／迁移／探针／UI 提示 | B-T0                                             | 能构建和发布；已开放编辑路径全部耐久；执行和外部效果未就绪时不派发                               |
| B-T2 | **M0 首次实际部署**：本机 CS 新安装，登录、编辑／保存、服务重建、数据回读；留下可用访问入口                                 | B-T1、实际资源授权                               | release／镜像 digest／配置、浏览器和持久性证据；AC00B 的首次部署要求通过                         |
| B-T3 | M1 工作区／runtime／执行最小完整纵向路径，加该路径必须的 authority、失租约处理、持久 intent／receipt、取消释放及重启对账    | B-T2；仅所选流程涉及的 B1／B2／B3 检查通过       | 在 M0 安装增量发布；一条代表性工作流实际完成、取消和重启对账通过；其余能力明确未就绪             |
| B-T4 | M2 按能力逐项扩展 H3／H4／H5：双 runtime、完整 Git／多仓／脚本、插件、MCP、系统 Agent、复杂工作流与工作组                   | B-T3；各条目自己的依赖验证                       | 每项独立 adapter 变更、相关回归、发布和现场流程；逐步关闭 AC03～06 中的条目                      |
| B-T5 | M3 事件增量：integration CS EventDelivery 入站 adapter、持久 receipt、provider 归一化、事件 UI 与 Task／Reaction 触发       | B-T3、目标规则依赖的 B-T4 条目就绪               | 增量发布并跑通两个 producer 的实际投递、去重、MR／规则、业务执行链路；AC08                       |
| B-T6 | M3 运维增量：system-operations 的剩余恢复动作、完整 handoff／migration、后台功能及对应 UI                                   | B-T3、每种动作依赖的执行能力                     | 逐项声明并开放动作；实际恢复／升级交接／额度测试；AC07／09／10。可与 B-T4／B-T5 的无依赖条目穿插 |
| B-T7 | M4 旧实例迁移／回退演练，补齐原身份／PAT、全量内容、完整能力与浏览器对拍                                                    | B-T4～B-T6 全部完成、B1～B4 全闭合、实际迁移授权 | AC01～11 完整证据；旧实例停写、导入、对账及正式切换方案                                          |
| B-G  | 完整托管功能实现门、双方合同／精确 SHA CI、架构账本与 RFC 收口                                                              | B-T7                                             | AC00、AC00B、AC01～12 全部有证据；只有此时 RFC 记 Done                                           |

每个 B-T 实现增量都携带功能测试、必要 UI、发布／回退说明，并按实际授权及时发布到试点安装；不能把现场验证和前端入口全部留到 B-T7。未支持的配置在启动前提示，不能接受后无限等待或由服务槽 local spawn 兜底。M1 前置的最小执行权、幂等、取消和恢复对账不能推迟到 M3。完整蓝绿交接就绪前，采用停派发、排空在途任务的单槽维护升级。

B1～B4 的能力调查和必要 CS 配套 RFC 跟随具体消费者推进；平台合同已满足的部分不被无关差异阻塞。阶段 B 暴露中立合同缺口时，先独立补合同与 local 回归、验证受影响的 A 门，再继续依赖的 adapter。当前用户确认的是增量交付策略，不代表 M0／M1 可以替代最终完整验收。

## 2. 建议提交批次与独立交付

1. A：调用者／合同与原行为 oracle（A-T1）。
2. A：启动／内容、身份／事件、工作区切面，按 owner 小批提交（A-T2～A-T4）。
3. A：执行／材料、本地执行权与全部调用者接线（A-T5／A-T6）。
4. A：架构守卫、功能实现门和 CI 收口（A-T7／A-G），记录独立可发布版本；此时无 CS 生产 adapter。
5. B／M0：必要合同与 adapter（B-T0／B-T1）→ 首次实际部署并留下可用入口（B-T2）。
6. B／M1：首个远程任务完整闭环，随同必须的执行权／恢复对账发布（B-T3）。
7. B／M2～M3：按能力逐项提交、增量部署和验收执行、事件与运维 adapter（B-T4～B-T6）；每项同时交付 UI。
8. B／M4：旧实例迁移、全能力对拍及完整 RFC 收口（B-T7／B-G）。

不把 A／B 混入同一实现提交；保持同一 RFC 下两个清晰交付阶段。独立 adapter 指 owner 模块内目录与依赖边界，不强制独立 npm 包。所有代码保持共享 main 和精确路径提交；不创建 branch／worktree／clone，不与其他会话并发操作共享 index。实施、部署和既有实例迁移分别记录实际授权。

## 3. 证据清单

- [ ] A 阶段逐切面记录原调用者、既有／新增端口、local adapter、composition 与清理完成情况。
- [ ] AC00 独立通过：无 CS 运行依赖、原行为等价、真实 local adapter 回归、架构守卫、功能实现门及精确 SHA CI。
- [ ] B 阶段 adapter 按 owner 独立落位；wire DTO 不泄漏到业务层；共用客户端不拥有业务状态。
- [ ] M0 已实际部署且能登录、编辑、耐久保存／重建回读，首次部署没有被全能力适配阻塞。
- [ ] M1～M3 每个增量都有能力清单、用户可见状态、release 与现场证据；必要的执行唯一性、取消与对账随首个任务闭环交付。

- [ ] 完整入口普查：Task、node、wrapper、workgroup、系统Agent、独立MCP测试台、Git／脚本和后台worker。
- [ ] Runtime能力矩阵：原支持内容全部具备等价证据；能力收缩逐项获批且正反例覆盖。
- [ ] 持久性：PG事务、内容chunk、配置/密钥、工作卷、重建、历史cursor／归档都对账。
- [ ] 身份：用户／服务token严格区分，ACL、首次admin、WS和现有权限／撤权验证。
- [ ] 稳定requestKey与副作用日志覆盖所有远程POST；每个崩溃窗口至多一个实际执行。
- [ ] 事件：producer类型穷尽矩阵、provider normalize、ACK后崩溃、MR乱序、transport迁移和两个重放语义。
- [ ] 权限和生命周期：preview、旧epoch、migration、rollback、恢复五动作及资源释放。
- [ ] 实际集群和浏览器证据与单元/mock证据分列；实际公网回调不以手工签名请求冒充。
- [ ] 记录aw提交SHA、CS合同SHA、两方CI、镜像digest、release/config/profile revision、数据备份及资源清理／保留回执。
- [ ] 全部AC通过后更新RFC索引、STATE与必要基线；未闭合项明确标阻塞，不给RFC-294未完成波次倒签。

## 4. 设计阶段记录（历史）

已核对aw当前main与CS已提交v3/恢复/事件合同，提出8个适配面及4个验证阻塞。按用户后续要求将三件套改为 A 切面重构 → A-G 独立验收 → B CS 独立 adapter／部署，补齐目录边界、AC00 和分阶段任务。按进一步确认，将 B 改为 M0 必须能力先部署 → M1 任务闭环 → M2／M3 逐项接入 → M4 完整收口，并增加 AC00B；RFC状态保持Draft。未运行测试、未修改生产代码、未触碰CS在制内容或本机已部署资源。

设计门状态：尚未执行独立设计门。本会话检索不到仓库要求的openai-codex评审工具；本轮文档对拍不冒称该门通过。按CLAUDE.md要求，后续设计门仅审功能正确性、完整性和用户可见行为，不开展安全相关检视。

## 5. 实施日志（当前状态）

- 2026-09-28：用户明确批准本 RFC 实现、部署和远端发布，目标保持完整接入，阶段顺序不变。独立设计门工具仍不可用，未记 PASS；继续已授权的入口普查和本地切面重构，不提前通过 A-G。
- A-T1 进行中：生成 [候选效果调用者清单](./seam-inventory.md)，覆盖进程、文件／路径、身份、后台效果和 webhook 的源码候选点。静态匹配不等同于语义闭环验收，各调用者仍须逐项确认 port／adapter 和回归。
- A-T2 第一批：新增 system-operations-owned `DatabaseConfigurationPort` 和 `infrastructure/local/fileDatabaseConfiguration`；启动 composition 可注入配置端口，现 CLI／daemon 继续用原文件实现；将原 config 文件机制原样迁至 platform/configuration，旧 config/index 仅 re-export，保留单一缓存与 API；恢复协调器等待异步配置读取，配置激活仍复用现迁移协议；真实PG迁移恢复用例改经bootstrap注入异步配置端口。补本地 adapter 的默认创建、配置切换、其他设置保留、读副本及错误传播行为测试。其余配置／generation／密钥／内容切面仍待完成，不将此批记为 H1／H6 完成。
- 首批检查：仅运行目标文件 Prettier／ESLint 与架构账本生成；正式测试待该批提交的 GitHub CI。尚无 CS adapter 生产实现，M0 尚未开始。

- 首批提交 `b172b1d47ae03cf1f081d09e5851ded1f39816f1` 已推送，CI `36366595075` 的 Markdown 检查发现16个 CS 相邻仓库文件链接在单仓 checkout 中不存在；后续修复改用固定 CS SHA＋源码路径／行号。同步移除首批四项已使用的账本增长声明，不扩大豁免。生产代码测试仍等待包含该提交的后继 CI 终态，不把原 run 记为成功。

- A-T1 新增[切面核对表](./seam-assessment.md)：区分已有 SkillRepository／PluginInstallerPort／仓库准备／runtime 管理合同与实际缺口；密钥字节入口直接复用，不重复设计。尚未完成全入口关闭。
- A-T2 第二批候选：generation 的 schema／digest／manifest／升级／恢复判定移入无文件 IO 的共同核心，现文件 API／原子替换保持；补两种 artifact source 的行为对拍。读取快照的中立视图已分离，异步宿主快照加载及 metadata 写入仍待接线，未据此宣告 H1 完成。
- 当前独立设计／实现门所需工具不可用，已向用户询问是否允许由独立子代理做只读功能评审；回答前不启动子代理，正常实施继续。

- 第二批候选检查：目标 TypeScript／测试文件 Prettier 和 ESLint 通过；确认 generation 原子写入段与已发布版本逐字一致。架构重采记录 owner 分母 +10 与只读工厂被既有 create 前缀规则计入入口 +1，新增两项一次性增长说明；正式测试仍交远端精确 SHA CI，未本地运行测试。

- 第二批已提交并推送 `6d865eb4ccc2918a389c7ca8595c9e82853cff9b`；正式 CI 为 `36367641292`，尚未取得终态。
- A-T2 第三批候选：provider runtime 提供已加载 artifact source 入口，PostgreSQL 不再要求虚假的本机安装路径；原文件入口委托同一严格校验和运行时创建逻辑。保留 standalone 升级／恢复 owner；新入口只解析已安装 generation，不运行迁移。复用原运行时生命周期用例对拍两种来源，补配置冲突、旧 schema／manifest 错误在创建连接池前失败及 SQLite 路径要求。异步 metadata 载入、迁移 Job 与全新 PG 安装语义仍待实现。

- 第三批候选检查：仅对变更源码／测试运行 Prettier 和 ESLint；以原 RFC-349 连接池生命周期探针对拍 file／artifact 两臂，未新增假 PG runtime 账本条目。架构重采仅 owner 分母 +3，上一批入口增长声明已退役；正式功能结果等待精确 SHA GitHub CI。

- 第三批 `68ecb2664a644982bf62a8b5bdce0828b3c5caf2` 已上库；正式 CI `36368150663` 尚待终态，之前被后继取消的运行不记成功。
- A-T2 第四批候选：安装准备的原有升级／恢复判定收归 system-operations application，新增 `DatabaseInstallationPort`；本地 generation／manifest／锁／复制恢复／provider 准备由 `infrastructure/local/fileDatabaseInstallation` 实现。旧 `prepareDatabaseSchemaUpgrade` 保留兼容接线；SQLite 和 PG 的准备回调等待异步锁与 metadata 提交。新增应用层时序回归，原 RFC-359 真实文件／双数据库恢复用例继续走同一编排。当前仍未实现 hosted metadata 存储、新安装及前台生命周期，不据此关闭 H1。

- 第四批补 composition 显式装配，`DatabaseInstallationPort` 的 consumer／provider／composition 均有生产接线；新增真实历史 SQLite 用例验证异步 metadata 提交前不返回 runtime、不释放升级锁。目标文件格式／lint 通过，未运行本地测试。账本中 module→platform 被既有规则记为 legacy-outbound，本次中立类型引用 +6、composition 历史加载 +1，按 exact 条目如实登记，不修改判据或给 W9 完成信用。
- CI `36368150663` 的 macOS backend shard 3 发现 RFC-349 functional evidence 仍绑定原 `test(...)` 声明，参数化改写导致静态证据失配。修复保留原测试名称，在该测试内部遍历 files／artifacts 两臂，保留功能覆盖及原证据绑定；不将失败 run 记成功。
