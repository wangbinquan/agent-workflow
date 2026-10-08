## 2026-10-08 retrospective-first：原 PostgreSQL rollback cause 探针

449 历史生产路径的三组回顾已实际消费：H1268 PASS、H345 / H7 有效 FAIL，各一项已确认功能 P2，原回执保留并交独立修复。后续 runtime / Node / CS 适配暂停至回顾修复与实际 exact-SHA CI 修绿。

本片 PG 探针只把同一注入 rollbackError 的身份断言放到原 DrizzleQueryError.cause，补原错误类和 rollback query；两个 outcome、原真实持锁 / server termination / cleanup ACK / revision / finally、SQLite、15 秒真实心跳和 60_000 用例预算完整保持。只做格式 / lint 与正文 / AST 保持证明；无生产 / canonical / census / 本机 AW 执行。有限实现门、精确发布与新 hosted CI 另验。H345-P2-001 / H7-P2-001 未闭合，完整 H7/A-G、CS M0～M4未完成，AW未部署CS。详见[探针设计](task-host-pg-rollback-cause.md)。以下原 plan 与所有并行输出逐字保留。

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
- [ ] 持久性：PG 元数据／效果日志、对象 ready／pin／域引用、配置/密钥、任务工作卷、跨副本／重建、历史 cursor／归档都对账。
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

- 第四批 `37a0e4978ff2c06211b4853c063ac9de6e86331f` 已发布，正式 CI `36368991331` 尚未终态。
- A-T2 第五批候选：设置 GET／PUT 收敛为 system-operations 公开应用合同，原配置语义校验／probe 失效／持久化／通知／日志／MCP 对账／并发池热更新顺序移入同一 application；新增异步配置持久端口和独立文件 adapter。SQLite／PG bootstrap 均用同一 composition；HTTP 不再接收 configPath 或读取文件。其余后台／启动配置调用者和耐久内容仍待迁移，不宣告 H1/H6 完成。
- 第五批验证：新增异步内存存储的保存顺序、写入中不可热更新、写入失败无通知、retention／默认 runtime 拒绝用例；保留原真实文件及双 provider HTTP 热更新测试，将原源码接线断言跟随应用层迁移。目标格式／lint 通过，未跑本地测试。W29 仅 PG 装配与 SQLite API 装配的 Settings 单格变化，语句数 165／65 不变，源码生成摘要重采；SQLite 总装配摘要保持原值。正式行为验收仍由精确 SHA CI 给出。

- 第四批 CI `36368991331` 的 Ubuntu backend shard 2 检出安装应用／port 仍直引 PG 迁移历史。第五批同时修复：history 由 composition 传给 local adapter，新增中立 `resolveRecoverySource` 端口返回逻辑 schema，原 bridge 校验留在 adapter；不扩大 provider-specific debt 允许表，既有真实 SQLite／PG 恢复用例继续覆盖。
- 第五批切面检查：配置持久 port 的 consumer／provider／composition 均 active；运行时校验和 MCP 对账通过应用自有依赖形状注入原命令，无新增 off-dag offered 边。架构账本按真实新增入口、public 合同、owner 和接线登记一次性增长；目标 lint／格式与 diff 检查通过，正式结果待 GitHub CI。

- 第五批 `6df459b60e7c52c6c7efbba982ba800a207b17eb` 已上库，精确 SHA CI `36370237803` 进行中。
- A-T2 第六批候选：把存储值默认回填、patch 校验与嵌套／数据库判别联合合并抽为 `platform/configuration/configurationValues`；文件 adapter 与异步存储回归 fixture 复用同一规则。非法 patch 仍先拒绝再加载配置；原文件缓存、原子写入和 RFC-276 迁移段保持。新增内存值／真实文件对拍，覆盖默认值、null 继承、嵌套值、provider 切换及 schema 默认、错误和无意外创建文件。此批不是托管存储实现，其余配置调用者／内容／启动生命周期仍待收口。
- 第六批候选检查：原 merge helper 段（仅两个导出标记）、原子写入段及 RFC-276 文件迁移段与第五批逐字核对一致；目标格式／lint 通过，未本地跑测试。架构仅 owner 分母 +4，其余本批无增长，移除第五批已消费增长声明。

- 第六批 `d725f7bda26627e944ea7de82308d968f6d5cbab` 已发布，精确 SHA CI `36370688213` 已排队。前一批 CI `36370237803` 的 typecheck 检出 shared 未导出 `RuntimeKind`；修复为消费现有 `RuntimeStatusEntry['protocol']`，不新增协议枚举或跨域依赖。此修复仅类型引用，退役第六批已消费的 owner 增长声明；等待后继精确 SHA CI，不将原失败记成功。

- 类型修复 `93a84cd1d277fa4a4cecd5d2e1458c8506039fcb` 已发布，精确 SHA CI `36370857680` 进行中。
- A-T2 第七批候选：新增配置查询 public 合同，维护状态、PlantUML、仓库缓存／组、任务详情和归档六组 HTTP 路由移除配置文件读取，支持异步按需查询。SQLite／PG bootstrap 分别装配一个原文件 reader，保持热读取及原回退；任务深度配置的读取失败仍回到默认 timeout，维护状态存在时仍不读 fallback。原双 provider HTTP 回归保留，补异步路由读、连续请求读新值、归档预览等待配置及维护状态优先回归。其余 public origin／登录入口、启动、后台任务和执行配置调用者仍待迁移，H1/H6 不关闭。
- 第七批候选仅运行格式／lint 和源码摘要／架构账本生成，未跑本地测试。W29 两个根各新增一个配置 reader 装配（PG165→166，SQLite API65→66），SQLite 总装配摘要不变；原 source guard 随深度配置函数的参数切面更新。架构计入8条接线、1个public合同及2个owner符号，不扩大 provider-specific 例外。

- 第七批 `943a08ad377216696da5a6e05590735da65ca85f` 已发布，精确 SHA CI `36371425603` 进行中；前序 `93a84cd1d` 的类型检查 job 已通过，整体 CI 当时尚未终态。共享 STATE 因并行 RFC-371 尚未发布链接而保留在工作树，不剥离其他输出。
- A-T2 第八批候选：文档／发现、OIDC public origin、PAT 创建和 MCP transport 的配置读取统一接按需查询；MCP 开关规则改读已加载配置值，原默认值和判断顺序不变。完成态 `ComposedAppDeps` 及 provider HTTP 装配边界只持配置 query，不再把 configPath 交给 transport；SQLite 将原 reader 上移到外层，与 API／公开路由／MCP 共用，PG 复用既有 reader。配置地址读取失败仍走原请求头回退，OIDC 登录、PAT 与 MCP 业务规则未改；后台／执行／启动与 intent 的文件读取仍待关闭。
- 第八批补异步发现文档新值与 MCP 开关、public origin 读取失败回退用例；保留原双 provider OIDC／MCP／文档 HTTP 回归。仅格式／lint、源码摘要和架构生成，不本地运行测试。W29 记录 SQLite reader 上移（外层46→47、API66→65）、PG166不变及完成态装配改传 query；mountApiRoutes／createApp 摘要不变。架构仅六条 legacy→public 类型接线增长，无新增公共合同、owner 或运行效果。

- 第七批 CI `36371425603` 的类型检查发现异步路由测试夹具的 Hono actor 上下文未声明、taskArchive 缺少必填 maxTreesPerSweep。第八批修复为独立 MiddlewareHandler 注入和完整归档配置；不改变生产行为，原失败 run 不记成功，等待后继精确 SHA CI。

- 第八批 `7859e770a328f949981256255cb16c169590c2d7` 已发布，推送后 main／origin/main 精确同步；CI `36372241796` 已排队，未取得终态。共享 STATE／索引与并行 RFC-371 工作完整保留。下一步继续启动、内容存储和剩余配置消费者切面，尚无 CS adapter 生产实现或 M0 部署证据。

- A-T2 第九批候选：Settings／CLI 数据库迁移 composition 改为注入既有 DatabaseConfigurationPort，默认复用原文件 adapter；迁移及回退的配置写入 Promise 返回原 coordinator，由原 admission 顺序等待完成。启动准备与手工迁移不再各自直写配置。安装 metadata／内容／前台启动等切面仍待收口。
- 第九批验证补齐原真实 PG coordinator 用例的异步目标／源配置写入屏障，验证写入前不开放下一个 provider。核对发现该旧用例未被普通 CI 的专用变量选中，现复用 resolveTestProviders／resolvePostgresqlTestUrlEnv，Ubuntu 双库通道实际执行；仅显式 SQLite 通道 skip，选中 PG 缺 URL 则失败。以既有真库用例相同方式清理 disposable 目标 schema，迁移进度断言跟随当前 schema contract，保留幂等重放和首次写入前回退检查。正式结果待本批精确 SHA CI。
- 第九批目标格式／lint 通过，仅运行源码账本生成；无本地功能测试。架构跨边与例外各减少一条，移除第八批已消费增长声明，没有新增长豁免。第八批 CI `36372241796` 当前已完成9项，尚无失败，仍未终态。

- 第九批 `bf71912e8d57db8f191e03985f6d592205331b6b` 已推送且 main／origin/main 同步，精确 SHA CI `36372660023` 已排队，等待终态。下一处已确认缺口：runtime-management 配置 port 的 current() 仍仅支持同步结果，默认效果工厂内直接 loadConfig；registry 启动的 legacy 默认值检查也仍接受 configPath。后续按 owner 分离并保持原探针／热读取和启动迁移语义。

- A-T2／H5 第十批候选：RuntimeManagementConfigPort 支持同步／异步读取，11处使用点等待当前配置；配置投影和既有探针队列收归 runtime-management/infrastructure/local/fileRuntimeManagementConfiguration，composition 可注入独立配置 adapter，默认仍走原文件。registry 启动旧默认值检查改接 RuntimeLegacyConfigurationPort，原始文本在应用中解析／判定，文件读取另有 local adapter；SQLite／PG 启动均显式装配，无业务层 configPath。
- 第十批回归：原双 provider 管理应用测试改用异步配置，新增无路径 composition、读取未完成前无探针、读取失败不删 profile；旧默认值测试保留真实文件路径覆盖，补异步文本拒绝／已迁移放行／不可读回退，boot 顺序和错误传播继续覆盖。仅目标格式／lint 与架构生成，本地未跑功能测试，等待精确 SHA CI。
- 第十批架构按既有规则登记2个 adapter 文件／工厂和1个port的owner增长、3个被计数的读端口／工厂入口及1条净新增bootstrap接线；无新增业务效果或平台DTO。启动全生命周期、内容和远程runtime执行材料仍待完成，不据此关闭 H1／H5／H6。

- 第十批 `e62fe79be9fd0539549088d6351b4ae5cf25fb98` 已发布且远端同步，精确 SHA CI `36373218652` 已排队。同 SHA 自动 maintenance-soak `36373218651` 为单独工作流，不替代功能 CI。
- 第九批 CI `36372660023` 类型检查发现测试的闭包写入不被 TypeScript 控制流识别，初值 sqlite 被错误用于后续 PostgreSQL 断言类型。修复为带 DatabaseConfig 类型的可变状态容器，保留真实双向持久化和切换时序断言；不改生产行为，原失败 run 不记成功。

- 第九批测试类型修复 `784c083acba8c919cf27a1a3da932276e37e1415` 已发布，main／origin/main 同步；精确 SHA CI `36373395839` 已排队。该提交包含第十批 runtime 切面，正式功能结果仍待终态；未部署 CS、未通过 A-G。

- A-T3／H8 第一批候选：直连 webhook 完成 provider 验签／归一化后，调用 integration-owned VerifiedWebhookIngressCommands；事务受理、终态唤醒、Event Center observation 发布、路由审计与重复投递修复从 HTTP 路由移入同一 application。SQLite／PG bootstrap 显式装配，缺失 dispatcher／secret／Event Center 时仍不挂载原入口；HTTP 层保留 body／provider／endpoint 解析及原状态码。没有 CS DTO 或生产 CS adapter。
- H8 回归保留 GitLab／GitHub 双 provider HTTP 到业务链路，并增加无 HTTP 的应用测试：持久受理前不能发布、重复重发稳定 observation、插入后发布失败释放原 UUID、重复失败不覆盖历史、无规则与终态效果审计分支。W29 只重采两处入口 composition 摘要，原路由顺序和运行句柄保持；既有 observer nudge 的 void-promise 条目随源码迁移，未改变计数／判据。业务人工 replay 仍有单独语义，CS receipt／ACK和transport迁移留阶段 B，不将此批当 H8 完成。

- 基线 `784c083ac` 的 CI `36373395839` macOS shard 3 检出 RuntimeProfileConfigurationCommands 没有生产 consumer：Settings 应用抽取后实际方法仍被调用，但 composition 只标了应用自有依赖形状。修复由 system-operations composition 显式绑定 runtime-management public 命令合同到 required port；保留依赖反转和原行为，不新增未消费合同豁免或业务层跨域绑定。原失败 run 不记成功。
- H8 首批目标 TypeScript 格式／lint 通过，架构按实际 application/public/root 接线计数，未改扫描器和未消费合同规则；无本地功能测试，最终以本批 GitHub CI 为准。

- H8 第一批 `065add7015056323f4f14dcfd49b1f16aa410e5a` 已发布并验证 main／origin/main 同步；精确 SHA CI `36374140357` 已排队，正式测试尚未终态。前序 `784c083ac` 的 public consumer 失败由该批修复，不将失败 run 记成功。仍无 CS adapter 生产实现或 M0 部署证据。

- A-T2/H1 配置消费者续批：MCP diagnostics adapter 不再持有 configPath／直接 loadConfig，改接只读、可异步的 runtime 配置投影。SQLite／PG 应用与 daemon 根明确装配既有 file query，测试台选型／默认 binary／profile 覆盖及快照逻辑不变。已有服务与真实 runtime 用例继续使用真实 file adapter，新增无路径异步 reader 的等待、热读、默认值／覆盖优先级和失败传播用例；工作区／本地进程效果仍待 H3～H5 收口，不宣称 MCP 已可在 CS 执行。
- 本批目标 TypeScript Prettier／ESLint 通过，W29 两个 composition 内容摘要随唯一配置绑定变化更新；未改其扫描／断言规则。架构 ledger 分母无增长：一个配置 legacy 直连移为 bootstrap file query 装配边；删除 H8 前批已消费的五项 allowGrowth。正式功能测试以发布后的精确 SHA CI 为准，不运行本地测试。

- MCP 配置续批 `b1258161ef173cb219578a653f58cdcd75a52d3b` 已发布，推送后 main／origin/main 精确同步；CI `36374739146` 已排队。前批 `065add701` 的 check 已通过，完整 CI 尚未取得终态，不能替代本批验收。未通过 A-G，尚无 CS adapter 或 M0 部署。

- A-T3/H2 HTTP 首批：新增 identity-access public `HttpAuthenticationParticipant`，共享 HTTP transport 只接 request facts／已准入 identity；SQLite／PG 组合根显式选择 local adapter，完成态装配允许替换认证机制。原 session／PAT／daemon 解析、WS credential 解析与重验函数迁至 `identity-access/infrastructure/local/localCredentialAdmission`，`auth/session` 保留兼容委托；13 个迁移函数体经只读 AST 比较与迁移前相同。HTTP 原公开路径、Bearer 语法、bootstrap 阻止及重叠请求合流归 local adapter。
- 新增真实双 provider fixture 覆盖无本地 Bearer 的异步替换 adapter 接线、原 local overlap 合流／完成后重新读取及公开登录路径；原 auth-session、PAT、bootstrap、WS dedup／revalidation 用例继续通过兼容入口执行。原路径文本断言随公开路径规则迁到 local adapter，未变更判据。WS query 凭据提取／完整生命周期切面仍待后续，H2 不记完成；无 hosted identity 或 CS adapter。

- 前批 `b1258161e` CI `36374739146` 的 Ubuntu shard 4／macOS shard 2 暴露 H8 迁移后的旧 source／manifest 断言，以及 Settings 的 runtime public 绑定被放在 system-operations composition 而不在 bootstrap。修复将显式 `RuntimeProfileConfigurationCommands` 绑定放回两个 provider root，system-operations 仅消费 required shape，删除该 DAG 外边，不加例外；RFC-310 精确 manifest 随真实 H8 路径更新，publisher-only 断言覆盖 route→application→composition 整链，禁止 endpoint-wide dispatcher 的原规则保持。原失败 run 不记成功。

- H2 首批与上述 CI 修复的目标 TypeScript Prettier／ESLint 通过，W29 五处摘要按实际装配更新。架构重采记录迁移后的实际 owner／legacy facade 边及1个已被消费的 HTTP participant；不修改扫描器、DAG 和未消费合同豁免。新 HTTP 测试包含实际 `createHttpRequestApp` 的异步 adapter 入口，正式功能结果等待本批发布后的 GitHub CI。

- 发布阻塞：本批精确暂存调用被自动审批服务拒绝执行，原因是 Codex 使用额度耗尽、审核无法完成（工具明确不是安全性否决）。尚未执行 git add／commit／push；复核共享 index 为空，HEAD 仍为 `b1258161ef173cb219578a653f58cdcd75a52d3b`。实现与修复全部保留在主工作区，已准备精确30路径 allowlist／commit message；等待额度恢复后重新 fetch、核对候选内容与共享 index，再按原授权发布，不绕过审批。

- 审批恢复核对：账户工具报告 ordinaryUsageAllowed，原审批流程下 git fetch 已成功；候选30路径摘要与封存一致，共享 index 仍为空。继续原授权的精确暂存／提交／发布，不改变审批方式。

- 前批 CI `36374739146` 已终态 failure：除上述架构定位外，已启用的真实 PG 迁移用例暴露完成后重复 start 仍先要求 SQLite 的原缺陷。本批在已校验 generation 绑定的成功迁移上返回原 operation；不同 target 仍拒绝，未完成／失败操作保留原显式恢复路径。回归继续保留真实迁移、异步持久配置和回滚，并补相同 canonical 请求的新调用 key、不同 target 拒绝及无重复 admission 效果断言。不删除用例或将失败当成功。

- H2 HTTP 首批及上述 CI 修复 `465987a332e74f8db29ede7405f2b6b5275fbc15` 已发布，main／origin/main 精确同步；新 CI `36376587910` 已启动，前批失败保持原记录。仍无 CS adapter 或 M0 部署。

- A-T3/H2 WS 续批：身份合同转归 identity-access public participant，本地 adapter 封装 query 提取、session／PAT／daemon、bootstrap 拒绝、重验 key 与到期读取；runtime-management 仅接收 bootstrap 所选身份 participant、继续拥有通道查询。WS 传输持有不透明内存凭据，由同一 adapter 负责 upgrade／open／主动重验及同步帧到期判断；原 epoch、重验合流、presence、通道 gate 与释放顺序保持。两 provider 根明确装配 local，兼容类型别名不再暴露本地 token union。
- WS 回归继续保留原多 token、provider transition、单次 lookup、presence 和重验行为套件；新增真实双 provider 的替换 adapter 用例，使用非 token query、不同凭据形状，覆盖异步 upgrade、open 重验、同凭据双连接合流和广播过期关闭。旧入口源码锁与实际 owner 迁移同步，不改变 REST 不接受 query 的判据。仅目标静态检查，正式结果以本批 GitHub CI 为准；不据此声称 CS 登录已接入。

- WS 续批静态复核补齐 RFC-305 精确 public／consumer 清单：前批新增 HttpAuthenticationParticipant 与 authentication composition 的条目、本批 WS 两个合同及 credential owner 迁移均逐条对应源码；扫描器和判据保持。架构净 public +2、exception -1、owner -2、import／mutation 数不变，删除前批已消费 allowGrowth，仅保留本批两个已消费 WS 合同的精确增长。W29 只更新 PG composition 内 token 从 WS transport 移到本地身份装配的摘要。

- 前批 `465987a33` CI `36376587910` 已完成 check；运行中的后端作业显示迁移已通过重复 start 和真实回滚，剩余旧断言把 active 表数固定为182（当前合同186）。改为核对回滚前后操作 tableCounts 保持一致，不再把 schema 演进误报为迁移失败。同时更新 runtime registry 接线文本锁以容纳并要求显式 public satisfies 绑定；补记 auth/session 兼容门面的4条精确 R1 边及具名退役阶段。移入 owner 的 Actor 投影直接返回同一对象，删除原兼容层多余类型断言，没有增补检查逻辑或改变认证行为。此批继续由新 SHA CI 验收，不将前批失败作业记成功。

- WS 续批 `51fed92c17735d570df994ae1a3320d9b8339011` 已发布，推送后 main／origin/main 同步。精确 SHA CI `36377661392` 已启动，maintenance-soak `36377661346` 单独记录；未取得完整终态，不记 A-G 通过。

- A-T2/H6 评审文稿切面：保留 collaboration 的 HumanGateArtifactStore／operation journal，允许 stage／finalize／cleanup 返回异步持久 receipt；准备、提交后发布及恢复全部等待效果完成再更新原状态。新增 owner-owned ReviewArtifactContentPort，DB reader 保留原 committed／completed 及 staged fallback 规则，字节读取归 file adapter；composition 可在无 appHome 时注入成对的存储／读取实现。standalone 文件路径、内容摘要、旧无journal文稿和恢复行为不变。
- 新增双 provider 真库回归：异步 stage 完成前仍 preparing／declared、finalize 完成前仍 committed／consumed 且 staged 可读、cleanup 完成前不清声明；无本机 home 的内容 reader 覆盖异步等待、staged→final、摘要失配、缺失、旧文稿与读取失败。原 finalize 失败重试用例增加异步拒绝。生产和测试的既有本地读取入口显式选择 file adapter，没有新 PG 内容表或 CS adapter；Skills／plugins／其他产物与全量存储机制仍待后续，不记 H6 完成。

- WS 续批 CI `36377661392` 检出 fixture 的 `Object.freeze` 对象未推导两个 credential 参数类型，以及 RFC-305 精确 import 清单漏记 server 中第二条 IA participant 类型导入。本批显式标注 `RealtimeCredential`，补齐实际导入条目；不修改扫描判据。原失败作业不记成功，正式验证交给本批精确 SHA CI。

- H6 评审文稿切面及 WS CI 修复 `f518f037323b3c18e3ef2acc058720bd4d5ff2c5` 已发布，推送后 main／origin/main 精确同步。CI `36378565660` 已启动，未取得整体终态；不记 A-G 或部署通过。
- H1 Intent 请求配置续批：九处轮次入口等待注入配置 query，保持各入口原读取位置；创建／预留前读取，取消入口仍先执行原取消再读取后继配置；dispatcher 的配置快照直接使用 Config 值。两 provider 根复用现有 live file reader，W29 仅重采这两处绑定摘要，装配语句数量及其余摘要不变。新增双 provider 真库用例验证异步读取失败不创建会话／轮次、非法 payload 优先拒绝，以及每次消息读取新预算且预算不足不预留轮次。其他后台、执行和 Intent 启动恢复读取仍未完成。

- Intent 请求配置续批 `345275ada20d9da042206da47494ac8480d8dda9` 已发布且远端同步；CI `36379106536` 的 check 作业已通过，整体仍在运行。前批 `f518f0373` CI `36378565660` 被后继发布取消，不作为完整通过证据；由包含它的后继 SHA 验证。
- H1/H8 Webhook 配置续批：integration-owned WebhookConfigurationQuery 支持异步值，端点 URL 展示及触发器保存验证移除 configPath／文件读取。两 provider 根复用原 live file query；端点写入仍先持久化再补响应 URL，列表逐项读取且保持顺序，读取失败仍返回原 null／默认 runtime 回退。新增双 provider 真库用例覆盖等待、公开地址热更新、各写响应与轮换以及读取失败；CS EventDelivery／receipt／ACK 仍留 B/M3。

- Webhook 配置续批 `3db623de22bd94c9fab82b5106d1e07a132191f1` 已发布并同步远端。CI `36379849533` 被后继 `640e4f4fb` 取消，不能记完整通过；包含提交的 CI `36379958665` 当前 Markdown 失败位于并行 RFC-371 demo 的本机地址链接，其余作业尚待终态，未改动该任务文件。
- A-T2/H6 技能读取续批：抽出 resource-catalog-owned `SkillContentReader` 和独立 file adapter，技能正文／文件树／单文件读取支持异步替换；catalog 显式装配，原直接调用保留 file 默认实现。版本选择、availability、正文解析和 metadata／token 仍由 AW 控制；原快照优先、旧 live fallback、文件错误和树元数据保持。补双 provider 的真实目录／catalog 替换、异步期间 metadata 更新、无 home 读取、失败与消失行回归。写入、版本发布／恢复和导入导出仍待抽取，不关闭 H6，也不开放 CS 编辑。
- H1 设计勘误：当前 `start` 已以前台运行，托管缺口是配置／安装元数据／控制文件和生命周期装配；复用现 `serveDaemon`，不另造 HTTP listener 或以消除 fork 作为本次成果。

- 本批只做目标文件 Prettier／ESLint、diff 检查与源码派生 census，未运行本地测试；文件树遍历函数与迁移前逐字一致。实际账本新增一个只读工厂入口、九个 owner 项和三条净 util 引用／exception，均逐项记录一次性增长；不改扫描范围或判断规则。正式功能验证交给本批 GitHub CI。

- 技能读取切面 `583820430aa05d1563a310d981c6fe411838679c` 已上库且远端同步；CI `36380693407` 被后继文档修复 `83ac30718` 取消，不能记成功。并行作者已修复 RFC-371 的本机 demo 链接，包含提交的 CI `36380839265` 尚待终态。
- A-T2/H6 版本内容续批：新增 `SkillVersionContentStore`，版本存储按 plan／stage／capture／publish／abort／discard 接线，现存 DB 四阶段状态机继续拥有版本号、操作日志、空写决定和提交。正文／文件增删、版本恢复、初始归档及 ZIP 覆盖改用平台中立的声明式变更；file adapter 保留原复制／指纹／快照／发布效果，旧 callback 仅由本地兼容 API 消费。catalog 与 ZIP composition 共用所选 store，没有 CS DTO。
- 本批测试补双 provider 真库的阶段等待、持久快照失败后补偿等待与补偿失败留待恢复、提交后发布失败再放行且不重复版本、空写等待和真实文件 adapter 异步增删／恢复／二进制替换。旧技能与导入／版本／崩溃回归继续走 local adapter；本地仅跑目标格式／lint 和源码 census，不跑功能测试。
- 边界仍明确：`StagedSkillVersion` 的旧持久 journal 词汇保持兼容，物理引用在版本漏斗内交 adapter 解释；启动 recovery handler、初始树准备／删除、history／ZIP create／统一资源导入及 legacy backfill 仍有本地依赖，后续必须按同一持久存储接线。不能仅注入本批 store 就开启 hosted 编辑或宣告 H6 完成。

- 候选源码复核确认 `commitSkillVersionInTx` 与前批逐字一致，未改 DB 提交或既有业务判定；目标格式／lint 通过，census 记录实际入口 +2、owner +11、净 util 引用／exception +1 并替换前批已消费的增长说明。后继 CI `36380839265` 的 Ubuntu shard 2 为文档提交后一次性 allowGrowth 过期（本批以实际新增长重新登记）；macOS shard 4 的唯一失败为既有全仓源码扫描超出 5s，本批不改扫描判据或预算，等待新候选正式验证。

- 版本内容切面 `9dec01277ac429240b91796e5cc16e83eebc45ec` 已上库并与远端同步，CI `36381850501` 已创建。发布后补查旧源码锁发现 `skill-version-atomic-publish` 仍把 swap 固定在 legacy 文件；续修同时锁定 AW→所选 store 的等待接线和 local adapter 的原子 swap，并在两处禁止非原子发布，不放宽原判据。此续修仅测试／记录和已消费增长声明退役，无生产变更。

- A-T2/H6 首次创建续批：新增 `SkillCreationContentStore` 与独立 local 实现，普通新建／ZIP create 改传中立内容，catalog 同时为 repository 与 ZIP 选择 creation／version store。统一 file 写树函数复用原二进制及主文档行为，删除重复 ZIP 函数。预留前纯 plan，initialize／discard 等待异步完成；AW 原 reserve→ready 与初始归档顺序不变，提交前清理失败仍释放 DB 预留，提交后错误仍保留待恢复操作。
- 新增双 provider 回归覆盖初始化／发布期间不可见、初始化失败等待清理及清理失败、计划失败零预留、post-commit 故障保留、bundle 阶段补偿，以及实际 catalog 普通新建／ZIP 与 live／snapshot 二进制字节。非文件 fixture 仅验证端口，不能替代 CS 持久化或真实部署验收。删除、history、backfill、boot recovery 和所有 bundle 调用者尚未收口，H6／A-G 仍未完成。
- `954f91f2ee9c5ce7a1b03ad516c389a5c8391e46` 的 CI `36382025085` 已检出三类需修复测试：SkillContentReader 用 plain Actor 传入 DirectAuthenticatedAuthority（本批改为真库用户的正式 admission）；RFC-347 exact 源码锁仍指向旧 auth/session（本批改锁唯一 localCredentialAdmission 与 compatibility composition 的实际入口）；Intent invalid payload 原契约为 422 而新夹具误写 400（本批纠正并增加 intent-invalid code 断言，继续锁零 config IO）。不为这些失败更改生产身份或 HTTP 合同，旧失败 run 不记通过。
- 本批目标 Prettier／ESLint 和源码 census 检查，未运行本地功能测试；实际 mutation 入口净增 1、owner 项净增 11，逐项声明一次性增长，其余账本按源码重采。正式功能结果仍以新候选精确 SHA 的 GitHub CI 为准。

- 2026-09-28 用户要求优先修复 CI，新增适配暂停。创建切面 `a9cba5f7c` 的 CI `36383302845` 类型检查失败于 ZIP 夹具缺少 `encoding: base64`；该遗漏已由后继 `78e3e9cca` 补齐，当前主干 `6aeb271f6` 的检查任务 `108865765242` 已通过类型／lint／格式／shared／system-mocks。完整 CI 尚未结束，不能以此宣告全绿。
- 当前 run `36403163358` 新失败为四份架构 provenance 摘要及 RFC-371 定价测试的四个历史幂等键误报。摘要由并行观测会话修复，本会话不重采含未完成历史读取重构的源码，也不接管其修改；仅按确切 commit/path/rule/line 登记已核实测试字面量。保留全仓扫描及既有判据，等待包含两项修复的最终 SHA 验证。

- 修复提交 `15b66b6d5` 的 CI `36404992960`：42 jobs success，但三后台分片 cancelled，聚合门失败，未达到全绿。Ubuntu 11/12 与 macOS 5/6 均停在本 RFC 创建清理夹具：`expect(pending).rejects` 在清理屏障释放前等待，测试无法走到 finally；改为立即挂接普通 Promise 拒绝观察器，先检查预留／锁再释放屏障，最后断言同一错误对象。所有原业务断言保留，既有版本存储测试采用相同非阻塞观察方式。
- 另一个 Ubuntu 5/12 分片持续输出通过用例至作业 15 分钟上限，测试阶段已耗 13m56s，未见失败断言；按仓库现有预算策略把 Ubuntu 后台 12 分片增至 16，保持全部双 provider 测试、单例串行执行和原作业／单测超时。此容量调整不用于掩盖上述屏障卡死。静态扫描、类型检查和原摘要失败分片在 `15b66b6d5` 已通过，新的完整候选仍须重新验收。

### CI 分片精确登记补齐（2026-09-28）

93f360dec / CI 36408910757 的 root-test-entrypoint 检查仍锁 Ubuntu 12 片；同步为已发布的 16 片，保留每片唯一、完整发现集、OS 与覆盖上传断言。RFC349 的分片和 schema 用例名引用由并行 RFC371 会话修正。本批另删除上一提交已消费的 MCP ledger allowGrowth，并用既有 provenance 函数更新摘要；基线仍为 395，不重跑含未提交适配代码的 census。正式验证继续只认最终包含提交的 GitHub CI。

### H6 历史内容读取续批（2026-10-01）

- 上轮 CI 修复已在包含提交 `8a509ffbc1ddd7693e7e788d3dd84653a9d982ec` 的 CI `36411046837` 取得 50/50 success。当前恢复阶段 A；本批不夹带 CS 生产 adapter。
- `SkillVersionContentReader` 承担指定历史版本的正文／文件树与 diff 字节读取，独立 file adapter 保留原快照路径、文件元数据与 NUL 二进制判定；catalog 显式注入。AW 继续选择和验证版本、解析 frontmatter、使用技能当前名称、计算原 git-style diff；不存在的历史内容不回退 live。
- 新双 provider 用例覆盖真实 catalog 的异步正文／顺序双树等待、无本地内容目录、版本缺失先拒绝、存储错误传播、真实文件元数据／二进制及缺失快照；沿用全部版本发布与恢复回归。仅执行目标格式／lint 和源码架构生成；正式行为待发布后精确 SHA CI。
- 初始版本 backfill、删除、boot recovery 与完整 bundle 路径仍依赖本地效果，本批不关闭 H6 或 A-G。独立评审工具在本会话仍不可用，未冒称门已通过。
- 重新阅读 CS RFC-035 `integration-contract.md` 与 `acceptance.md`：平台已记录对象上传／任务输入、暂停留卷、finalize 归档后原卷回收及卷后下载实机证据。AW 接入应使用服务域对象客户端、不可变 objectId／摘要、持久引用及稳定 requestKey；小型元数据归 PG，任务工作区归 `/work` PVC，服务零 PVC。当前只记录平台合同可用，B3 的容量／迁移与 AW 自身持久化方案仍须在对应 B-T0 冻结并验收，不以平台单独通过替代 AW 联合部署证据。

### H6 生命周期内容与操作恢复续批（2026-10-01）

- 历史 reader 批次 `c60e49975dba08818fd7368d654b3cd6e6d0fd04` 的精确 CI `36839289539` 已终态 50/50 success；原 CI 优先修复已完成，不将取消或局部成功当成全绿。
- 新增 `SkillLifecycleContentStore`、`SkillSnapshotInspector`、`SkillDeletionContentStore`、`SkillVersionRecoveryContentStore` 与独立 local adapter。初始归档、legacy 空壳清理、缺失 live 恢复、完整历史字节检查、删除暂存／补偿／回收、版本恢复的文件效果迁入 adapter；AW 保留版本和引用选择、完整历史判断、数据库阶段／authority、可用状态和锁释放。原路径、内容指纹、两次 rename 发布及既有错误判据保持。
- catalog 与 boot composition 显式选择这些实现。身份迁移屏障透传已选恢复端口给原 recovery driver，预留回滚也可等待所选 creation store 的 discard；完整身份迁移／物理归属预检仍是本地实现，尚不能据此声称 boot 可在零 PVC 服务中运行。
- 新增三组双 provider 回归，验证异步效果未完成时版本／可用性不提前发布、删除和恢复锁保留、失败后沿原操作及持久引用重试、元数据矛盾先拒绝、既有 live 手工编辑不覆盖、真实 local 内容恢复。额外通过真正 boot identity barrier 检验已选删除恢复 adapter 的等待和真实残留清理；原创建／发布／迁移回归保留。
- 仅运行精确文件格式／lint及官方源码 census；生成时在内存使用 HEAD 中的并行源码，未修改或纳入 RFC-371 在制文件。新增四个 file 工厂按既有 create 规则计入入口，两个 recovery 名称按既有规则计入后台分母，owner 净增20；实际增长按两笔发布协议声明并退役，不修改扫描判据。正式功能结果等待本批精确 SHA hosted CI，独立评审工具仍不可用，A-G 未通过。
- H6 仍有旧目录身份迁移、完整资源 bundle 及其余内容消费者；H1～H8 全切面收口、阶段 B 的 RFC035 对象方案冻结／独立 CS adapter、M0 与后续能力的联合实机验收继续。未部署本批、不关闭 H6 或整个 RFC。

### 生命周期 CI 配套修复（2026-10-01）

- `00367b19eb3d091bca9e83eac1b0b35bf2ca2835`／CI `36846302858` 已检出本批三类问题：删除夹具 `plans[0]` 在严格 expect 重载中可能 undefined；原 RFC345 的四条源码接线锁仍引用 `input`；canonical 产物混入并行源码。原 run 已终态 45 success／5 failure（含汇总失败），不记为成功，后续适配暂停。
- 删除回归先断言仅有一个已暂存计划，再核对同一个确定首项；boot 源码锁精确更新为 `selected` 并补四个默认 local adapter 的接线，保留唯一中立状态机／禁止 provider 孪生的原断言。没有改生产行为或减弱回归。
- 查明先前 fs 对象替换未影响 Bun 加载的 named import。修复仅在临时内存加载器接入官方 census 的 source read/readdir，按 HEAD 字节读取所有并行在制源码；仓库生成器、规则与他人文件不修改。生成后 `sourceDigest=sha256:e8aec5cb562cbe85c8ff5856fbc0e83ac347fbacc743231637237597bee8b4c2`，与远端失败日志自行计算的确切已提交语料一致；误混入的 opencode 清单标记同步恢复为 HEAD 的真实投影。
- 各 baseline 无增长，无新增 allowGrowth；只用原 provenance 生成协议更新摘要。两份回归的格式/lint通过，未运行本地 AW 测试/类型检查/构建。完整终态仍须修复提交 hosted CI；独立评审工具未恢复，不据此关闭 A-G 或 RFC。

### H6 身份迁移存储切面与 RFC-035 对齐（2026-10-01）

- 生命周期修复 `9887a0cd8af5e9dc7a94e2ea8ca6fe2f692b4c5f` 的精确 CI `36849001678` 已终态 50/50 success。恢复后续适配；原失败 run 仍保留为失败证据。
- 新增 `SkillIdentityContentStore`／`SkillIdentityInspector` 和独立 local adapter。迁移的源指纹／rename／回滚／完成，以及启动时目录归属、空壳清理、reserve／delete 内容检查和末尾目录证明由所选端口承担；AW 保留 metadata 选择、operation 判定、数据库阶段、引用、锁与孤儿行检查。既有本地效果和判据机械迁移，没有新增检查或 provider 孪生状态机。
- boot composition 同时选择两端口；身份迁移与 recovery driver 透传整个选择，等待所有异步效果后才提交下一阶段或释放锁。双 provider 回归覆盖无本地 home 的真实 boot participant、迁移未完成／失败、两种重启方向、DB 删除后空壳清理等待和 reserve v1 证明等待。原真实文件迁移／备份恢复回归保留。
- 静态对比确认 `assertOperationDbAuthority` 与 `writeCanonicalPaths` 迁移前后 token 相同；目标格式／lint通过，未执行本地 AW 测试、类型检查、构建或服务。正式结果交发布后的精确 SHA hosted CI。独立功能评审工具仍不可用，不记 A-G PASS。
- 按 CS 已落地 RFC-035 更新 proposal／design／B3／持久性清单，并补 [存储接入设计](./rfc035-storage.md)：对象字节由 CS 保存，元数据／域引用／效果日志由 AW PG 保存；区分 tree contentHash 与归档 sha256，先 ready／pin 再发布，未知写结果沿稳定键恢复。任务输入与活跃卷动态写入分别验收。M0 先部署、后续逐项收编的顺序保持。
- 完整 bundle／插件／其余内容消费者及 H1～H8 收口继续；本批不宣称 H6、A-G、CS adapter 或部署完成。
- 官方 census 记录本批真实分母：两个 create 工厂使 mutation +2；既有 sweep 名称规则使 background +1，没有新增定时器；两个原 ValidationError 引用使 observed import／exception 各 +2；owner 净 +18。逐项声明一次性增长，并在随后 ledger-only 提交退役；扫描范围和判据保持。

### 身份切面 CI 配套修复（2026-10-01）

- `d97f55dde9393464f4ca8f5cd5afdf1b7ffdee86`／CI `36854974478` 检出两处本批类型遗漏：机械移出的同步 graph helper 残留 `Promise<void>` 声明，reserve 夹具的已发布摘要仍被推为 nullable。改为真实 void 返回，先断言摘要非空再比较完整输入；不改变效果或数据库阶段。
- 同 run 还检出 RFC-371 的前端 exact 选项及 runner 观测夹具。前端由并行作者在 `f512dc321932e6be0b3453dfc6cc1b69c9bb9dd9` 修复，输出完整保留。本批 runner 的“独立投影”夹具显式报告 `reasoning: 0`，对应它原本断言的已知 output=10；保留全部输出、持久受理与不等待投影断言。生产归一化继续将缺失 reasoning 表示为未知，没有放宽判据。
- 格式／lint通过；通过 scoped source transport 仅生成 HEAD＋本次 inspector 修复的候选，未混入下一批 package reader 的未提交代码。全部 baseline 无增长、allowGrowth 为空，原扫描规则保持。后续适配暂停发布，完整终态由包含修复及并行输出的精确 SHA CI 给出。

### 身份切面平台清单修复与资源包候选（2026-10-01）

- `7e33d3d415dbbe672eb9445be4020bb593cdff17`／CI `36858098007` 已取消；macOS shard 1 的两条原目录 identity 比较允许记录尚指向旧 legacy 文件，原失败仍保留。并行作者在 `eef12e256408a54d5e52c351c23e4ebea9fdeb32` 将两条记录迁到实际 local adapter，匹配数量与原判据不变；同时保留其观测／E2E 修正。该提交 Windows platform `36862619599` 已 success，主 CI 36862619605 已 completed/success、50/50；本批不重提或覆盖其输出。
- 资源包候选新增 `SkillPackageContentReader`，原文件字节与目录判据移入 local reader；AW 保留可用性和 DB 版本选择、主文档投影、全路径排序与二进制复制。两种 provider 共用同一选择，未就绪技能在 IO 前拒绝，异步存储错误不回落本机。
- 原资源包工件合同下沉 `application/package/artifactOwners.ts`，旧类型与工厂入口保留兼容。文件效果独立迁入 `infrastructure/local/fileResourcePackageArtifacts.ts`，composition 可选择 skill/plugin artifact owner；所选 plugin owner 不再被迫提供 local installer。恢复 composition 复用已有 recovery port，默认 SQLite 统一格式／legacy 回落与 PostgreSQL 实现保持，不新建状态机。
- 双 provider 新回归经真实 package apply／journal 检验 persist-before-stage、暂存与发布／完成尾部等待、非文件引用写入、提交前补偿等待、提交后错误保留 committed 行及选定恢复重试；两种 maintenance composition 保留 active attempt 并等待补偿后才 settle。原真实文件、七臂及幂等回归继续生效，原源码锁随 local 位置／reader 接线迁移，不降低断言。
- 精确格式／lint通过；机械 AST token 对比确认文件工件 owner 效果主体与提交版本一致，仅位置／合同／兼容名称变动。正式类型与行为仍交本批 hosted CI；不执行本地 AW 测试、类型检查、构建或服务。官方 census 记录实际 mutation +1、observed import／exception 各 +2、owner 净 +8，分别给出一次性增长说明，发布后按既有协议退役。
- 上述完整 CI 修复已收口，本批按精确路径发布，正式结果等待资源包候选确切 SHA CI。独立评审工具不可用，不能记 A-G PASS。其余 H1～H8、CS 独立 adapter、M0 首次部署和后续完整验收继续，RFC 不关闭。

### 资源包 CI 修复与 Intent 在制边界（2026-10-01）

- 资源包源提交 `e945204a80f3130d4ceae532ceafca4bf011d949`、账本 `0fb4894be2533f6c87e587a8b22b2a04898c84df` 已同步远端。其 [CI 36868540371](https://github.com/wangbinquan/agent-workflow/actions/runs/36868540371) 已 completed/failure、43/50；lint/typecheck 与五个后端分片的实际失败归为三个遗漏，原失败回执保留。
- 新测试导入了不存在的 `buildPackagePreview`，改为已有 `buildPackagePreviewFromReadPort(provider.reads, …)` 并提供真实 importId；同时按既有 parse 合同补齐插件 fixture 的 pluginSources 声明。未修改预检或包解析判据。
- RFC-345 原三参 reader 源码锁迁到四参接线，并固定同一输入的所选 reader／file 默认值；其余七臂、生命周期和服务依赖约束保持。W29 完整装配摘要只因已发布的两处 `NonNullable` 方法形参类型变化更新；保留 166 条语句、原顺序、全部相位与实例断言，未放宽摘要算法。独立 AST token 对拍确认完整 PG 装配的 runtime tokens 与 `eef12e256` 完全一致。
- 并行文档提交 `993ab7ce694988536ecf600d9e4a874901e5ea41` 原样保留，来源和远端已核对。本批精确提交三个修复测试及所需文档／官方证据，scoped census 从 HEAD 读取未提交 Intent source；不把其在制效果或新增合同混入修复。正式结果交本批确切 SHA CI，本地不执行 AW 测试、类型检查、构建或服务。
- 后续 Intent 中立工件合同、local 效果迁位、所选异步内容／恢复接线及真实双 provider 回归处于未发布候选；当前先修复资源包 CI。独立评审及 A-G 未通过，阶段 B／M0～M4 尚未交付，按用户要求持续推进完整 RFC。

### H6 Intent 内容、旧日志恢复与 scratch 续批（2026-10-01）

- 资源包 CI 修复已精确发布 `13f5b8e33350ba6159f85edd6eec1810750ef2e4`，对应 CI 36874167121 等待终态；未以失败旧 run 或未终态 run 关闭 CI。修复未提交本节 source 候选。
- RC 原有 Intent 工件／stage／publication／owner 合同下沉 `application/intent/artifactOwners.ts`，三个具有真实跨域消费者的中立类型由 exact `public/types` 提供。事务参数改用现有 `DatabaseTransaction`，文件工件效果迁到 `infrastructure/local/fileIntentApplyArtifactOwners.ts`，旧工厂／类型路径仅兼容出口；没有第二套资源事务或发布状态机。
- Intent-owned `IntentArtifactContentPort` 承担插件内容存在／丢弃、技能内容发布／丢弃与旧格式补偿，local 实现独立落位。AW 保留 DB 元数据／快照检查、版本选择、journal 解码及收敛、错误隔离和已提交回执；由 AW 先判断 current／superseded，再把事实交存储，adapter 不复制版本业务判据。
- apply composition 可独立选择 skill/plugin owner、内容生命周期及 legacy 兼容端口；boot/hourly recovery 复用同一选择入口，保留自定义 pluginsDir。旧格式继续按整批撤销 boot 标记、逐条等待发布、原事务收尾顺序恢复；默认 standalone 仍使用原 file 实现。
- `IntentScratchStore` 只拥有 stale listing／remove，file adapter 机械迁位，旧名称保持兼容。维护 composition 允许选择异步 store，等待列举及删除后才推进原计数和 swept 标记；running 与失败删除仍排除。旧 application/maintenance 的直接测试兼容入口、turn 执行 scratch 物化及其他内容消费者尚待后续收口，本批不关闭 H6。
- 新真实双 provider 回归覆盖创建／更新、persist-before-stage、owner／content／complete 等待、幂等重放、提交前双层补偿、提交后错误与重试、AW 元数据／superseded 判据、selected legacy 整批发布、boot 原生／旧格式与 active fence、scratch 异步等待／运行／失败／recent 保留。原真实文件及 RFC271／355／359 行为锁保持，源码路径锁随 local 迁位。
- 机械对拍确认 RC file owner、Intent 原文件效果、legacy replay、journal convergence、apply engine 与资源事务主体的 runtime tokens 保持；scratch file 工厂效果主体逐字相同。仅精确格式/lint和官方源码 census，本机不执行 AW 测试、类型检查、构建或服务。实际 census：mutation 1781→1782、observed imports 5585→5590、exception 4962→4960、public 1030→1033、owner 25573→25587；真实增长按既有协议逐项解释并在发布后退役。
- 正式行为等待本节发布后的确切 SHA CI。独立评审工具仍不可用，未记设计门／实现门或 A-G PASS；H1～H8 余项、CS 各 owner 独立 adapter、M0 首次部署及 M1～M4 验收持续推进，RFC 保持 In Progress。

### 资源包 CI 第二轮夹具补正（2026-10-01）

- `13f5b8e33350ba6159f85edd6eec1810750ef2e4` 的 CI 36874167121 已有后端失败，整体终态尚待回执；原三类导入／类型／源码锁遗漏已通过。Ubuntu 2/16 的真实包解析指出新夹具 opId 使用 `op-storage`，与既有 `op-<n>` schema 不符；改为 `op-1`，包解析、预检、storage 效果及原状态／等待断言均不变。未发布 Intent 同类夹具同步纠正，但不混入本次修复提交。
- macOS 1/6 的既有 RFC294 E9-C 崩溃重放用例第一次在固定 50ms 后未进入 launch，第二次随后看到了延迟的 `execution-2`。改为等待 core 明确到达 before-task／after-task 对应崩溃位置，再推进租约时钟与重放；after-task 必须先完成真实任务行写入。保留所有 execution-1、单行、admission 与内核零重复调用断言，不增加重试或修改生产派发。
- 两份修复测试精确格式／lint通过。官方 scoped census 从 HEAD 读取 Intent 在制内容，baseline 无增长；仅发布测试、文档与 provenance。正式结果以本次修复 SHA 的完整 hosted CI 为准，不把当前失败或可能被后继自动取消的 run 记成功。RFC 全部实施与部署持续，A-G 未关闭。

### 配套 CI 回执与下一批边界（2026-10-01）

- 第二轮夹具补正已发布 `ce8a6310adb9576559f4d5100d4916635a104720`，CI 36876744628 进行中。前继 `13f5b8e33`／36874167121 因后继 push 自动取消，终态为 cancelled、34 success／4 failure／12 cancelled；三处后端失败均已取实际日志，分别为包 opId 和崩溃位置固定等待，不以部分绿关闭。没有手工取消 CI 或降低门禁。
- Intent 内容／scratch 候选已经完整准备，scoped 官方 census 仅纳入其 21 个源码／回归路径；从 HEAD 读取下一批任务配置在制内容，未纳入其新增文件。正式发布等待上述 CI 修复完整终态通过，避免夹带后续 feature。原 `op-storage` 同类 Intent 夹具已经按实际 shared schema 改为 `op-1`。
- H1 任务操作配置下一批候选：TE-owned `TaskOperationConfigurationQueries` 只提供当前 binary 路径与 commit exclude patterns。原文件读取包在独立 local adapter；AW 仍负责 mint-time 冻结、每次 operation 数组快照与读取失败时的 launch fallback。六个 node／wrapper／commit 冻结调用及 commit policy 调用均等待所选 query。
- 所选配置能力由 driver 在每次 drive 注入，包括子任务；不进入持久 child run-config 包，原继承清单保持。legacy 文件路径入口仍选择原 live file adapter，所选 query 失败不回读本机。下一批新增真实双 provider／双 runtime 冻结回归、异步等待、配置修改后的旧快照／新节点、commit 数组与 fallback、无文件读取及继承边界回归；本地仅精确格式/lint，未发布或运行正式测试。
- 任务启动 policy、上传限制、后台热读、CLI 生命周期及其余 H1～H8 仍继续收口；本节不关闭任何全切面或 A-G，CS adapter 与 M0～M4 顺序保持。

### 独立功能门备选回执与 H8 多 source 补正（2026-10-01）

按仓库明确的独立子代理备选完成两个精确候选实现门：Intent 21 路径、任务操作配置14路径均有限范围 PASS，未运行本机功能门禁，正式结果仍待各批 exact-SHA CI，不关闭全 H1/H6/A-G。设计首轮仅 H8 单 producer→单 endpoint 的一项功能遗漏；已补来源配置/多路由/逻辑事件完整冻结集合/逐目标持久受理，不合并原 endpoint 规则与观测。八个多 source、局部恢复、跨订阅、路由变更及 MR受理→两类观测间崩溃场景纳入 B-T5；修订稿独立设计门已 PASS，完整 A-G 尚未通过。详见[独立功能门记录](./functional-gates.md)。原工具不可用和历史门状态保留。

资源包第二轮修复 `ce8a6310adb9576559f4d5100d4916635a104720` 的主 CI 36876744628已 completed/success，50/50作业全部成功，headSha完全一致。前继13f的 cancelled/failure 历史不改写；本轮已恢复主 CI，再发布有有限独立功能 PASS 的 Intent 内容/scratch 候选及 H8 设计补正。下一批任务操作配置14路径保留且从本批官方census排除，不混入本批提交。

### Intent 配套 CI 六类遗漏修复（2026-10-01）

Intent 源提交 `497149ad2ad04b42fbc4d7902036b019be8ed880`、账本后继 `2d65a16f5152936ec93de1f0fd362a671e89e44d` 已精确同步远端；[CI 36882578362](https://github.com/wangbinquan/agent-workflow/actions/runs/36882578362) 终态 failure、38 success／12 failure，报六类配套遗漏，暂停后续 feature 发布。将两个 owner 移到 participants 出口，artifact 数据留 types；publication 只接现有 neutral transaction callback，移除两处强转，保留同一事务与 effect 主体。更新移动函数路径、下沉合同的类型依赖和两工厂改名后真实语料下限（函数66／adapter62），原扫描、零孪生、生产消费者及 fixtures 不变。十路径独立有限功能实现门 PASS，详见 functional-gates；正式结果继续等修复 SHA CI。

官方 census 只读取已提交源码加十路径修复，排除任务配置／后台配置18路径候选和其他并行内容。owner／public 等基线没有新增长，observed import 5590→5589、exception4960→4959；仅源码生成与精确格式/lint，无本机 AW 功能测试／类型检查／构建／服务。完整 RFC 和部署继续，A-G 未关闭。

### Intent CI 恢复终态与 H1 任务配置续批（2026-10-02）

修复 `a4b706b942adfc9ca16c15e329ba1f7fa97f78f8` 的 [CI 36886742257](https://github.com/wangbinquan/agent-workflow/actions/runs/36886742257) 因并行文档 push 自动取消，终态48 success／1 cancelled／1 failure（汇总），不能写全绿。包含修复的后继 `8d7e078e31527a3b70c5058af9fb25c4b23ff1f4` 的 [CI 36890491336](https://github.com/wangbinquan/agent-workflow/actions/runs/36890491336) 已 completed/success，全部50个作业 success；祖先及两份 RFC371 文档差异已核对，修复源码没有改变。原失败和取消回执保留。

本次 H1 候选覆盖33个精确源码／测试路径：任务操作配置的六处异步 mint 冻结及 commit patterns 热读；任务后台的启动、四类 tick 热读与 startup/drain；任务 launch 的 commit/runtime/child 三次独立读取、subagent 和 upload 限制。三个 owner port 与三个独立 local file adapter 由 composition 选择，AW 保留每段投影、过滤、默认和失败回退；所选 source 不回读文件。同步 standalone helper 和原25处同步启动回调保持。

协调器在 attach 后等待异步 runtime；读取失败报告并释放，等待期间取消则释放而不进入 admission／准备／执行。独立复核发现所选 source 删除 optional 配置时 boot deps 残留；现只使用本次 launch 投影，并保留宿主 binary override／configPath／memory participant。双 provider 回归覆盖带 boot 配置的删值与三段独立失败。原三个策略投影的 AST runtime token 等价；目标格式/lint通过，真实双 provider／双 runtime 新回归正式结果交本批 exact-SHA hosted CI，本机未运行 AW 测试／类型检查／构建／服务。

官方 census 从已提交源码加33路径候选生成，排除并行 RFC371 内容。真实计数：mutation 1782→1787、observed imports 5589→5608、对应 exception 4959→4978、public symbol 1033→1043、owner 25587→25619；各增长按原 ledger 规则记录 RFC370 一次性依据并于后继账本提交退役，不改扫描规则或现有门槛。此批不关闭全 H1、A-T2 或 A-G；H3～H7、完整入口普查和 CS adapter／M0～M4 按已批准顺序继续。

### 任务配置 CI 配套修复（2026-10-02）

本批源 `4f8244883a30bdbb4e17e431161cb2b96848f72f`／账本 `dd94236a4cdbf08ad41881332db55e94316bcfe6` 的 CI36924136910 已终态 failure，41 success／9 failure，保留原完整回执，不写全绿。新 launch 测试在 standalone buildStartTaskDeps 用 drive-only 夹具，遗漏 SchedulerDriverPort 三个必需方法，改用原完整 createNoopSchedulerDriver。共享 public/queries 完整文件还保留了并行 RFC371 的 positions 合同，该配套 Task owner 实现先前漏提；本修复保留其当前完整6行并行输出并补独立双 provider 同时间／逐项游标／空 cohort 回归，不剥离已提交合同。

另三处旧源码 oracle 仍锚移动前 resolver 或旧协调器 getter，现移到实际 TE 策略／单一解析点，保留字段／类型／唯一 spread／禁止 boot 冻结断言并加 selected 与 legacy 两臂。任务 INSERT 四站点及三血缘列均完整，只更新两个漂移行号。五条 local composition 兼容入边按原 R1 exact 规则记录 why/owner/A-T7 退役，255→260；不增加目录豁免或放宽 scanner/fixtures。官方 scoped census 只纳入10个修复源码／测试和精确登记，H3新候选及其他 RFC371 WIP排除，所有 ledger 数值不变。正式效果继续由修复确切 SHA hosted CI 验证，本机没有 AW 测试／类型检查／构建／服务。

最后四个后端分片还报告 RFC287 T14 导出类型旧位置、RFC332 两处单微任务假设，以及 macOS RFC363 完整迁移历史超过默认5秒（5048.83ms）。导出合同断言移动到 TE 类型并加 legacy ReturnType 两字段检查；两个测试改等真实 continuation/effect started 事件，原未结算／顺序／释放断言不变；只给该迁移用例20秒明确上限，完整历史和拒绝判据保持。

H3 工作区维护6路径候选仍在制。独立复核发现异步 exists 旧快照可绕过新 pruning claim 提前 heal；将修正 shared SQL 原子条件并补真实双 provider 交错回归，再单独复核／发布。本次修复不提交该在制候选，完整 RFC、A-G 及 CS M0～M4 继续。

### H3 工作区维护异步切面（2026-10-02）

沿用原 SC WorkspaceMaintenanceFilesystem、Node adapter、SQL store 与终态清理状态机，开放所选 filesystem；exists、三个列举和 materializing 可异步，全部调用点先 await 再使用，所选 adapter 不回退到本机。原回收年龄、活跃任务／物化保护、失败 claim 和完成顺序保持。

独立首门发现旧 recovery exists 快照与前台 resume／取消／finalize 交错：远端物理删除尚未确认时，旧 false 结果可提前 heal。补写 SQL 现在原子核对无 pruning claim、仍终态／未删除、同一 worktreePath 与 lifecycleEventRevision；两个应用调用点传枚举快照，复用已有生命周期 revision，不新增迁移或第二种 authority。六路径修正后由独立 `/root/intent_functional_gate` 有限 PASS，指纹 `51e83940efeca6a06c7ef9b3fe2b939ef3c18b0df45ba449ff3c3a1100e010c6`。

新增真实双 provider 回归含异步 false／异常重试、四种过期快照与两实例清理 ACK 成功／失败交错：确认前及失败后 pruned=null、claim=claimed，真正持久重试确认后才完成。保留原 selected listing／materializing／iso active 判据及真实 local 维护测试。官方 scoped census 只纳入此六路径，所有 ledger 数值不变；本机仅目标格式/lint及静态语料生成。修复 `c028b22c4a9a5281aa9013d4fac058c343f3a4f3` 的 [CI36928636248](https://github.com/wangbinquan/agent-workflow/actions/runs/36928636248) 已 completed/success，50/50 job success；现发布本批，行为继续交本批 exact-SHA hosted CI，不以有限复核替代正式行为。其他 H3／A-G、CS adapter、M0～M4 仍继续。

### H3 恢复预检存在查询切面（2026-10-02）

SC-owned `WorkspacePresenceQueries` 与独立 file adapter 只提供同步或异步物理存在事实。TE preflight 逐项 await；保留准备未完成409、无任务不探测、多仓任一存在即短路和原410。Legacy resumeKick、SQLite 工作组 continuation 与 PG 工作组 continuation 可使用所选查询；包装调用保留 adapter 的 this。普通 `/api/tasks` resume 另经共用 child lifecycle admission，其物理检查仍未切换，下一批沿实际 bootstrap 接线，不能据本批关闭全 resume/H3。

十路径由独立 `/root/task_config_functional_gate` 有限 PASS，指纹 `ada4b1d9492b69d8aae8bd62ba362ca97d64eadd4fa81664e5b2d3f12c049e15`。新真实双 provider 回归检验 pending/false/reject、409 不探测、多仓順序/短路和真正 workgroup composer；local adapter 真实文件存在/缺失/空引用保持。PG 166 statements/order 的全体 AST 除唯一 worktreeExists 绑定外逐字等价，W29 原逆变换摘要精确迁移，SQLite 两摘要不变；INSERT 血缘四站点只跟随实际行号2467，全部列判据保持。

官方 scoped census 仅纳入这十路径，mutation +1、imports +5、exception +4、public +1、owner +4，各按原账本协议登记并后继退役。仅目标格式/lint与静态源码生成，无本机 AW test/typecheck/build/service。维护前批 `65db0c7710ed527663010112385b93c38f3e3323` 的 CI36931610730 尚待终态；本批行为交新的完整 hosted CI，取消/失败记录分别保留。A-G、CS adapter、M0～M4 仍未完成，RFC 持续。

### 普通 resume 候选与存在查询 CI 源码登记修正（2026-10-02）

普通 resume 的 11 路径候选已获独立有限功能 PASS，指纹 `0d867898de6af0ebef9b3b838b0f72d9bc6f1af588fd2582cb9488734cd52217`。真实 SQLite/PG bootstrap、child lifecycle admission 与工作组复用所选 WorkspacePresenceQueries，逐项 await、保留 this、phase 优先拒绝与多仓任一存在短路；host capability 不进入 ChildResumeRuntime。新增真实双 provider 回归只验证 admission/source-closed 边界，不冒称已运行 AgentTaskEngine。尚未发布，不据此关闭完整 H3。

存在查询已发布 tip `e3b656a10e2bae30c2c51994d565bbcc649efed6` 的 主 CI36932108422 已 completed/failure：47 job success，两 backend 分片失败和汇总失败。两个分片均仅是同一 INSERT 来源行号登记 `services/task.ts:2467` 与格式化后真实 `:2466` 不一致。原四个写入站点和三列血缘完整；修正仅更新该行号，保留逐字/列完整性/新增站点等断言。正式恢复仍等修复提交的 hosted CI，失败历史保留。[Windows surface36932108486](https://github.com/wangbinquan/agent-workflow/actions/runs/36932108486) 已 completed/success、headSha一致。维护提交65db的主CI取消，不记该精确SHA成功。

按只读剩余依赖审计收束 [八个阶段 A 实施组](./remaining-a.md)，不新增平台业务耦合、不改 A-G 或 M0～M4 顺序。共享架构清单已与 RFC371 原会话按用户授权协调，双方源代码保持；其 c2c96cef4 发布后，本候选登记已重新生成，imports5615→5620、exception4984→4987、owner25648→25647，仅前两项实际增长按原协议登记/后继退役。其他有限候选源码均排除。

行号修正 b8995791eb0eb177f944b04166c1e4922d7b3690 和三条已消费观测增长许可的退役后继8cb41fdfa9331183e4a27f32cedfd94b967fbb00均已同步远端。退役不改计数、源清单或历史说明；CI36938903292 正式终态仍待验证，不能以静态对拍替代。普通 resume 与其他 feature 候选先等 CI 恢复再发布，持续推进不冲突的 A 实施。

### 阶段 A 八个有限候选的发布准备（2026-10-02）

普通 resume 11、经典目录 availability 10、插件 local 5、selected boot 2、DE 程序读取3、DA evidence读取6、终态复活11、安装示例完成6，共54个不同源码/测试路径；每组独立有限实现门及指纹见 functional-gates。各自保留原业务、standalone local 和真实 provider 回归，不以这些有限门代替完整 A-G。boot roots 的终态 presence 贯穿仍为下一步；其余八实施组按 remaining-a 持续。

官方 scoped census 从共享 main 已发布语料加上述54路径生成，所有其他在制源码排除。真实计数 mutation1788→1792、observed imports5615→5627、required port36→37、exception4984→4991、public1044→1047、owner25648→25670；六项实际增长按原协议记录一次性许可，源发布后后继退役，不改变扫描规则。seed wrapper 的一条 exact default composition 入边登记 why/owner/A-T7，commons inbound260→261；TE default presence 的跨域内部边明确保留实际分类和 A-T7 注入退役依据，不虚报为零耦合。

前继8cb的 CI36938903292、6b42a9de6 的 CI36940613451 已发现 RFC371 测试夹具的类型／前端失败，不记全绿；并行前端修复完整保留。后端三处测试类型遗漏已作单文件功能修正并经有限独立 PASS，精确上库同步 `0120088f8557ef7357b69e0d0294dd5575d3c842`，完整共享 RFC371 文件含其原并行输出。正式恢复等待 [CI36942147693](https://github.com/wangbinquan/agent-workflow/actions/runs/36942147693)，只有恢复后再发布上述功能候选。仅目标格式/lint与官方静态生成，无本机 AW test/typecheck/build/service，RFC/M0～M4 未关闭。

### CI 范围 URL 修复与后续 local 候选（2026-10-02）

0120088f8 的 CI36942147693 已 completed/failure（45 success/5 failure），静态类型修复通过；三平台观测 E2E 与 macOS multipart timeout 仍红。只发布经有限独立复核的观测 search transport 三处修正，main/origin 同步3ac730f84；正式恢复等待 [CI36945626088](https://github.com/wangbinquan/agent-workflow/actions/runs/36945626088)。单文件首次有限FAIL和修正PASS均留 functional-gates；macOS clone未修改预算、未宣称解决。

journaled repository preparation 七路径和员工 local 内容四路径各获有限PASS，仍独立未发布并排除八批54路径canonical。本批冻结源指纹均不变，仅CI基准/证据与文档更新；恢复CI后按原八小批、真实治理增长及后继退役发布，再贯穿终态presence roots并继续八实施组。无本机AW test/typecheck/build/service，A-G、CS adapter和M0～M4持续，不关闭RFC。

### CI 恢复终态与八批发布（2026-10-02）

修复基准 `3ac730f84c9430459efb6d8fe72a6db9f5e8a1ed` 的 [CI36945626088](https://github.com/wangbinquan/agent-workflow/actions/runs/36945626088) 已 completed/success，50/50 作业 success，headSha 严格相同；观测 E2E 三平台及 macOS multipart 分片通过。multipart 单次停滞原因未确证，未修改预算或把重验成功冒称原因修复。原 012 的失败与所有有限门历史保留。

八批54路径源内容不变，现在短发布临界区按八个小 source commit、canonical/docs、六项真实增长许可后继退役发布。官方语料仍只包括这54路径；新 journaled preparation7、员工 local4、物理插件6、generation GC3 的有限 PASS 候选继续独立在制，全部排除。插件首四路径 source oracle FAIL 与纠正后的六路径 PASS 均见 functional-gates；后续必须登记其实际兼容入边。发布后先验证新 exact-SHA CI，同时贯穿终态 presence 的真实启动根和员工附件异步完成事实，再继续 remaining-a 全组，完整 A-G 与 B/M0～M4 不提前关闭。

### 八批发布与配套 CI 修复（2026-10-02）

实际十个小 commit 的 tip `165bb447dc0a8bc4f8e0e8ce9698512791a7477d` 已同步远端，发布回执确认其他所有在制文件字节不变。主 CI36948285794已终态43 success/7 failure；同 SHA maintenance36948285743成功。五个实际后端失败分片与 Typecheck 日志收齐，范围是作者 async closure type narrowing、证据夹具 DirectAuthenticatedAuthority、两个新增零消费者 type 出口、SO 精确 public 目录名和 TE file default 经 SC barrel 的实际 value SCC。没有修改扫描或既有功能判据，也没有取消原运行。

前三路径有限 PASS 后，将后两类遗漏补入六路径修复，完整候选独立有限 PASS。narrow SC composition 精确导出原 file factory，TE 只改变默认 import；所选实例、默认行为和业务状态机不改。官方 scoped 只包含六路径，TE value SCC 为零，public1047→1045、owner25670→25671，其他数值保持；新文件的唯一真实 owner 增长原协议记录一次并后继退役，正式恢复必须新 exact-SHA CI 全部终态。

附件五路径的首次错误夹具已按真实 intake schema 修正并有限 PASS；启动根十路径的 missing 场景按原410语义修正且独立复读有限 PASS。这些候选和 SC7/员工local4/插件6/GC3不纳入 CI 修复 canonical。恢复后发布这些已复核 owner 切面，再继续 remaining-a 全组／A-G，然后 B/M0～M4；无本机 AW test/typecheck/build/service，RFC 保持 In Progress。

### 2026-10-02 七组40路径候选与 CI 接续

- 六路径修复/许可退役已精确发布02940128f；主CI36951130717 completed/failure、47 success/3 failure，同SHA Windows36951130688 completed/success。原五类错误已通过，两个后端同一既有架构守卫仍失败、汇总失败；只记录状态和源码位置，完整恢复继续。原失败历史保留。
- 七组40路径各获独立有限功能PASS，暂不发布：journaled preparation6、员工local4、插件安装6/GC3、附件完成5、终态presence真根10、提交预览index6。原体、selected async/receiver/first-failure/重试与真实回归保持；准备工厂去未消费public转出口后测试import P2已只改到真实应用合同，首门FAIL保留。各完整指纹见functional-gates.md；此记录不关闭A1～A8/A-G。
- 官方scope仅HEAD加此40路径，六项真实插件R1兼容记录有owner/退役条件，public1045与TE零value SCC保持；五项实际增长许可按原协议登记，发布后精确退役。后续归档内容/恢复、A4其他Git/工作区、A5真实材料/执行、A6/A7/A8继续，CS独立adapter和M0～M4未完成。无本机AW test/typecheck/build/service，不纳入其他WIP。

### 2026-10-02 任务归档内容切面有限 PASS

七路径所选内容端口/独立 local/共享协调器/精确兼容出口和真实双 provider 回归完成有限功能 PASS（4d9650ac2082344a27779947ee3830d9cff079601ed8d888be12f6e632bdb344）。原认领、2000行 JSONL、manifest、恢复、删库规则的纯 AST 对拍及目标格式/lint通过；运行结论待发布后的 exact-SHA CI，真 boot roots 另批，不关闭 A2/A-G。此七路径独立排除原40候选 canonical。并行 e4d7dba7d 的 CI36955843850 终态46 success/4 failure，数量判据和复杂 workflow 上下文修复继续；无本机 AW test/typecheck/build/service，原全部历史保持。

### 2026-10-02 归档八路径与 CI 既有数量补正

原归档7路径保持，RFC349源码键定位真实查询后扩为8路径有限 PASS（31c06684b6c2028f4604e6906c9bee7f4bed2663ffd505427412d7f0f2b7e116），原 SQL 排序判据/why/断言不变。共享 main 已承接 bbb545851 的 E2E lineage 诊断；CI 补正只纳入已提交 HEAD 的源码/治理 seed，48源码候选指纹保持并排除，原候选生成证据留待源发布前重生。仅按确切 CI 的既有数量17/基线16同步一项计数和一次性回执，其他正文/数值/规则/断言不动；有限功能门后单独发布并退役，正式 exact-SHA CI 与原 E2E 功能修复持续，无本机 AW test/typecheck/build/service，不关闭完整 A2/A-G/RFC。

## 2026-10-02 RFC-370 八组48路径发布候选

journaled preparation6、员工local4、插件安装6、generation GC3、附件异步完成5、终态 presence 真根10、提交预览 index6、归档内容8，共48个不同源码/回归路径；八组原有限功能 PASS 和完整指纹均保持，首门 findings 与所有历史 CI failure/cancelled 保留。按八个源码小提交、官方 scoped canonical/docs及五项已消费增长回执的后继退役发布，正式行为交本批 exact-SHA hosted CI。

官方规则及语料算法逐字保持，只纳入已提交 HEAD 加48候选：entry1792→1797、background338→339、imports5627→5661、exception4991→5024、owner25671→25691；公共出口1045、TE零 value SCC保持。六项真实插件 R1 兼容记录完整沿用此前证据，owner resource-catalog、A-T7 selected roots/legacy callers退役；现有292项记录完整保持，不扩大目录或规则。五项增长按原协议一次登记，在匹配 canonical commit 后退役。

归档 coordinator/legacy sweep 的原业务及SQL顺序、异步导出/manifest/move ACK、同 claim恢复和重试保持，RFC349仅定位真实查询源码；默认local位于独立包，真实root选择贯穿仍属A8。其他A1～A8、完整A-G、CS独立adapter及M0～M4继续，尚无AW-in-CS部署证据。仅目标格式/lint、源码/AST/JSON证明与官方scoped生成，无本机AW test/typecheck/build/service。下方所有并行输出与历史完整保留。

## RFC-370 已发布插件 facade 的 CI 清单补正（2026-10-02）

已发布 d5b266c893d07694d5f9c19b24e3642ba6473d19 的主 CI36966192393 终态 cancelled：42 success、3 failure、5 cancelled；不是通过。Ubuntu 后端8/16的实际失败是原 thin-facade 精确清单漏了已变为精确转出口的 services/pluginInstaller.ts；Lint/Typecheck/Format 作业在 Format check 因归档回归样式失败，另有汇总失败。Windows36966192408 failure 是该归档事件夹具的 text 被推断为 string。并行会话已发布69afa48c29234399b58dba3c463ad7068e3d7969，保留原事件值及批次/顺序断言，只加 as const 和对应格式；本候选不重复改该文件。maintenance36966192417、git-protocols36966192415均已终态 success，不能替代主 CI。

本批唯一源码变化为 RFC294 的 thin-facade 精确预期在 maintenanceState 与 protocol 之间补 pluginInstaller.ts。canonical facade 记录已为 thin-facade，旧服务源码只有原接口精确转出口；除这一行外，测试全文逐字等于变更前，所有分类、原断言、扫描规则及 canonical 正文保持。目标格式/lint和纯字节证明通过；/root/rfc370_design_gate 对唯一源码给有限功能 PASS，首末指纹 f32079215f31f791e6ab2435180ff68979e01a6434df38c15dc3f46226f7648c 相同，范围仅此预期/真实 facade，不能替代正式 CI。发布后 exact-SHA hosted CI 单独记录。未运行本机 AW test/typecheck/build/service。候选工作区13路径仍是独立在制，未夹带入本次修复；不关闭 A-G、CS adapter、部署或 RFC，所有历史失败与取消记录保持。

## 候选工作区与启动前恢复24路径有限交付（2026-10-02）

已发布修复 b339e7e06e13c7b4456cc1bf928048c7fc0262a3：主 CI36969850886 completed/success，50/50；同 SHA Windows36970559143 completed/success，1/1。d5b266c8 的 cancelled 42/3/5、Windows failure 和默认 Windows36970426040 的 cancelled 均保留，不冒称这些旧 run 全绿。原 mixed report 丢失原因仍未确证；本次成功不把它改写成已修原因。

A4 候选工作区13路径由 /root/task_config_functional_gate 有限 PASS，有序指纹 d4be4543ef93d4d5e643d4266ce382d5bbcc47f12d89dcd5323672ba9663a33b。所选 factory/session/workspace 接收 opaque references，独立 local 包持有原 clone、FS、模式/digest、Git scope 和 import 机制。AW 原 stage/derive/commit、排序/过滤/首错、消息/receipt 与 idempotence 保留；lineage digest 按原需求顺序异步读取，import ACK 后才收尾，workspace→session 释放完成才返回，DA 真消费者 finally 等 cleanup 后写 verification 事实。原三组9/4/8个回归断言保持，旧cleanup调用等待完成；新10个所选能力用例和双 provider cleanup 两例已写。共享 tree-identity helper原体保持，整个 push 部分与基准逐字一致；不把 push/node/wrapper/其他Git或完整A4记完成。

A1 启动前恢复11路径由 /root/intent_functional_gate 有限 PASS，有序指纹34de018343c3d0814c8aa4e27d2846050d29fe5374ecfb7428ffba4f8462aafc。中立 DatabasePreOpenRecoveryPort<THistory> 与共享准备层等待 history→generation，之后独立 restore phase；原穷举表的SQLite/PG决定保持，读取失败在实际CLI原restore catch之外。默认路径逐次读取，原post-recovery工厂仍在restore时bare-call；原pendingRestore物理body仅 ./restore import改为等价绝对路径，独立local存放，service的10个value/type兼容出口保持。实际CLI/composition其余声明逆变换token一致；三个oracle仅真实facade、已迁出类型债、表位置注释变化。新12功能例覆盖3ACK、receiver/sync、6kind/provider组合、opaque history、no fallback与错误阶段，finally释放收完。完整安装/人工恢复/外层锁/seed/宿主生命周期与全A1仍继续。

官方 census 只纳入已提交HEAD加上述24路径，原工具/扫描/语料规则保持。entry1803（原1797）、background342（339）、imports5686（5661）、required-port liveness38（37）、exception5048（5024）、owner25720（25691）；public1045、implementation SCC空保持。新增 required SPI 有真实共享consumer、file provider及composition三方owner绑定。原298条边界条款的owner/why/退役规定保留；仅按原口径增加pendingRestore→SO local的实际value/type两项R1，inbound267→269、outbound31不变，A-T7退役。六项真实增长按原协议一次登记，匹配canonical发布后后继退役，不扩大目录/规则。

按两个source小提交、scoped canonical/docs及六项消费回执后继退役发布，正式行为仍以本批exact-SHA hosted CI为准。只有目标格式/lint、纯源码/AST/JSON证明及官方生成，没有本机AW test/typecheck/build/service。有限源码门、已有修复CI与新批正式CI各自记账；A1～A8/完整A-G、CS独立adapter、M0～M4继续，尚无AW-in-CS部署，不关闭RFC。

## 24路径批次的六路径 CI 补正（2026-10-02）

发布24路径的末尾SHA为64bf703622b6a7899df8a82a9e4b1dec13185d33：源码13路径28a1d3973ef060507dcce7cc1db5be8bdfa1ef52、源码11路径4bfa7cae183eba91bebbd725d77a2c7399ea7fae、canonical a5a2a8a6456e7bfd4e6b7b2f1da7ecb94231ec75、六项消费回执后继退役。发布时main/origin精确同步、foreignDrift为空；文档唯一末尾空行补正有限delta PASS，原metadata门结论复用。原13/11路径有限PASS保留，原始24路径字节指纹不冒充下面类型补正后的指纹。

该SHA [Windows36976027391](https://github.com/wangbinquan/agent-workflow/actions/runs/36976027391) completed/failure、1失败；[主CI36976027404](https://github.com/wangbinquan/agent-workflow/actions/runs/36976027404) completed/cancelled、50作业中38成功/7失败/5取消。五个后端失败分片分别为Ubuntu5/6/9及macOS2/3；另外是Typecheck与CI required。失败、取消与原历史完整保留，不能以之前b339的成功替代本批验收。并行e8c9d73b13bf467c2e56b9abe2d9baf2f4765797仅含RFC371两个文档，已同步、源码候选不变；其CI36977794334也不记本批通过。

类型补正三路径：DatabaseProvider从真实platform owner/schemaContract纯类型reexport取值；五处expect<实际fixture类>(this)消除polymorphic this的TS2769，同时严格相等receiver、目标、顺序及所有运行主体保持。两处TS2305及五处TS2769日志逐项归因。/root/intent_functional_gate独立字节逆变换有限PASS，有序指纹b5d58435046f765ba6be12fa40bc7413cd87367ec357d44a5cd8735a8f46897f。

功能/fixture补正三路径：旧storage trait及DatabaseStorageShape在14个真实providerTraits消费者中已无实际读取，旧完整性检查只靠已迁出CLI注释命中；删除未使用类型/三个storage声明及其旧type文档，所有真实provider决策保持，原完整性测试仅删除这项已移除字段的两处断言，其他语料/规则/判据保持。macOS的RFC368 P2-2用例在固定50ms后仍见executionRef null，现等待事务持久化执行身份之后的真实launchBehavior进入，保持planned/execution-1/cancel原断言与原预算；finally释放held launch并await dispatch收完，不声称生产取消逻辑损坏。/root/task_config_functional_gate有限PASS，有序指纹3a9b47d632be3ff1fb972a9879fd7b3a6ac2a1cb3d0ae964eac4b0458cb0c631。六路径联合指纹b86da2d6ecaca2366c57e76780c655fc2910d86852708ad3ee47995929ff8596。

另外两项实际清单补正：provider-specific business dependency已因pendingRestore物理迁出而由24降23，仅该baseline及原因同步、并行nativeUsage说明和所有原条款保留；RFC321 exact Git fetch文件清单只增加实际fileRepositoryCandidateEffects路径，逆删这一行即旧ledger逐字相等，其他列表/记录和整个原扫描/断言规则保持。没有恢复旧注释凑consumer，也没有扩大语料或规则。

官方scoped census仅纳入HEAD加上述六路径，四个官方工具字节保持。imports5686→5687、exception5048→5049为正确解析的纯类型owner边，依原协议只登记两项真实增长，在匹配canonical提交后后继退役；owner25720→25719为删除未使用alias，entry1803、background342、liveness38、public1045及implementation SCC空保持。没有新边界豁免；非RFC294仅上述24→23数量变化。按两个source小提交、canonical/docs、两回执后继退役发布，正式行为等待后继exact-SHA hosted CI。

只做目标格式/lint、只读纯源码/字节/JSON证明及官方生成，没有本机AW测试、类型检查、构建或服务。原mixed report丢失原因仍未确证。完整A1～A8/A-G、CS独立adapter及M0～M4继续，无AW-in-CS部署，不关闭RFC。

## 2026-10-02 RFC035 固定来源链接的 CI 修正

修正tip `55b1104a812c247f692f5450b6738e299d437bc1` 已上库并精确同步；Windows36980819374 completed/success、1/1，headSha一致。主CI36980700296已completed/failure、48success／2failure／0cancelled；仅Markdown link check及CI required聚合失败，其余作业全部成功，不能记全绿。失败日志只列 rfc035-storage.md 的三个CS固定版本blob URL，均为503；PUBLIC仓库/精确提交已由GitHub API核对，三个相同SHA/路径的raw内容URL实时HEAD200。

本次只替换这三个来源链接，完整正文经反向替换逐字等价；保留全部合同/事实/固定SHA与路径。没有改checker、接受状态、重试、预算或CI其他步骤；新确切SHA正式CI另验，原失败和取消记录保留。配置叶层14路径有限PASS与selected根/真实双provider新用例独立在制，均不纳入本次文档提交或canonical；所有数值/规则/源码不动。无本机AW test/typecheck/build/service；完整A-G、CS adapter和M0～M4尚未完成，RFC保持进行中。

## 2026-10-02 所选配置与排空实施增量

已形成五组26路径有限独立PASS候选：叶层14、真实根6、周期2、仓库刷新2、备份2。两项首门FAIL/P2、修正和回归详见functional-gates，全部旧政策/counts/断言保持。A1的同一所选query贯穿双provider/daemon/HTTP和本批purpose读；awaitIdle及仓库刷新异步配置支撑后续CLI stop/drain。settings耐久写、剩余热读/后台真接线、宿主生命周期、完整A1/A7/A8/A-G继续，尚无CS生产adapter或AW-in-CS部署。

scoped canonical只纳入26路径、原规则保持；四项实际增长依原协议登记并在matching canonical后继退役。按五个小source提交及配套及时发布，正式功能验证交本批exact-SHA hosted CI和Windows，不运行本机AW test/typecheck/build/service。e4d6f5b2主CI已cancelled 27/2/21，CS三来源已通过，另一RFC来源503及聚合失败保留；并行c843938a三文档完整保留，其CI已completed/failure、48成功/2失败（OpenCode来源503及聚合），原失败保留。完整B/M0～M4顺序和RFC退出条件保持。

17路径metadata首门另有文档事实P2：c843 CI在复核期间刚进入终态，新增节的“待终态”已按精确回执修正；该finding和原候选指纹f162d6ecbbbbdd592d10d583f7083e8b060176f8991e6268a1366a697aeadbdc保留。独立单文档CI引用修正有限PASS，指纹32ba3a45fec8988daf421e3bb9a64bb4d45d00ab91f9d92158bae8c0e6a32fdf；按CLAUDE原规则把同固定提交/路径/行号的OpenCode blob超链接改成文本引用，逆变换旧全文逐字一致，原RFC371输出全部保持，不改任何事实、checker或预算。该文档以另一个小commit同批发布，正式恢复仍待本批exact-SHA CI。

### 所选配置读写真根与后台排空11路径（2026-10-02）

通知ACK2与真实binding9分组有限PASS，原同步隐含返回值FAIL/P2及修复记录见functional-gates。SO composition选择一次存储，StartOptions、PG应用及SQLite应用透传同一binding；selected逻辑通知key不需本机路径，旧query-only覆写兼容。Settings读写共享receiver，业务校验/probe fence及原热应用顺序保持；维护、TE后台、idle、batch、backup/refresh接所选query，最后两者关闭等待在途ACK。SQLite queued Intent及runtime/迁移/宿主继续。

真实双provider HTTP与binding ACK/失败回归已写；W29三body严格逆变换恢复旧全体，PG168/SQLite49仅各多一binding声明，API65/EC4和原生命周期规则保持。官方scoped生成仅HEAD加11路径，三项实际各+3增长原协议登记/后继退役；原规则、其他计数、public1045及SCC空保持。

前批26源码加17配套按七commit发布71703608，OpenCode文本引用由并行81d6三个共享文档承载且完整保留。717的Windows36990563985已success，主CI非终态快照与最终证据分开。新批按两个小source提交及配套发布，正式验证交确切SHA CI；无本机AW test/typecheck/build/service，完整A-G后才进入独立CS adapter与M0～M4，不改变退出门。

- 2026-10-02 A1手动迁移增量：四路径有限独立PASS（02890cdb5dce0365f295189d8df6dd91e25b8054385710f5e498ca40a475b8a3），首三路径FAIL/两个P2及修正完整保留，详情见functional-gates。实际migrate入口复用SO configuration/installation，原输出与finally close尾部逐字保持；八个双provider例覆盖所选读取/准备/释放/close ACK和错误优先级。默认文件选择行为保留。官方原口径三项各+5，实际两条CLI R1替换旧direct入边，其他规则/数量/条款不变；按source、canonical/docs、三回执后继退役的小提交发布。96eb前批Windows exact-SHA已success 1/1，主CI终态尚未取得；717旧主CI cancelled19/1/30单独留档，不替本批验证。只有目标format/lint与纯source/JSON/官方生成，没有本机AW运行；SQLite queued Intent/runtime真实根、其余A1～A8、完整A-G、独立CS adapters和M0～M4继续，无AW-in-CS部署，RFC仍In Progress。

## 2026-10-02 人工迁移、运行时所选配置与 CI 断言接续

前批 96eb71db5dcaadbc2c0c0aa6bfe59cedb5e234ed 的 主 CI36993377294 已 completed/cancelled：42 success、7 failure、1 cancelled；同 SHA [Windows36993443952](https://github.com/wangbinquan/agent-workflow/actions/runs/36993443952) completed/success 1/1。四个后端失败分别指向两处已滞后的源断言：memory-distill 仍查本地 loadConfig，W29 将所选诊断工厂误查成 direct call。现对应真实每 tick 所选 read 和两根的 phase/unstarted 工厂调用，原工厂数、timeout/四旋钮及同 configuration 参数断言保留。Lint 的 submoduleRefresh.ts:244 已由并行 3bf8cc6c6364773f251b4fae9ea0399b2be349c8 显式 void 修复；其三个完整文件已同步承接，不归入本批源码提交。原失败/取消及 717 的主取消 19/1/30 全部作为历史保留；不能将 Windows 或有限源码门记成主 CI 全绿。

人工迁移四路径有限 PASS 02890cdb5dce0365f295189d8df6dd91e25b8054385710f5e498ca40a475b8a3 及首门两个 P2 完整保留。运行时真实根四路径另由 /root/task_config_functional_gate 有限 PASS，指纹 400cb6451c7747f95c587b96adbf12d90cf23385af848dd8249d5d5aafdd35f1：PG/SQLite runtime-management 的 current 每次调用同一所选 configuration.read，probe fence 与 Settings 共用 applicationConfiguration.notificationKey；默认文件 binding 的 key 保持原 configPath，沿现 KeyedSerialQueue。双 provider 真实 HTTP 夹具覆盖 held read ACK、热切默认 runtime、unsaved probe 使用所选路径及读取失败无回退。两生产文件完整逆变换和 W29 原数量 168/49/65/4 保持；W29 此前只两 digest 变化，新 CI 工厂查找修正单独记账，不改原生命周期规则。

旧人工迁移 17 路径 metadata 在 96eb 冻结候选获得有限 PASS 78b9b1cf03e87ae6f3df9dc041d60d8265938ef011141b13e5fea240d5417c98。HEAD 前进未取消该门；后继 canonical 基于 3bf8cc6 的完整已提交源码加本批九个不同源码/回归路径重生，四原生成规则逐字保持。运行时 binding 与两个 oracle 未新增受控数量，仍只有人工迁移三项实际各 +5：imports 5692→5697、原 exception 投影 5054→5059、owner 25726→25731；entry1805、background342、public1045、required-port liveness38 及原 value SCC 集合保持。两项 CLI 实际 R1 替换一旧边、inbound270/outbound31 及 SO/A-T7 退役条件不变。三条既有 growth receipt 不重复登记，须在匹配 canonical 提交后仅退役这三条。后继 17 路径属于有限 delta 门，正式验证交发布后的 exact-SHA CI。

仅运行目标格式/lint、纯源码/AST/JSON证明和官方 scoped census，没有本机 AW test/typecheck/build/service。SQLite queued Intent、runtime legacy boot、配置 CLI/doctor、外层锁/宿主生命周期及其余 A1～A8 继续；完整 A-G 尚未关闭。独立 CS adapters 和 B/M0～M4 保持批准的顺序，尚无 AW-in-CS 部署，不关闭 RFC。所有旧正文、并行输出及 gate/CI 历史完整保留。

## 2026-10-02 Runtime legacy 与配置 CLI 的 A1 增量

两组共七个不同源码/回归路径分别获有限独立功能 PASS。Runtime legacy 三路径指纹 7300f41bb3aa9b1cae5a325beeee5c9f4bc7f646afcf6e05f6e6e8f1c832d5d3：复用既有 RuntimeLegacyConfigurationPort，start 只选择一次并将同一 receiver 传至 PG/SQLite 初次及 target 重装配；默认文件工厂保持 lazy，原 seed/backfill 后的 guard 读取时点和旧字段拒绝/未读到时的既有安装判据保持。双 provider 三例覆盖 held ACK、每次 boot 当前 raw 内容及所选读取失败不借另一文件；两生产文件全文逆变换一致。

配置 CLI 四路径指纹 ebb45d221e89268c2a728b20a30c53e8d233fbad816659b07e5d7882c72e1645：复用 SO ApplicationConfigurationPersistencePort，经独立 cliConfiguration composition 选择本机默认。原单参数调用保持同步结果与同步抛错；selected 读写返回 Promise，等同一 receiver 的 load/applyPatch ACK，不借本机文件。get 的整份 JSON/单键输出、set 的 JSON-first 解析与格式政策完整保留；持久化工厂只有同步返回类型推导/satisfies 改动，runtime 正文逆变换一致。六例覆盖 held 读写、当前值、一次 patch、无关并发设置、错误及同步兼容；main 调用和原 cli.test.ts 全文字节不变。

官方 scoped canonical 仅已提交 ba47e5d24c4f8f95f27defb82545ea1766b0e7a9 加这七路径，四原生成规则逐字保持。实际新增三条 symbol import：raw port type 与 config CLI 的既有 persistence type/used file factory；imports 5697→5700、原 exception 投影 5059→5062。六个 owner 是五个私有已用 CLI helper 与一个 SO composition file，25731→25737。entry1805、background342、public1045、required-port liveness38 与原空 value SCC 保持。只给实际 CLI type/value 两项 R1 记账，inbound270→272、outbound31；原 bootstrap 列表、条款和所有旧记录保持，owner SO、A-T7 退役。三项真实 growth receipt 一次登记，匹配 canonical 提交后另行退役，不把新切面作为规则豁免。

截至本节候选冻结，上一批 ba47 的 主 CI36997889808 尚未取得终态回执；同 SHA [Windows36998073470](https://github.com/wangbinquan/agent-workflow/actions/runs/36998073470) 已 completed/success 1/1，headSha 严格一致。前批 96eb 的主取消42/7/1、Windows成功及更早717取消19/1/30等原历史完整保留；不能把有限源码门或 Windows 记成主 CI 全绿。正式行为以发布后的 exact-SHA hosted CI 为准。

只有目标 format/lint、纯源码/AST/JSON证明与官方 scoped 生成，无本机 AW test/typecheck/build/service。doctor 配置、SQLite queued Intent、外层启动锁与宿主生命周期、安装/恢复剩余入口及其他 A1～A8 持续，完整 A-G 尚未关闭。独立 CS adapters 和 B/M0～M4 仍按批准顺序推进，尚无 AW-in-CS 部署，不关闭 RFC。下方/既有全文、并行输出及全部 gate/CI 历史完整保留。

## 2026-10-02 CI 终态接续与 doctor 配置读取

上一批 ba47e5d24c4f8f95f27defb82545ea1766b0e7a9 的主 CI36997889808 已 completed/failure：46 success、4 failure、0 cancelled；同 SHA Windows36998073470 completed/success 1/1。旧节的未终态快照作为当时冻结事实完整保留，不改写失败历史。两个后端失败作业 mac1/110809149232、Ubuntu5/110809148997 都只有 RFC359-W5 unattended void 数量多出 services/submoduleRefresh.ts:1。原 reconfigure 的返回值为 boolean|Promise<boolean>；此前 lint 修正的裸 void 被原守卫识别。本次只接住调用结果，对 Promise 分支加拒绝处理和原日志风格，同步返回/抛错、initial/revision/排空与其余完整正文保持。单路径有限 PASS d0a74e255a74706796fee2bab1ad3f4c8c9e4f5da21471913495386db36a399f，原 W5 scanner、账本、负夹具和数量全部不变，无类型压制或检查放宽。

doctor 配置三路径修正后有限 PASS ab326f13a63d3d70b4b6085786c09f8a52b3789960d74ce687517ec6f8b1e398。复用既有 ApplicationConfigurationQueries，独立 SO doctorConfiguration composition 提供 lazy 默认，真实 doctor root 将同一 selected receiver 传给三处配置读取。selected 等待读取 ACK，忽略本机配置存在性，不借本机文件；默认缺文件/已加载/schema和原 Error 文案保持。首门 d461b32c7d794aceb2850c101725ed3a4942c2c3e26cb50d507ac9c2851071dc 的 FAIL/P2 保留：非 Error 拒绝曾使 catch 再抛错或返回 undefined，现转成 String 诊断；null/string/undefined/42 四例回归已补。原六例、双用途失败早退及真实 root AST绑定保持；十步纯逆变换恢复原完整文件，其他诊断正文未改，未执行整个 doctor。

七路径 source 和17路径 metadata 的首 PASS 498cd3b9b88e739edc89b6c4f0c4b6e4ae5a4f11851ed7e998c5195e2421a84a 保留，后继先纳入单路径 CI 修正，数量不变，再纳入已通过的 doctor 三路径。最终官方 scoped 输入为已提交 ba47 加11个不同 source/test路径，四原生成规则逐字保持。总 imports5697→5702、原 exception5059→5064、owner25731→25739；doctor 实际增加 purpose factory value/public query type 两边及 composition file/used factory 两 owner。entry1805、background342、public1045、required-port liveness38及原空 implementation SCC保持。实际新 R1 共三个：CLI type/value 两项、doctor factory value 一项，inbound270→273/outbound31，SO owner/A-T7退役明确；原 bootstrap 列表、条款及所有旧记录保持。原三条未消费 growth receipt 的理由完整保留并追加 doctor 的实际增量解释，没有重复新登记；匹配最终 canonical 提交后另行退役。

按 CI修正1、raw legacy3、config CLI4、doctor3 四个 source小提交，再配套 canonical/docs和三项回执后继退役。17路径后继仅做有限 delta复核，不取消或复跑已完成的旧门；正式行为等待新 exact-SHA hosted CI，不把 ba47 或 Windows记成主 CI全绿。只运行目标 format/lint、纯源码/AST/JSON证明及官方 scoped生成，无本机 AW test/typecheck/build/service；原文档格式告警只来自既有历史空行和原 generated renderer，新增节已符合格式，未整篇改写历史。

SQLite queued Intent、外层锁/宿主生命周期、安装恢复剩余入口、doctor其他目的能力及其余 A1～A8 继续，完整 A-G 尚未关闭。CS独立 adapter 与 B/M0～M4保持批准顺序，尚无 AW-in-CS部署，不关闭 RFC。全部原正文、并行输出、首门 findings及 gate/CI历史完整保留。

## 2026-10-02 doctor 回归的 Windows 编译补正

前批28个不同文件已按六个小提交发布，main/origin 精确同步7b3bf7f4574671ac4d71cfa5e3a1c3ff52eb6313；三条已消费 growth receipt在匹配canonical之后退役，所有数量/原理由与并行正文保持。该 SHA的 Windows37004034478已 completed/failure 0/1，实际功能作业110828029081失败于backend typecheck：rfc370-doctor-configuration-bindings.test.ts:196的expected message仍是string|undefined，Bun expect重载要求string。shared/frontend typecheck在同一日志成功。同SHA主CI37003820059已completed/cancelled：26 success、3 failure、21 cancelled；maintenance37003820306已completed/success 1/1。两项回执分别保留，不把maintenance或旧SHA的成功记为主CI全绿。

本次五路径首候选1ab123f968db3dcd69fb1a72c9494476876635719c9234d3d39f115370cee873的有限FAIL/P2保留：四份新增节仍把已完成回执写成等待。这里只校正这四段终态；三行源码补正独立有限PASS 57562e19d4b18ea44a67c89bdc8d59aa0dcb75342d2d2a2097566b161ddc1649保持，不重跑未变源码门。

唯一源码增量是该既有测试的显式控制流判据：原toBeDefined断言后，若没有原load错误消息则立即抛出夹具失败，随后message被收窄成string。原load调用/默认错误文案比较、全部断言与预算保持；删除这三行即恢复发布测试全文字节，不改任何生产实现或用类型断言压制错误。正式修复仍交新exact-SHA hosted CI。

官方production corpus、两份sourceDigest附加输入、四条生成规则及12份canonical JSON均与7b已提交内容逐字一致；此测试/记录补正不改sourceDigest、数量或增长回执，不重复生成canonical。只做目标format/lint、纯源码/字节证明与有限独立功能门，无本机AW test/typecheck/build/service。并行未提交改动完整保留，原Windows失败、doctor首FAIL/P2、所有旧gate/CI历史保留。queued Intent及完整A1～A8/A-G、CS独立adapter、M0～M4继续，尚无AW-in-CS部署，不关闭RFC。

## 2026-10-02 queued Intent admission 与 scratch 工作区效果选择

两组15个不同源码/回归路径已分别获得有限独立功能 PASS：queued Intent 七路径指纹 `113035adc56532b65ed9b7e3fdf7dee952c862ceacd55d772472f65bf091c888`；scratch 八路径指纹 `c3a95e67571a3152d7891cd0c245978ef40ea91528e40bd6ad21d83c9fe4ecab`。未变源码门复用，不随 HEAD 移动取消或重跑。本门仅覆盖 queued admission lifetime 和 scratch 效果选择，不覆盖已派发 turn 的完整执行 lifetime、完整 launch lane 或全部 A3。

Intent application 拥有冻结通知缓冲、按原政策去重、激活后读取当前 selected configuration、stop admission fence 与 drain ACK；同一 purpose composition 贯穿 SQLite/PG 真根，并首先登记为 provider runtime factory。冻结时不读配置、不启动效果；stop 后不再准入，未准入 IDs 可按原回滚重装配重试，已经准入的 Promise 及错误报告 ACK 排空后才可重启。PG 使用准入时获得的配置，不另读一次。原后台 oracle 仅修改真实工厂接线判据；W29 原168 statements、8 phase blocks 保持，原 PG digest `ac88a77b30ad4f6f4259301edb7af568661583514efc37073f2a11a18eb6a112` 按实际接线更新为 `d636c6a8a0459df274ddce6850cc6ac15313e45a2103f0da911e4f61df690d07`，没有放宽原规则或数量。

SC 将既有七类 workspace facts 原样移入 application 并保留旧 type 出口；原 materializer 全部 runtime tokens 不变。独立 file scratch adapter 承接原 prepare/cleanup 物理调用和本机路径恢复判据，owner composition 保留原 pre/post fence 及 version/task/kind envelope 判据。TE 真实 journal 在原位置 await selected restore，prepare/restore/cleanup 使用同一 receiver，opaque workspace 引用可恢复；原 record-before-act、补偿、错误、重试、清理 ACK 与 admission 顺序保持。真实 journal 的双 provider 夹具覆盖 held ACK、重放、失败补偿及 envelope 拒收；既有文件 scratch 回归完整保留，未在本机执行测试。

官方 scoped census 只纳入已提交 `fc52e3beb91ce987bccab19f1333bbc2a3d91e7a` 加上述15路径，四条原生成/扫描规则逐字保持。实际数量：entry1805→1807（两个已用 factory）；imports5702→5706、原 exception5064→5068（四条实际 symbol edge）；owner25739→25752（20个真实新增、7个原样迁移类型的旧 owner 移除）。background342、public1045、required-port liveness38 与原 implementation SCC 集合保持。原 boundary scanner 没有新增 R1/R2；273 inbound/31 outbound、全部原 owner/reason/退役条款和 bootstrap 列表保持。四项真实 growth receipt 按原协议一次登记，匹配 canonical 提交后另行退役，不扩大规则或目录豁免。

前批 doctor 编译补正已按两提交发布至 `fc52e3beb91ce987bccab19f1333bbc2a3d91e7a`。该 SHA [主 CI37007544133](https://github.com/wangbinquan/agent-workflow/actions/runs/37007544133) 已 completed/failure：48 success、2 failure；功能失败是 Windows shard4 的 mixed wrappers + humans E2E，另一个为 required 汇总作业，原失败保持并继续处理。人工 [Windows37007607865](https://github.com/wangbinquan/agent-workflow/actions/runs/37007607865) 被后继请求取消，日志没有新的 TypeScript 错误，不能记为通过；同 SHA 定时后继 Windows37008086312 已 completed/success 1/1，单独记账。所有更早失败/取消及首门 findings 完整保留，不能将 Windows 或有限源码 PASS 写成主 CI 全绿。

按 queued7、scratch8 两个 source 小提交、17路径 canonical/docs 和四项消费回执后继退役发布；正式行为仍交新 exact-SHA hosted CI。只做目标 format/lint、纯源码/AST/JSON证明及官方 scoped 生成，无本机 AW test/typecheck/build/service。A1 启动安装配置桥接、外层锁/宿主生命周期、其他 A2～A8/完整 AC00/A-G 继续；完整 A-G 后再实施独立 CS adapters，B/M0先部署再逐项 M1～M4。尚无 AW-in-CS 部署，不关闭 RFC；全部旧正文和并行输出保持。

## 2026-10-02 数据库启动 binding、完整 queued 装配与 nested handoff

A1 启动数据库桥接四路径有限独立 PASS，指纹 `e989a838079f640633994e9600213d8b58fe9bd113541fbf41eff37b263d067a`：同一 ApplicationConfigurationBinding 提供数据库配置 purpose，lazy read/write 使用同一个 persistence receiver，write 仅 patch database 并等待 ACK。StartOptions 独立选择 installation；默认 file 分支仍调用原 prepareDatabaseInstallation 和 local adapter。两个既有生产文件的有限逆变换恢复旧全文，原参数、pre-open restore、backup callback 和错误正文保持。旧 query-only override 仍保留文件数据库行为；六个回归覆盖 held activation/release ACK、独立设置、失败无回退及恢复读取时点，未在本机运行。

上一批已按四提交发布至 `9e8db61f0a96f43026e9614547e436cfb91aab61`。[主 CI37012684652](https://github.com/wangbinquan/agent-workflow/actions/runs/37012684652) 已 completed/failure：44 success、6 failure；四个后端失败分别复现同两类接线问题——SQLite 新增 nullable intentDispatchDeps holder、Intent composition 引入 SO offered DAG 外边；另一个 macOS 分片失败为既有 local-gate-runner 的 post-exit descendant marker 断言，及 required 汇总失败。五份功能作业日志单独留档，不将原未变 runner 的一次失败写成已修复，新批 CI 继续验证。人工 [Windows37012958481](https://github.com/wangbinquan/agent-workflow/actions/runs/37012958481) 已 completed/success 1/1；同 SHA 先行 [Windows37012684548](https://github.com/wangbinquan/agent-workflow/actions/runs/37012684548) completed/cancelled 1/1，分别保留。更早失败和取消完整保持。

两处接线问题在四路径候选有限独立 PASS，指纹 `7bcc7c077538bdebc85d2d731813b923f772337455d4f195acd69791f6fd5235`：Intent 使用自己所需 reader 的结构合同，删除 SO offered import；SQLite 维护前只创建纯 ID inbox，完整 const 依赖就绪后才连接原 frozen queued lifetime，再由原 provider 首项启动。删除新增 nullable holder 及未装配 throw；原占位守卫、offered DAG、债务条目及 queued application 全文逐字保持。新增 cold notification transfer、去重、重复连接拒收和 selected ACK 回归；真实根 oracle 只迁到实际 notification/full binding 接线，原一实例和首项注册判据保持。root 的完整有限逆变换恢复上述 A1 已 PASS root，其他 A1 三路径逐字不变；七个不同源码/回归路径以组合门覆盖发布，指纹 `b5a7be880643b757ff2022c737b8c80e1344c57edb6f1c187628e82ddc28c081`，不冒称另一次全量门。

nested Git/loop wrapper 将原 TaskScopeOutcome.handoff 逐层传回：真实 interrupted ledger ACK 后才发布控制信号；不终结 wrapper 行或抹掉 progress，重入同 frame/runId。scope 冻结新准入，等待已准入 ACK；已确认 handoff 后的普通 rejection 排空后原样抛出，同时冻结 autoCommitPush synthetic。原全局 NodeStepOutcome/legacy result 五分支不变，非 handoff 异常、取消及 processUnreaped 政策保持。九路径第三候选有限独立 PASS，指纹 `7f317488e1b2c2d8d981f5edb4f04e6bc43d156bf4b383d2acb784d350da9254`；首候选 `e28c79c77d5d055c0501bdff9b575143ca17c870df154ee3c637e7099ac4bef7` FAIL/P2 的异常未排空及 synthetic 继续准入、第二候选 `dcee5c92e094891333644d1e28fe0218acaa11f125eacdfb1bf4912a667db16b` FAIL/P2 的 readonly 夹具赋值，全部保留并已有限修正，屏障和原断言不变。原 E2E 定义与断言保持。

官方 scoped census 只纳入已提交 9e8db61f 加本批16个不同源码/回归路径，四条原生成规则保持。实际 entry1807→1808（一个已用纯 inbox factory）；imports5706→5707、原 exceptions5068→5069（三条真实 root symbol edge 新增、旧 preparation value 和 Intent-to-SO type 两条删除）；owner25752→25762（十项真实 owner 新增）。background342、public1045、required-port liveness38 及 implementation SCC 集合保持。原 boundary scanner 无新增 R1/R2，273 inbound/31 outbound、全部原 reason/退役条款和 bootstrap 列表保持；四项真实增长按原协议一次登记，匹配 canonical 提交后另行退役。

按两个 source 小提交（wrapper 九路径、启动及完整装配七路径）、17路径 canonical/docs 和四项消费回执后继退役发布；全部旧正文与并行输出保持。只做目标 format/lint、纯源码/字节证明和官方 scoped 生成；无本机 AW test/typecheck/build/service。正式修复交新 exact-SHA hosted CI。有限门只覆盖本批，外层宿主锁/生命周期及其他 A1～A8/完整 AC00/A-G 持续推进；完整 A-G 后才实施独立 CS adapters，B/M0 先实际部署，再逐项 M1～M4。尚无 AW-in-CS 部署，不关闭 RFC。

## 2026-10-02 归档真实根接线与 nested handoff 回归夹具补正

A2 归档真实根九路径有限独立 PASS，指纹 `f9a5659c85fb50b3a0158e9d1d56157959c7eca2159335106bbe7effc7750136`。TaskArchiveContentBinding 将所选 content 与三个逻辑根一起传入 StartOptions、provider session、SQLite/PG runtime 和 standalone HTTP。composition 冻结所选根，调用者的 now、retention、maxTrees、actor 和 preview 仍由原协调器裁定。SQLite daemon HTTP 优先复用 boot 同一 command；PG 原共享实例接线保持。原协调器、local content、temp sweep 和 route 完整字节不变；27 项有限逆变换恢复八个旧文件全文。五组新增行为回归覆盖双 provider helper、manual、held recovery ACK、失败无本地回退及真 HTTP manifest ACK/claim 保留。W29 只按真实接线修改两项摘要，原 168/49/65 statements、8 phase blocks 及所有原判据/预算保持。

前批已发布至 `1ed4061c3e10bbabd4e690126e7a3eaebd8217d6`，精确 main/origin 同步；其 [Windows37021105289](https://github.com/wangbinquan/agent-workflow/actions/runs/37021105289) completed/failure 0/1。该 SHA [主 CI37020545454](https://github.com/wangbinquan/agent-workflow/actions/runs/37020545454) 的本批冻结功能快照为 42 success、3 failure、4 非终态，并非全套终态结论。类型检查两个 OS 都指出 rfc370-wrapper-gate-handoff.test.ts:521 的 tasks fixture 缺 workflowId/inputs/startedAt；Ubuntu3 与 macOS5 的同一真实双库回归失败于 workflow_id NOT NULL。四份功能作业日志已单独保存；既有 runner 本次已通过对应原断言，没有改写前次一次失败的原因。其余任务和主 CI 的最终结论另行记录，旧失败/取消及 gate findings 全部保持。

单路径 CI 夹具补正有限独立 PASS，指纹 `445fe558e475c284dca90a0b44add96dee5f8eb376d5b34e5705c36549b30e67`；只插入真实 workflow row、workflowId/inputs/startedAt 三项必填字段及 workflow import；原 handoff/interrupted/progress/frame/resume 断言、预算和全部生产代码保持。三项有限逆变换恢复原测试全文，不用类型压制或放宽原 schema。正式修复仍以新 exact-SHA hosted CI 为准，不将有限源码门或部分作业通过记为主 CI 全绿。

官方 scoped census 只纳入已提交 1ed4061c 加归档九路径，四条原生成规则保持。实际 imports5711（原5707）、原 exceptions5073（原5069）仅来自四条真实 bootstrap type edge；owner25763（原25762）只新增一个已消费的 archive binding owner。entry1808、background342、public1045、required-port liveness38 及 implementation SCC 集合保持。原 boundary scanner 无新增 R1/R2，273 inbound/31 outbound、全部原 reason/退役条款和 bootstrap 列表保持；三项真实增长按原协议一次登记，匹配 canonical 提交后另行退役。

按 CI 夹具单路径、归档九路径、17路径 canonical/docs 和三项消费回执后继退役及时发布；旧正文和并行输出保持。仅运行目标 format/lint、纯源码/AST/字节证明及官方 scoped 生成，无本机 AW test/typecheck/build/service。后台 Worker 的 archive content 接线仍在 A2/A7，其他内容及 A1～A8/完整 AC00/A-G 持续；完整 A-G 后才实施独立 CS adapters，B/M0 先实际部署再逐项 M1～M4。尚无 AW-in-CS 部署，不关闭 RFC。

## 2026-10-02 技能完整存储真实根与 HTTP 回归夹具补正

技能完整选择八路径首门 `58773cdefc01365ca8afd7e2f64a33838e429952ce15556dc491e9568b1a6428` FAIL/P2 保留：直接展开合法原型 getter bundle 会丢失 capability 并启用 file 默认。owner 的 selectSkillContentDependencies 现显式读取全部11项能力及一次 rootReference，五个真实 classic/boot 调用展开该冻结投影；同一 binding 贯穿 StartOptions、provider session/recompose、SQLite/PG 和 standalone HTTP。undefined 保持原 file 默认，原叶层状态机完整字节不变。

修正八路径有限独立 PASS `80c9b1f5c8529376cbca39db7930a0faf418121114a5830b54bc301cdc979cad`；28项有界逆变换恢复五个旧文件全文，七个叶层 SHA 保持。原 own-field 双provider HTTP、publish ACK、操作锁/row/phase、boot snapshot ACK、读取失败判据及每例20秒预算保留，新增无own字段的12原型getter夹具。W29只变真实PG/SQLite两个摘要，168/49/65 statements、8 phase及全部原规则/预算不变。首版一次scoped投影随其FAIL保存为无效未发布记录，真实源码补正后只执行一次新R2投影。

前批 `1ed4061c3e10bbabd4e690126e7a3eaebd8217d6` 主 [CI37020545454](https://github.com/wangbinquan/agent-workflow/actions/runs/37020545454) 已 completed/cancelled：44成功、4失败、2取消，旧非终态快照保留。当前已发布 `2b91d76c4ab10f2efe1b11bff506ad17da4ced29` 精确同步；[Windows37025412186](https://github.com/wangbinquan/agent-workflow/actions/runs/37025412186) completed/failure 0/1；主 CI37024745598 本批冻结快照为in_progress、43成功、3失败、1取消、2非终态，非全套终态结论；完成等待曾被GitHub504中断，已重新接入同一run。四份功能作业日志明确归档新回归的Response或Promise类型错误及等待诊断消费原body；生产归档接线及原wrapper断言保持。

两测试路径夹具补正有限独立 PASS `49910a7755dd1d46fec20a847bb5db9837b63e27f2f91eef5c9cb5ba3b69926b`：Promise.resolve保留同一次HTTP请求，诊断读取clone而保留原body给JSON断言；技能同类写法同步补正，getter fixture的receiver按eslint改延后const，原assertions/预算保持。五项有界逆变换恢复两份before全文；其他七个技能路径逐字保持。八路径原PASS与此次一项重叠fixture增量形成技能最终组合指纹 `952de1db48e1240cad8e06f76b17839f8ae56b7b4b26b05b63067b875072b808`，不冒称另一次全量门。

原四条生成规则及production语料规则保持；两fixture均不在sourceDigest的src语料或两个额外输入内，因此不重复R2 census。实际六条bootstrap value/type边使imports5711→5717、exceptions5073→5079，五个真实composition owner使25763→25768。entry1808、background342、public1045、required-port liveness38、target69及implementation SCC保持；原boundary scanner无新增R1/R2，273 inbound/31 outbound及原全部条款/reason/退役条件保持。三项真实增长一次登记，匹配canonical提交后另行退役。

按归档CI单路径、技能八路径、17路径canonical/docs及三回执后继退役及时发布；旧正文及并行输出完整保持。只做目标format/lint、纯源码/AST/字节证明及原官方scoped生成，无本机AW test/typecheck/build/service；正式行为交新exact-SHA hosted CI。其他内容与A1～A8/完整AC00/A-G继续；完整A-G后编写独立CS adapters，B/M0先实际部署，再逐项M1～M4。尚无AW-in-CS部署，不关闭RFC。

## 程序与证据读取真实根的有限交付（2026-10-03）

20路径组合有限 PASS `ae7d8ffabdb9d18d9e58c03c90a9f9572ff99411ea45305ac772e187b511d97e`。既有 DE ProgramArtifactPort 与 DA complete evidence read binding贯穿真实 start/session/recompose、PG/SQLite daemon和standalone HTTP；五处文档读取及range stream均等待selected ACK，local默认独立包保持原字节/错误/范围语义。首轮两个夹具P2和两路径后继PASS、全文逆变换、原W29数量与摘要记录见 [功能门](./functional-gates.md) 新节，不冒称全量复跑。

官方 scoped canonical以76c564b加本批20路径只生成一次，原四规则保持。实际entry+2、imports+6、exceptions+6、owner+12；其他受控数量和SCC/liveness保持，原273 inbound/31 outbound无新增条款。按20 source、17 canonical/docs、匹配四growth回执后继退役发布。前批2b/54f失败取消、76单测试matcher修复及Windows成功/主CI未终态见 [STATE](../../STATE.md) 新节；正式本批行为交新exact-SHA hosted CI。

后续必须完成A1外层宿主/执行权、A2内容写入/import/materialize和完整恢复、A3/A4工作区与Git全消费者、A5材料/执行/清理、A6命令、A7执行权恢复与A8完整装配/独立A-G；本批只是读取切面。随后编写独立CS adapters，B/M0先实际部署，再逐项M1～M4。尚无AW-in-CS部署，不关闭RFC；原正文和并行内容保持，无本机AW test/typecheck/build/service。

## A1 宿主切面与 A2 文档写入增量（2026-10-03）

完成本批 28 路径 SOURCE 有限 PASS；17 路径 METADATA 单独检视后按四路径 CI 叶节点、17 路径 host/根接线、七路径文档写入、17 路径 canonical/docs 与六回执退役分别小提交及时发布。CI 根修复与宿主接线共享 start/PG/HTTP 三整文件，同批保留全部有意输出。初次 host 门的 shutdown P2、两路径 R2 PASS 和所有旧 CI 失败/取消记录不覆盖。

宿主本批提供 live runtime query、selected native lifecycle、ready/withdraw/control/announce/terminate 和所有根 receiver 接线；正常关闭顺序不变，已受理 readiness 发布/最终撤回 ACK 完成后方能释放 lock/退出。新增 required SPI 原口径为 declared-debt，必须继续抽出 SO application 宿主协调及真实 root composition，连同 raw PID lock/执行权完成 A1/A8；不能据本批标记 A1 已完成。

文档本批把原 EvidenceBudget/Entry/BundleRecord 形状移入 domain，保留 EvidenceStore 全部物理正文，五 JSON 消费者 await selected writer 后再落引用；默认 local adapter 与真实失败/预算/ACK/cleanup/双库回归已写。下一步先在全部真实 roots 注入同一文档 writer，再替换其余 evidence intake/import/materialize、uploads、引用与 blob effects；此有限 PASS 不能关闭 A2。

227cfacc 主 CI37038117741 和 Windows37038361399 均终态 failure；本批修复实际 QuestionSetV1、inclusive range stream 和三个 forbidden deep imports，不放宽原测试/manifest。76c564b 主 CI37034403145 已 cancelled，Windows37034643759 success；旧正文保持，发布后接入新 exact-SHA CI 并修复实际功能失败。

28 路径原 scoped census 与 boundary 各一次，新增六回执对应 entry +3、imports +12、required SPI +1（declared-debt）、exceptions +11、public surfaces +2、owners +22。原四规则、304 条 debt、273/31、target 69、implementation SCC 和边界条款完整保持，boundary 无新增。只做目标 format/lint、纯源码/AST/JSON/字节证明和官方 scoped 生成，不运行 AW 本机 tests/typecheck/build/services。

保留全部并行开发内容，仅本批精确 owned path publication。A3/A4 工作区/Git、A5 执行完整效果、A6 所有 purpose 命令、A7 worker/authority、A8 全 roots、AC00 与独立完整 A-G 继续。完整 A-G 后开始独立 CS adapters；B/M0 先实际可用部署，随后 M1～M4 在同一安装逐步接入，最终验收后才关闭 RFC。

## RFC-370 类型出口增量与原 active SPI 恢复（2026-10-03）

首版 SOURCE28 `193a0c97303944b793cf098ff2faa89946dd8592cca6f5ca50a54033d94d5fc0` 与 METADATA17 `d1b498319866d70f916ac8bf32fd071eba0a447e2d741046ce59818dc8589377` 有限 PASS 保留，但未发布。原清单将 DE ProgramArtifactPort 的 from-type 再导出算作同路径第二次 composition binding，造成 active→declared-debt。仅 DE composition 一路径把出口改为 `export type { ProgramArtifactPort }`，复用原有 type import，整文件逆变换一致；单路径增量有限 PASS `38ca0e5cd13d8c8bc8af390afa963c82fe58600af080993f94966d7581c95443`。其余 27 路径逐字未变，复用原 PASS 组成 SOURCE28 `8ded9a42418055aa1674d4fb31360855f4a6ae66cdbe2781b20eddda68924dc1`，不重开 SOURCE 全量门。

实际源码变化后只执行一次新 R2 scoped census/boundary，保留首版生成记录；观察边和 exceptions 逐项与首版相同，六实际增量仍为 1810→1813、5723→5735、38→39、5085→5096、1045→1047、25780→25802。ProgramArtifactPort 恢复 active 且只有一个 composition binding；required 汇总现为 18 active/21 declared-debt（原 HEAD 18/20），宿主新增 SPI 仍 declared-debt/W4-E7。新 sourceDigest `sha256:8c56bbb82686cd2fbc2be56d46cf794bc5f8a5ec664a2645ccaae5b1d7d9d884`；四原规则、304 条 debt、273/31、target 69、implementation SCC 空保持，boundary added 空。六回执只更新本会话精确未发布记录，在匹配 canonical commit 后一次退役；没有替他人移除回执。

首版新节与全部旧正文/并行内容/门和 CI 历史完整保留。R2 METADATA 只检视实际变更的投影和新增记录；只做目标 format/lint、纯源码/AST/JSON/字节证明与原 scoped 生成，无 AW 本机 tests/typecheck/build/service。正式行为仍待新 exact-SHA hosted CI。完整 A1/A2/A3～A8/AC00/A-G 与后续独立 CS adapters、B/M0～M4 持续；尚无 AW-in-CS 实际部署，不关闭 RFC。

## 2026-10-03 宿主 application 与证据 writer 根接线进度

12 路径 SOURCE 有限 PASS `f493a18e5ff395a70d576e97fe15da31624de2e096e4609e2084398d8250dc7b`：真正的 SO application consumer 与唯一 root composition 承接 host ACK 协调；原规则下 DaemonHostLifecyclePort 成为 active，39项现19 active/20 declared-debt。StartOptions/session/recompose/SQLite/PG/standalone 同一 document writer 已到 materializer，双 provider 真 HTTP answers 的 own/prototype/held ACK/replay/逻辑引用回归已编写。九份旧文件逆变换及七控制 SHA 保持；W29 仅 PG实际接线摘要变化，数量/规则/预算保持。

前批 e0c42a53 [主 CI37050645456](https://github.com/wangbinquan/agent-workflow/actions/runs/37050645456) completed/failure（44/6），[Windows37050766328](https://github.com/wangbinquan/agent-workflow/actions/runs/37050766328) success1/1。五个功能分片的三类旧守卫 mismatch 已按实际数量/owner 路径补正；三测试有限增量 PASS `430fd59c328c035fa1268b82e7526eda61090259062728795fd885370e73bb53`，原规则和其他段落保持。12路径未变，组合15 SOURCE `d00525b2a6b937195b3acbf572a0643996dcc9d440cb9908442b359fa5ef9fcf` 复用两门；本批正式修复等待新 exact-SHA hosted CI。

原 scoped census/boundary 各一次，entry+1/import+4/exception+4/owner+4为真实投影；四原规则、304 debt、273/31、target69及implementation SCC空保持。四增长匹配 canonical 后独立退役。三个补正测试不影响 production corpus/digest额外输入，复用原生成；无本机 AW test/typecheck/build/service，旧全文/并行内容/门及 CI 历史保持。

后续仍按既定矩阵完成 raw lock/authority、全部证据物理效果、A3～A8/AC00，再独立完整 A-G；不得凭此批 active SPI 关闭整个 A1 或 A 阶段。然后各层独立 CS adapters，B/M0先实际部署，增量 M1～M4。尚无 AW-in-CS 实际部署，不关闭 RFC。

## 2026-10-03 启动租约与 CI 修复接续

启动租约14路径组合有限PASS，首门两个P2及三路径R2保留；实际acquire→diagnostics/host→boot失败→release ACK纳入统一生命周期，原native算法/proof兼容、同一lease重装配及W29原数量保持。CI两测试路径另获有限PASS；16路径复用组成当前source候选，没有重开未变门。详见 [功能门](./functional-gates.md) 新节。

fd02主CI37056660544终态46/4 failure、Windows37056797584 success1/1完整留档。本批修复真实调用账本缺数、bootstrap窗口截断和macOS全文件读取超时，保持原规则/判据/预算；正式结论等待新exact-SHA CI。scoped原生成各一次，七实际增长按原provenance协议登记并在匹配canonical后退役，peer owner/span/UI与全部旧记录保持。

下一步继续A2完整内容效果、A3/A4工作区/Git、A5材料/执行/清理、A6purpose命令、A7完整执行权/恢复和A8所有roots/AC00；完整A-G通过后才编写各层独立CS adapters，B/M0先实际部署再M1～M4。启动lease不关闭整个A1/A7；尚无AW-in-CS部署，RFC继续。无本机AW test/typecheck/build/service。

## 2026-10-03 运行上下文与员工输入根接线增量

独立 SOURCE15 运行上下文与 SOURCE7 员工输入根各获有限 PASS，合并18个不同路径，15控制保持；共享 root/W29 增量逆变换恢复先前已通过候选，复用原门。运行上下文专属 port/native adapter 和四个异步读取消费者到达真实启动/HTTP根；员工输入复用既有完整合同，同一 receiver 同时用于上传和工作区物化。原同步默认与业务 ACK/失败语义保持，新增双 provider 回归交远端。详见 [功能门](./functional-gates.md) 新节。

上一批 d2c29c15 主 CI37062367239 completed/success 50/50、Windows37062367334 completed/success 1/1，确认前次修复。承接已发布 aa6e75a4 的观测源码/登记后，本批候选和控制逐字未变，不重跑 SOURCE 全量门。原 scoped census/boundary 各一次，三个实际 growth 一次登记/匹配 canonical 后一次退役，原 required SPI 40全文、304条 debt、四规则和所有已发布并行内容保持。当前批正式行为等待新 exact-SHA CI，无本机 AW runtime 检查。

继续剩余内容 intake/blob/capture/import/materialize/上传/验证和 TE/RC 恢复、完整 workspace/Git 两 LaunchLane、A5 提交/receipt/cursor/message/cancel/终态清理、A6 所有 purpose、A7 执行权/worker/直接HTTP恢复、A8 全 roots/AC00。完成中立 A1～A8 后独立完整 A-G，再写各层独立 CS adapters，B/M0先部署再 M1～M4；尚无 AW-in-CS 部署，不关闭 RFC。旧正文与所有 CI/门历史保持。

## 2026-10-03 Mission 捕获与插件安装的根增量

复用现有完整 MissionInputBlobPersistence 和 PluginInstallerPort，在 start/session/recompose、PG、SQLite HTTP、standalone HTTP 根选择同一个 prototype receiver，undefined 保持原 lazy native factory。原上传 application/persistence/route 和插件 application/local installer/schema 全文保持。两新增双 provider HTTP 回归覆盖 capture/install 持有 ACK 时无新增行、成功精确 SHA/字节或 cachedPath/version、失败无行/无 native 回退、临时上传收尾，以及同一 installer 的 checkForUpdate 参数/响应；每例20秒预算保持。

首轮 SOURCE9 `7cf8c591e860555725d9ccc3a69edff55405e20b86cb9530a41106d05c5eb1d9` FAIL，两项 P2 为 PG call 对象重复字段（TS1117）、SQLite HTTP 漏透传。三路径 R2 独立 PASS `94d3cc13828a20e860ead3880e6073708caecb9ceee226d7ca5c9d2279ccfc62`，其他六路径和八控制逐字不变，组成九路径 PASS `7c310363c13f5d98ba4110bc7f87df0c62c3d05b04d3ddcbe791620ffea34759`；不重开全量门。R1 26 段恢复七份原全文，R2 四段恢复三份 R1 全文；新 AST 逐个定位真实 PG/SQLite HTTP call，字段唯一且 receiver/值正确，替换原失效的字符串计数。

原官方 scoped census/boundary 各一次；imports5784→5790、exceptions5142→5148，只新增三根的两 existing type 共六条边。40 原 required SPI 全文（20 active/20 declared-debt）、entry1823、owner25903、public1053、background345、ambient501、全部 metrics、304 原 debt 条款、273/31、target69 和 implementation SCC 空保持。14 ambient 行地址只随真实 source 行号移动，语义 multiset 保持。sourceDigest `sha256:4626f1c7d9de8c924798d48e360e0b690020a61b6ee3cf4b035b2622f92571ea`；两真实增长在匹配 canonical commit 后一次退役。四新文档段落逆变换恢复原全文。无 AW 本机 tests/typecheck/build/service，只做目标 format/lint、纯源码/AST/JSON/字节证明与原 scoped 生成。

上一批 b7c37804 主 CI37070701985 completed/cancelled（22 success、18 failure、10 cancelled），[Windows37070910393](https://github.com/wangbinquan/agent-workflow/actions/runs/37070910393) completed/failure 0/1。功能日志确认并行观测夹具 TS2345、runtime/runner 原断言、观测路由合同/MCP、测试引擎账本和前台样式/重试入口回归；Markdown 五项历史 run 链接为 GitHub502。owner 的两路径类型修正已发布1538a380，九候选/八控制/四规则不受影响，复用 source 门并基于此精确同步 SHA 生成；其余观测回归已协调 owner 接续。旧失败/取消保持，不将成功片段记为全套绿，正式行为等待新 exact-SHA hosted CI。

完整 A2 继续 evidence intake/import/materialization/验证输出、resource-package/runtime 插件与 GC、TE/DE 内容/recovery和worker archive；A3/A4 两 LaunchLane/全部workspace/Git，A5完整执行链，A6全部purpose，A7authority/worker/remote orphan恢复，A8全roots/AC00和独立完整A-G持续。随后独立CS adapters、B/M0先实际部署，再逐项M1～M4。尚无 AW-in-CS 部署，不关闭RFC；旧正文、全部门/CI历史及并行输出保持。

## 2026-10-03 证据物化、导入和输出的根增量

复用既有 MissionInputBlobPersistence、evidence content/document/download/context 完整合同，新增 EvidenceArtifactPort 只补逻辑 blob/bundle 物化和存在性 effects。原 EvidenceStore/native class 与 helper 全文迁至 infrastructure/local，旧入口保持兼容导出；选中的 complete prototype receiver 沿 start/session/recompose、PG、SQLite HTTP 和 standalone HTTP 根传入 DA、DE pipeline 与 Mission。原调用方的 staging、receipt、digest 和验证业务规则保留；等待所选物化、adopt 和 JSON 写入 ACK 后再发布 durable 引用，失败保持原错误语义并清理暂存。

新增功能回归覆盖 native 二进制/context/download 合同、hold-ACK adopt、materialize saved/throw/missing 与暂存收尾、三类同地址 seed 重放，以及双 provider 真 HTTP capture/JSON-answer 的 hold ACK、成功精确 bytes/digest/业务行、失败无 durable 新引用或 native 回退。原 rfc310 journey 改用 adapter-owned native 路径闭包，原 missing/status/range 判据保持；mode 新判据保留原 Windows 分支。这些运行回归只交 hosted CI，源级证明不冒充实测。

SOURCE24 首轮 `d11853a87eb2650d6cff3daeedfade4dd888d5bb538b28845b00bebfe9f6067e` FAIL：同一物理 seed 在新增 await 窗口重放会重复物化/rename，以及新增 mode 判据遗漏原 Windows 分支。两路径 R2 `9bea70b062bc5003855d54f9b9550ad08662dbb29bb3cfc2be9ac47f3edcc7c6` 独立 PASS：复用原 KeyedSerialQueue，以 seedsRoot+planDigest 的实际物理地址串行发布并在持锁后重查；失败释放、后继重建，原 win32 判据恢复。其余 22 路径和 8 控制不变，组成 SOURCE24 PASS `e3b2d0095d7bcab431c2e3587023bade8efe76904129847ae928f065343b4bba`；保留首轮 FAIL，未重跑已完成全量 source 门。155 段逆变换恢复 19 份原全文及 native 迁移原文；10 个实际 root call 的新字段唯一、选中 receiver 正确，原 9 个核心 native 方法 token 逐字保持。

本批原 scoped census 与边界报告各一次；imports5790→5794、exceptions5148→5152（3 条 EvidenceArtifactPort bootstrap type 边与 1 条既有 KeyedSerialQueue value 边），owner25903→25907（3 旧 native owner 迁移，7 新位置 owner，净增 4）。entry1823、public1053、background345、ambient501、全部 40 required SPI 全文（20 active/20 declared-debt）、304 原 debt 条款、273/31、target69、implementation SCC 空和 unresolved 空保持。13 ambient 地址只随真实行号移动，语义 multiset 保持；moduleFiles1469→1471、backendProductionFiles2026→2028，仅本批两个 DA source 文件。sourceDigest `sha256:954ca22d88be78bbb544504040a5d39d052e84e7558288fdc19b74e468f04bcf`。只登记 3 个真实 inventory 增长，匹配 canonical commit 后退役；后续自有 RC/SC/Worker WIP 与并行 EOF 统计均从本候选原统计中排除，保留现场文件。四独立新文档段落经逆变换恢复原全文，四条原规则未变。

此前 f3eedc6aa9cd380dbcc6b32b83be1f58da591752 的主 CI37074418502 completed/failure，50 项为 33 success/17 failure；[Windows37074493098](https://github.com/wangbinquan/agent-workflow/actions/runs/37074493098) completed/success，1/1。已保留原失败功能日志和归属，不能据部分 green 关闭。并行观测 owner 的源码1873e606、canonical cf83e1c5、正常退役655d1e8b已发布并交接共享窗口；同步0/0后复用完全未变的24+8 source 门，以655d1e8b原分类生成本批登记。owner追踪其 exact-SHA CI，本批运行行为等发布后的新 exact-SHA hosted CI；没有运行 AW 本机 tests/typecheck/build/service，已做定点 format/lint、纯源码/AST/JSON/字节证明与原 scoped 生成。

完整 A2 仍需 resource-package/runtime 插件与 GC、TE/DE 内容/recovery、全部 worker archive 和其它读取/物化链；A3/A4 两 LaunchLane/全部 workspace/Git，A5 完整执行链，A6 全部 purpose，A7 authority/worker/remote orphan 恢复，A8 全 roots/AC00 和独立完整 A-G 持续。只有完整 A-G 通过后编写独立 CS adapters；B/M0 先实际部署，再逐项 M1～M4。当前尚无 CS production adapter 或 AW-in-CS 实际部署，不关闭 RFC；原正文、门/CI 历史和全部并行输出保留。

## A 段增量：SOURCE28（2026-10-03）

本批完成两个 provider 的 workspace tree/file 内容选择、资源包 skill/plugin/export 完整 owner 接线，以及 maintenance Worker 内重建的三类完整效果（archive、包恢复、plugin GC）。所选对象的原 receiver、逻辑引用、ACK 与失败语义贯穿实际装配入口；CLI 初始和替换 session 传递同一完整选择。重复 drain 共用包含 heartbeat、效果 dispose 和 provider close 的完整关闭 Promise，不能提前发出 drained。

Worker 有限 DESIGN v2 PASS；SOURCE26 首轮 FAIL 的 `SOURCE26-P2-1`（重复 drain 可能早于 PostgreSQL pool close）由 R2 SOURCE4 PASS 修复。原始 boundary collector 随后发现三条新 helper 到 module-internal composition 的类型引用；保留第一次生成和失败，未改 `BOOTSTRAP_FILES`、规则或债务条款。R3 经有限 DESIGN/SOURCE3 审查，将同一完整类型经现有 exact `public/types` 入口重导出；三个改动文件生成的 runtime JavaScript 与前版完全相同。组合 SOURCE28 指纹 `bdee22293f4fa32d75e1bb7728ada62cf18be3d64ca1498b6790a84df7996452`。

原始 scoped census 为实际 SOURCE28 候选执行一次，排除并保留 RFC-371 的 4 个 tracked 和 15 个 untracked 源码 WIP。实际投影：mutation 1823→1826、background 345→352、observed imports 5794→5809、exceptions 5152→5167、public surfaces 1053→1056、symbol owners 25907→25932。6 个 native content helper owner 完整迁移，4 个既有 timer 仅变更行号，15 个 ambient 条目仅变更行号（501 总数和语义不变）；supervisor 的 phase 字段由原 collector 对 `effectsBootstrap` 文本重新投影，原生命周期不变。原 40 required SPI、69 target edges、304 债务条款和 273 inbound / 31 outbound 保持，新增 boundary 违规为 0。新增生产文件 4 个，source-control 文件净增 2 个；值循环及未解析 first-party 依赖未增加。仅登记这 6 项实际数量增长的一次性回执，并在 canonical commit 后按原语义退役。Source digest `sha256:d7cd21a663d5fde3d45b5bf92bbc204ab35a92f4e365a18ff552d9b4c72f542f`。

CI 修复提交 `3ff61d9eba0b129953d09d966235d7a2b3ca633c` 的主 CI `37087805975` 为 50/50 success，Windows `37087878452` 的第二次 attempt 为 1/1 success。保留第一次 attempt 的三个既有 code-intel 5000 ms timeout；未放宽断言或时间预算。该 CI 仅证明修复提交，本批 SOURCE28 的正式 whole-repository 结论待发布后的 exact-SHA CI。

下一步 EmployeeCase 使用完整、可异步的 FS/raw Git 操作 scope；Git argv 的 literal 与 opaque reference operand 显式区分，三个 clone/fetch 引用由 adapter materialize，原业务参数及顺序不变。8 个原操作、6 个实际 binder、3 个 checkpoint consumer 属于下一独立源码候选，本批未实施。

完整 A1–A8/A-G 仍开放。本批不等于其他 Worker 效果、execution authority、workspace/Git、物化快照、执行流和全部装配入口的闭合。后续先实施已通过有限 DESIGN v2 的 EmployeeCase 完整效果范围，再继续剩余中性切面；CS adapter、B/M0 实际部署和 M1–M4 验收尚未实施。

## 2026-10-03 Employee case 内容/Git 接续

已完成 SOURCE18 的实现与有限独立功能检视：SC 独立端口及 native 包、原 8 个操作的 scope 生命周期、三处 DA checkpoint 等待，以及 SQLite CLI、PostgreSQL CLI 与 SQLite HTTP 两组业务 binder 的完整工厂传递。原 CLI 字段冻结和 session replacement 传递保留，新 held checkpoint 验收同时等待内容与 close。

本批同时修正 d3 已确认的 content root 自由变量、W29 闭包断言、resource fixture opId 和格式错误。PG Worker 诊断/失败断言补齐后仍待 hosted 真实错误，不能把该项写成已修复。发布、精确 SHA CI 与所有后续 A 项继续；A-G、CS adapter 与 M0 不因这一有限切面提前关闭。

## 2026-10-03 DA baseline 与 Worker 诊断实施接续

DA RepositoryBaselineEffects 的有限 DESIGN 与 SOURCE16 均 PASS，SOURCE 指纹 `67e296f121682683c51ba5af88fe6525ab3900a9a492838773e7deb2b8c51ef5`。完整 acquire/readHead/bindFileReader/close 生命周期复用原 BaselineFileReader、BaselineStat 和 SC Git outcome；两个 head resolver、上传上下文及三个 owner 由八个真实装配点传入同一 selected factory。原 SHA、Git binary cat-file/Bun.file/stream hash/finally rm 正文与 DB mapper 保持；每次 stat 使用独立 scope 并等待 close ACK，未提供选择时才使用独立本机 adapter。完整 receiver、held ACK、失败和 body/close 聚合回归已写，尚须 hosted 运行。

Worker cause 诊断的有限 DESIGN/SOURCE2 均 PASS，SOURCE 指纹 `1e854c0d42f7ca45121558c69c454ed2edfbc949a391f66453e7bfcb2e402b77`。生产改动只在实际 private errorMessage 中保留外层信息并依序附加 cause，循环有界；原查询、状态、ACK、provider 选择、close、重试和时间预算不变。这只让真实 PostgreSQL init 失败可见，根因仍未确认，不能称为修复完成。

官方 scoped census 仅使用已提交 `68bc1ce54007de881d65bb271c4b6b4fe787a591` 加本批 18 个冻结 source/test 路径，6220 个非本批源码读精确 committed bytes。四个原生成规则、所有并行输出完整保留；边界新增为 0。实际 mutation 1830→1832、observed imports 5817→5821、原 exception 投影 5174→5177、public surfaces 1056→1057、symbol owners 26032→26041；三条 native value 边和原 SHA owner 完整迁移，三个 Worker timer 与十四项 ambient 仅变行号，background 352/ambient 501 保持。40 required SPI、304 debt、69 target edges 和空 implementation SCC 保持。五项实际增长只登记一次，匹配 canonical commit 后由正常后继提交退役；source digest `sha256:64db696518fea6ecb66262efa6197a64a7682598ff12acd1808f891325a41f6b`。

前批 `12c82946bf43f5bd6ed82c3d086a4f2a8b662781` 主 CI `37098130275` 已 completed/failure（35 success、15 failure、50 jobs），Windows `37098130258` failure，maintenance `37098130248` success。三个纯测试修正另已推送 `68bc1ce5`；其主 CI `37101610276` 在本节冻结快照仍 in_progress，未取得全绿终态。全部旧失败、取消和首门修正保留。本批正式行为仍以发布后 exact-SHA hosted CI 为准；本机只作原 census、纯源码/AST/JSON证明及目标 format/lint，没有 AW test/typecheck/build/service。

完整 A1–A8/AC00/A-G 尚未关闭。下一项继续 DA workspace 原 protected/business snapshot 与验证效果，随后完成其余内容、工作区/Git、执行、命令和执行权切面；CS 独立 adapters 与 B/M0 实际部署、M1–M4 仍按已批准顺序实施，尚无 AW-in-CS 部署，不关闭 RFC。

## 2026-10-03 DA workspace 效果切面实施接续

DA workspace 完整效果切面的有限 DESIGN PASS 指纹 `5171146df940948a8cc2e265a08f1358b9cef9708c1c0e486067b39b940fda06`。原 SOURCE19 指纹 `aa3f369a5df7d1d1c738052e872850bacbb6f80b07bbdac7e22a2872a94cad24` 的首次 FAIL/P2 完整保留：真实 Case 成功夹具缺少 ReactionRound 外键父行。只在新增测试补齐合法 round，并明确 native 字节值比较；单路径 SOURCE-R2 PASS 指纹 `6cc20311c3076d90c0e60dbf7b60d0283ea7df4f707d81d3e55cb1639202f37d`，其余18路径、9控制、5原证据未变。合成19路径 SOURCE 完整通过指纹 `1595b66a6ff5b103f9536c87834dd0e439859e0310749e6ac4bd7746e42cd70d`，不把首次 FAIL 改写为 PASS。

完整 factory 的 resolve/parent/acquire 与 scope 的12项操作由同一 selected receiver 执行；默认独立 local adapter 保留原 Node 操作，显式选择只用完整选择。protected/business snapshot、workspace validation、初始上传/输入材料、冲突/冻结平台工件与 hydration 全部串行等待操作和 close ACK；原 digest、DTO、判断与持久化顺序保留。Agent orchestrator 的 capture/validate 两处等待完成，九个真实 CLI/PG/HTTP binder 贯穿同一工厂；CLI 三份配置与 HTTP 测试 helper 同步。原84个物理操作及其参数、18个完整 CPU/DB 函数、两个 owner 的全部持久化调用、旧validator断言与预算均有一次成功的纯源码/AST逆向证明；W29 仅按原 normalizer 更新实际 PG 与 HTTP mount 投影，SQLite/events 和原168/49/65计数、八PG phase不变。

官方 scoped census 只读已提交 `dcdc249ff50bac893edbf8c19b6ad12cd264e0b6` 加本批19冻结路径，6223项非本批源码读该基准的精确 committed bytes，排除并保留并行7项源码 WIP（1 tracked、6 untracked）。四个原规则保持，边界新增为0。实际 mutation1832→1833、observed imports5821→5824、原 exception投影5177→5180、symbol owners26041→26057；三个实际根只新增工厂类型引用，原行和退休说明保持，16个实际 owner新增。13项ambient仅变行号，background352/ambient501、public1057、40 required SPI、304 debt、69 target edges和空implementation SCC保持。四项实际增长登记一次，matching canonical commit 后以正常后继提交退役；source digest `sha256:0f079fea01a5169edbb0c51157a4e230ae267e8ace337f966f46f9942749f305`。

前批 `13e72ad8326a85add6f5c73532a33848458288ac` 主 CI `37103290740` 已 completed/failure（47 success、3 failure、50 jobs），Windows `37103290747` 与 maintenance `37103290722` 均 completed/success。两个真实失败分片为 macOS 原报表数据库文件判据和 Ubuntu 的四个真实 PG Worker用例；聚合失败另计。真实 Worker cause 已显示查询 `agent_workflow.maintenance_runs` relation不存在，原时间预算未改。并行原报表文件修正 `c5cba4ee` 与配套 `c01f1dec` 完整保留；本会话两个 Worker fixture 文件另已精确发布 `dcdc249f`，通过完整 DESIGN/SOURCE-R2（原 env 类型 FAIL保留），从调用时的已定义环境值启动实际 source Worker；生产 Worker/runtime/协议/DDL未变。该 SHA 主 CI `37107720458` 已启动，创建回执状态为 pending，尚未取得全绿终态；不能称 Worker 修复已验收。本批正式行为仍交发布后 exact-SHA hosted CI。本机只做原 census、纯源码/AST/JSON证明和目标 format/lint，无 AW test/typecheck/build/service。

完整 A1–A8/AC00/A-G 继续：内容与恢复、其余工作区/Git、完整 Agent 材料/执行/清理、专用命令和执行权仍须逐组接线与完整功能复核。CS 独立 adapters 与 B/M0真实部署、M1–M4按批准顺序实施，尚无 AW-in-CS部署，不关闭RFC。

## 2026-10-03 DA workspace CI 修正接续

精确 `6942511731dcaaf501756671e5dc99cc9d28efbd` 主 CI `37109647129` 已 completed/failure（44 success、6 failure、50 jobs）；四个 backend 分片的两个失败各在 Linux/macOS 复现，typecheck 与 required 聚合另计。Windows `37109837274` completed/failure，maintenance `37109647139` completed/success。失败证据保留，未把旧成功或重跑当成本批通过。前次 `dcdc249ff50bac893edbf8c19b6ad12cd264e0b6` 的主 CI `37107720458` 已 completed/success（50/50），四个原真实 PostgreSQL Worker 用例及 compiled Worker 加载均通过；这是 Worker fixture 修复自己的证据。

本次仅三个文件：原 guarded exists 的两项非空断言只恢复闭包类型；新 DA launch 夹具提供完整 adopt，并 stashing 与原 launchDirect 冻结一致的 Add feature/do the thing 内容；旧 EvidenceStore default 断言精确映射到 selected factory.resolve，并额外断言真实完整 factory binding。原 guard、内容/持久化顺序、所有既有断言和时间预算保留。有限 DESIGN PASS `a7c672dd90607d764261f912d6f03be79668251f78d1100a3471fbaffdba4e9d`，SOURCE PASS `8192ee83b0afe0d3ff280ae0c18ae256a5bdc755751d57eab9588e25e24297f3`；三份全文件原字节逆向证明、11控制稳定、原预算/断言保留已完成。本批行为仍须新 exact-SHA hosted CI，无本机 AW 测试、类型、构建或服务。

原官方 scoped census 只读已提交 `6942511731dcaaf501756671e5dc99cc9d28efbd` 加本批3冻结路径，所有非本批源码精确读取 committed bytes，排除并保留并行 WIP。12 JSON 与 status 使用四个原规则；全部 inventory 行、账本、原债务、required SPI、target edges 与 metrics 完整保持，不新增 growth 回执。只更新原精确源码投影及 provenance，source digest `sha256:4028cc01a4a986f8b89b20d8a6613b927bff01ea0122b763031999b4248efc1d`。四份手写文档以增量保留全文，status 仅原 renderer生成。

完整 A1–A8/AC00/A-G 仍开放。下一组继续资源包恢复的存储效果；CS 独立 adapters、B/M0 真实部署、M1–M4 按已批准顺序实施。尚无 AW-in-CS 部署，不关闭 RFC。

## 2026-10-03 资源包恢复内容实施增量

资源包恢复内容切面有限 SOURCE 门通过，指纹 `70845648e44cf0a51a33617374abe452ad83037004f2f890030edef597acdfe9`，16 路径（11 旧、5 新）。原 DESIGN 首门一条 P2 和 DESIGN-R2 PASS 都保留：RFC-349 的三处旧 native 消费断言迁移到实际 owner 调用，同时增加原本机 helper 的三处实际绑定断言。完整工厂十项、scope 十项，同步／异步选择及 prototype/private/frozen receiver 保持，缺选择才默认本机；显式不完整选择不会逐方法回落。acquire／内容／close 全部结算后才回到 AW 的 finish／abandon／boot mark／journal settle，body 和 close 单一任意拒绝保留原值，双失败保留顺序。CS adapter 尚未实现。

SQLite／PG 两个 owner 保留原 receipt、代际、快照、DB query／transaction、批次顺序与两种旧新工件格式的 fallback。SQLite modern primary 与 legacy owner 共用同一所选完整工厂。旧 artifacts 整体 override 保持惰性默认，新 content 工厂与有效旧整体 override 同时选择时只报告明确冲突。Worker 第四能力 resourcePackageRecoveryContent 从 RC exact public/types 进入两种实际维护 composition，原 v1 init／事件／作业命令／factory-before-DB／drain／dispose 保留；只有原 v2 描述符 enum 增项。引用归所选 adapter 解释；AW 仍拥有原 sorted-relative-name/NUL/content/NUL 树 digest，不把 CS 原始对象 digest 当树 digest。

一次原调用 census 与有限逆向证明核对 83 处原内容／引用 operand、15 处 AW 业务／数据库调用、原完整查询和 11 个旧文件全文；原断言、时间预算和全部 control 保持。纯证明 helper 的 R1–R3 空行逆变换失败记录保留，R4 成功；不是 runtime 验收。新增 logical/native、双 provider journal／代际／held close／可重试，以及 source Worker BroadcastChannel 的真实作业与 drain 回归。只做目标 format/lint、纯 AST/JSON/byte 证明及原 scoped census，不运行本机 AW test/typecheck/build/service。

原 scoped census 只读取已提交基准 `6cd43bd7728f3b1c150a2c2783d515ce6f7c26e2` 加冻结16路径，所有非本批源码均从 exact committed blobs 读取，排除并保留并行 WIP。正式投影：entries 1834→1835（新增1／删除0／同id改动0）；entries 353→356（新增4／删除1／同id改动0）；ambientWiringEntries 501→501（新增0／删除0／同id改动0）；entries 26113→26124（新增11／删除0／同id改动0）；entries 1057→1059（新增2／删除0／同id改动0）；observedEdges 5829→5830（新增2／删除1／同id改动0）；architectureExceptions 5184→5185（新增2／删除1／同id改动0）；requiredPorts 40→40（新增0／删除0／同id改动0）。原规则、全部 required SPI、commons debt／target edges 不扩大；实际正增长按原 allowGrowth 协议登记 6 条消费回执，matching canonical 正常提交后再按原协议退役。已匹配观测源码及 canonical 的5条旧 growth 保留历史理由并正常消费；本批六条新 growth 只覆盖原分类器的实际增长，background净增3来自native factory／selector／scope helper的long-running库存分类，原Worker interval只移动行号，不声称新增timer。source digest `sha256:ef5b32f6b2e08ec16741a663c2d4094d60b9e89f541b68c9274e881831bef29c`；四份手写文档增量保留全文，status 仍由原 renderer 生成。

前批 CI 修复 `7d12700944180f9aa1c70104ad47778548995e09` 已取得确切 SHA 终态：[主 CI37113530050](https://github.com/wangbinquan/agent-workflow/actions/runs/37113530050) completed/success，50/50；[Windows37113592469](https://github.com/wangbinquan/agent-workflow/actions/runs/37113592469) completed/success。694 的原失败和此前所有 FAIL／cancelled 历史完整保留。7d 不匹配 maintenance push filters，不声称存在对应 maintenance run。本批16路径正式运行行为仍必须由发布后的新 exact-SHA hosted CI 验证。

完整 A1–A8／AC00／A-G 继续，其他 RC content/runtime、TE prompt/material/workspace/Git 与完整执行／执行权／composition 尚待完成。有限恢复切面 PASS 不关闭完整 A-G。独立 CS adapters、B/M0 实际部署先行及逐步 M1–M4 保持已批准顺序；尚无 AW-in-CS 部署，不关闭 RFC。

## RFC-370 资源恢复公共合同修正与最终候选（2026-10-03）

前段记录的是本批首次16路径候选及其首次投影，尚未发布。原公共 consumer 守卫随后显示额外公开的 ResourcePackageRecoveryEffects 没有直接 consumer；首次 META 纯证明因此 FAIL，完整13产物、日志及全文快照保留。只有 Worker 真正消费的 Factory 需要 exact public 出口。独立有限 DESIGN-R3 PASS `09edd13ea0adffa5d36b13968e2f8478ac1577691c5b7bfb100c5237996904a5` 后，仅删除这一未发布 scope type alias，保留原 application 完整十方法 scope、factory 返回合同及所有实现和测试；单文件 SOURCE-R2 PASS `d666183e7fccbea6f4949c0148876b02d17c1c1db010ebd487c6b5d974a50716`，另外15路径及31 controls完整保持。原 SOURCE16 PASS 与单路径修正组合成当前16路径候选 `089c38dd6788b1a4448e2fdb9b540ac6ed4c03a82505df0697d2e9bd82460ca3`，两个独立回执保留；不改写首次通过或失败记录。

因本批源码内容变化，按原规则只为这个新候选执行一次 scoped census，原首次成功生成器和证明均不重跑。基准仍为 `6cd43bd7728f3b1c150a2c2783d515ce6f7c26e2`，排除所有未发布并行源码；最终库存为 entries 1834→1835；entries 353→356；ambientWiringEntries 501→501；entries 26113→26124；entries 1057→1058；observedEdges 5829→5830；architectureExceptions 5184→5185；requiredPorts 40→40。公共面1057→1058只新增已消费的完整Factory，不新增零consumer债。六项实际正增长按原 allowGrowth协议登记；已匹配观测SOURCE25/canonical的五条旧回执保留理由并消费，本批matching canonical正常提交后再退役六条。修正后的source digest `sha256:e78235a810adcc5be2aa47b23441bc31605121d73ca37d7127bf0ea8f2a4e3ef`。前次未发布growth及文档也保留为首轮历史，四份完整原手写文档和首次增量均保留，本段只作追加。40 required SPI、304 commons debt、69 target edges、原四个生成规则均保持，不新增边界债。

7d主CI37113530050 completed/success 50/50、Windows37113592469 completed/success是前批精确SHA证据；本批行为仍待发布后新的exact-SHA hosted CI。未运行本机AW test/typecheck/build/service。完整A1–A8/AC00/A-G、CS独立adapters、B/M0真实部署及M1–M4按已批准顺序继续，RFC不关闭。

## RFC-370 Task 删除与恢复效果切面（2026-10-03）

Task 删除/恢复完整效果切面的有限功能 SOURCE16 组合通过，指纹 `0f2325263014b661b93050fd6e0bd98ca41328d19205dda6724469de280cd1d1`。原首轮 SOURCE16 `9008a6df3cf8b324e009ff000979806ffef00365a6c04190811fdb51da649e8b` FAIL 完整保留：一项 P2 是新增根测试把派生 PG 接口当作字段直接声明者，另有并行 Worker 对 census.ts 单一控制的首末漂移。独立 DESIGN1-R2 PASS `cb86a3c82efb468e3f8187566fa0556f43e398f84ff768b3e9441163e1d1c4d2` 后，只修这一测试的实际基接口定位，并增加严格 Omit 继承检查；原36个断言保留、新增10个，所有测试名/预算不变。SOURCE1-R2 PASS `769caf5413b53f109c87e5f4e3d1f9544a89012561d0a53f2bf051c131905fd4`，其他15源码和28控制共43项稳定；不重审已完成部分，不重写首门为成功，不声称29个原live控制未变。

TE 拥有目录引用/复合存在并删除内容合同和完整效果选择；SC 在独立 local 包实现 worktree 删除与 snapshot refs 清理，由自己的 composition 提供 factory。相同完整 receiver 经 StartOptions/frozen provider session/重装配、实际 SQLite/PG boot 与 HTTP/standalone 根传递。undefined 才选择完整 native 默认，显式不完整选择不逐方法回落；复合 exists+rm 不拆开，所有清理 ACK 之后才结算原 done/cleanup-pending。v1 按耐久成员重新派生目录、v2 保留冻结引用；原 worktree fallback、首失败 sticky、snapshot/目录继续清理及原日志判据保留。12处原native参数、31个原数据库调用子树、两份完整DB函数、45段逆变换恢复10份旧全文；单测试补正两段逆变换另恢复首次测试全文。全部新行为和双provider/native Git回归只由hosted CI运行，没有本机AW tests/typecheck/build/service。

原 scoped census/boundary 各只执行一次，输入仅已提交 `2d9e660936f25d5147bfbb5b0118f110e90947e1` 加本批16源码。所有非本批源码及四条原规则均从该基准精确 committed blobs 读取，按并行 owner 明确协调排除/完整保留其未审 Worker 与 census WIP，不提交该规则。当前source digest `sha256:683e591d4e6b7e563e33f46e915a06f296bbc92116b5339e20af5d607c8e8516`；实际库存 entries 1835→1837；entries 356→356；ambientWiringEntries 501→501；entries 26124→26136；entries 1058→1060；observedEdges 5830→5837；architectureExceptions 5185→5191；requiredPorts 40→40。五项真实正增长按原allowGrowth协议登记，在matching canonical的正常后继提交退役。14项ambient只有实际源码行号移动，background数量356保持；两处transaction只随真实位置166→177、267→264移动。两公共合同分别有实际1和4个生产消费者，未增零consumer债；40 required SPI、69 target edges和空implementation SCC保持。304条原债务的条款、reason、退役条件、bootstrap列表保持；只有TaskDelete既有同一registered恢复facade条目的两项canonical引用数组新增实际selector消费，不把投影变化宣称全文不变，不新增R1/R2条款或豁免。四份手写文档完整旧文保留，status仍用原renderer。

资源恢复发布SHA `87356a1f072d92b373d301fcd34c6ab58ae9b4dd` 的主CI37120118172 completed/cancelled（16 success、2 failure、32 cancelled），Windows37120183529 completed/failure，maintenance37120118245 completed/success。主/Windows实际两项类型错误均在并行观测fixture，owner已精确发布两份fixture修正 `2d9e660936f25d5147bfbb5b0118f110e90947e1`；其主37120550528和Windows37120910643在保留初始快照时尚非终态，不冒称整套绿。本批Task实际行为仍待发布后新的exact-SHA hosted CI；更早全套成功和所有FAIL/cancelled历史保持。

完整A1–A8/AC00/A-G仍开放，继续其它内容/工作区/Git、Agent材料与执行、所有purpose命令、执行权/恢复/实际roots。独立CS adapters仍在完整A-G之后；B/M0先真实部署，再逐项M1–M4。尚无AW-in-CS实际部署，不关闭RFC。

### Task W29 摘要补正与最终 SOURCE17（2026-10-03）

在已通过的有限 SOURCE16 基础上，只新增原 W29 unstarted application 测试的一项两字符串补正。独立 DESIGN1-W29 PASS `f07e8b30e06f5be4db1cedf9108238dc635944734a746ad3501a06ba1c7dd119`，SOURCE1-W29 PASS `0ec568ebec71fa09d7e7a5d5ce85431a1e1e7283a969155c4c0ffbb82dac4391`；最终有限 SOURCE17 组合 `2ba0bcf17579d97c758fce16161ff36295d521f4c6a6516f4f63b4a2e33526b1` 保留原 SOURCE16 FAIL、根测试 SOURCE1-R2 PASS 和本次 SOURCE1-W29 PASS，不重复完整源码门或将首次 FAIL 改写为通过。

PG 摘要 `23e198e5a2d9bfb4bfbb53f6b7e9f6e51318159258db7293fa21bded160f88fc`→`06d482d3e3d8af1133f15d02f53242fc86d708e20da494fd169b04e55bafd284`、HTTP mount 摘要 `d3807fcbfcc458c3a8e1312f9e294b52a689d2776de82e3d37a95869c77bb851`→`bfcc15d74b7f6e582aefb88a8611a9ae0cca09ce4f15ee840ecf0e6b5144f8ac`；原 normalizer 只读投影已执行一次，实际测试完整逆变换仅两处字面量可恢复旧全文。PG168/SQLite49/HTTP65语句和8个PG phase保持，SQLite/Event摘要、所有原断言/名称/预算/其余字节保持；44项控制稳定。本机只做该文件格式/lint与纯字节证明，真实应用行为仍以新的exact-SHA hosted CI为准。

新增 W29 路径位于 tests，不属于原 canonical 的 backend/shared/frontend src 和两项额外 sourceDigest 输入。13个生产源码和 `.dependency-cruiser.cjs`/`scripts/depcheck.ts` 及原 committed 四规则保持；因此复用输入指纹 `0f2325263014b661b93050fd6e0bd98ca41328d19205dda6724469de280cd1d1` 的一次成功 scoped census，不重复生成、增长登记或完整SOURCE。五项增长与304条原债务条款保持；已有TaskDelete facade只有两项实际新boundaryEdgeIds投影增长，旧恢复债条目只有两项canonical引用数组更新，均不改变条款或豁免。

并行两份观测夹具修正 SHA `2d9e660936f25d5147bfbb5b0118f110e90947e1` 的Windows37120910643已取得 completed/success（1/1）；此前资源恢复 SHA87356a1f 的失败/取消终态与实际日志仍保留，不据后继Windows单项成功声称旧SHA或整套CI通过。完整A1–A8/A-G、后续独立CS适配器和AW在CS的真实部署仍未完成，继续实施。

### 已发布资源恢复 CI 源码断言补正（2026-10-03）

观测夹具修正 SHA `2d9e660936f25d5147bfbb5b0118f110e90947e1` 的主CI37120550528已取得 completed/failure：45 success，4个backend分片及required失败；Windows37120910643 completed/success。四个backend失败对应两项已发布RC迁移遗漏的旧源码定位：P1-5 committed重放仍查旧renameSync/swapInStaged位置，RFC359孪生体消费名单仍查两个旧provider位置。完整原失败日志与终态快照保持，不重跑或改写失败结论。

两测试独立 DESIGN2 PASS `998e7dd582a3feaa791972749352a36d22ccd1d0affb0bafad1be4bedb93078b`、SOURCE2 PASS `272d550cf15340b96bb404b809656a96d6edf2d84edaedb52dadd11e45e9101d`。原两项前滚调用断言映射到同一恢复体的await effects.move/await effects.swapStaged，再增3项锁完整awaited scope与local adapter原native调用；所有其它原断言/测试名/预算保持。原64项断言→67项；孪生体测试15项保持，仅该消费者名单2→1实际localadapter，定义点/homonyms/forkedFrom和全部引用/陈旧名单校验不变。两份旧全文按四段逆向恢复，45 controls稳定；不修改生产代码，两测试均在原sourceDigest生产语料之外，复用一次成功census。

本次发布分为Task源码17路径、这两项RC测试精确补正、canonical/docs17路径及匹配5项增长回执的正常后继退役，合计36个独立允许路径。Task17组合指纹 `2ba0bcf17579d97c758fce16161ff36295d521f4c6a6516f4f63b4a2e33526b1` 保持，完整A-G/CS adapters/真实部署仍开放。canonical另有6项原Task写点位置投影：恢复238→249与256→267、路由1855→1857与2181→2183、TaskDelete328→325与364→361；除实际id/line外各字段和原31个DB调用子树保持，不改业务写入规则，不新增条款或预算。

### 2026-10-04 A-T2 prompt 内容有限接续

完整内容效果与旧本机同步兼容面已分层，所有本批runner、读取/导出、session、memory源与timer、SQLite/PG/HTTP实际根和测试helper贯穿同一选定服务。原三P2 FAIL 保留并由REPAIR4有限关闭，ROOT-SOURCE4和W29 SOURCE1通过；SOURCE45指纹 001636f787e73a5439dcce0087d364645c20c0aa91c5cf8fa9f408508e332217。原normalizer、DB调用、旧449断言/119预算与观测共享输出保持。canonical按committed 0b8910ab8d88fff0df68dad416169895d6fc1165 加45owned生成一次，实际增长 rfc294-mutation-entrypoints、rfc294-cross-context-observed-imports、rfc294-architecture-exceptions、rfc294-public-surfaces、rfc294-module-symbol-owners 由matching回执后继正常退役。正式运行行为仍以发布后的exact-SHA hosted CI为准。

此切面只关闭prompt内容范围，其它TE工件/物化、工作区/Git、Agent材料与执行、purpose命令、执行权/恢复及全部真实根继续，完整A-G尚未通过。按已批准顺序完成A后，再独立CS adapter；B/M0先真实部署并验证已有编辑耐久闭环，再逐项M1–M4。

六条新增 R1 的原失败记录保留；PUBLIC-CONTRACTS-DESIGN10 与 SOURCE10 80687f0f61ac2016eb6289bdc08182cf76fb58b68c89c3559ab22255e62cb0ca 通过后，三份同步 helper 原函数 AST 原样迁入 composition，旧服务改走 exact public/commands、queries、types，三个旧消费者只改 selector 的 public/participants import。构造器不公开，三个根与 ACK 顺序不变。unit 原54断言/11名称预算和全原AST保留，新增公开合同函数身份及完整receiver/heldACK回归；修正后纯 committed-rule 边界复查新增为0，无新债务条款。

原生成规则只销账一条已消失的 memory 蒸馏→旧 prompt service 的 R2；原304条完整记录留在 before 证据，其余303条全文、理由与退役条件保持。registered findings、40 required SPI、69 target edges 和空 implementation SCC 均不变。

## Prompt 批次 CI 接续（2026-10-04）

三个 prompt 提交已发布，末 SHA489919498495eefe26a172b1423f89c3cf4a8d56 的主 CI37142743857/Windows37142743879 均失败，maintenance37142743868成功；旧终态不改记。四个本批测试回归已按原功能规则修正并通过有限独立 SOURCE4：共用 factory、真实类 receiver 委托、实际薄 facade 和 AST 行地址。目标 format/lint及纯 AST/字节证明通过，无本机 AW 执行检查，正式结果以修复提交确切 SHA CI 为准。并行观测失败已按归属协调，不改动或提交对方 WIP。完整 RFC、A-G 与实际 CS 部署持续；下一项 port-artifact 内容切面独立设计。

## 2026-10-04 Prompt 用户模板 CI 补正

确切 SHA `9bdc8323a99c0de2ca955ca0945ba063ef927382` 的主 CI37146579007 已 completed/failure，41 success/9 failure；两后端分片唯一失败是原 prompt ACK-order 夹具，六个 E2E 失败属于并行观测页面，原完整日志保留并已最小必要协调。原 prototype/receiver 补正已到达 store，但夹具只设置 Agent 系统 bodyMd，用户模板为空，故长正文断言报错。只在实际 runNode 对象新增 `promptTemplate` 长正文参数；原176个expect AST、10测试名称/预算及其余全部字节保持，原 store→patch→mark-running 与双 held ACK 断言不变。

单路径有限 SOURCE1 PASS，指纹 `f488acc0df17e6e0f530f45c7274bd2a8def8605acdd88d23a740591732c2f8e`，1 owned/8 evidence 首末稳定；目标format/lint及精确单参数逆变换通过，生产代码和 canonical 不变，不重复生成。未运行本机 AW tests/typecheck/build/services；新正式结果仍须看修复提交 exact-SHA CI。前批 SOURCE4 PASS 与两轮正式 FAIL 原样保留，不能以有限门宣称全仓通过。

完整 RFC370/A1–A8/AC00/A-G、CS adapters 及 B/M0–M4 继续；A2 portArtifacts 实现在制，排除本次测试补正发布，尚无 AW-in-CS 实际部署。

## 2026-10-04 Prompt 同毫秒 sibling 夹具 CI 修正

确切 SHA `37b9a84a908993b64985e7eb62c5b2bd6d6bcb87` 的主 CI37148836427 completed/failure，42 success/8 failure；macOS 后端分片及 Lint/Typecheck/Format 通过，Ubuntu6 唯一后端失败在本批新 prompt binding 夹具。原 session 查询按 ID 升序，detail/legacy 按 startedAt 再 ID；两个随机 ULID 在同毫秒可反序，使所选 read 调用顺序断言失败，而正文结果仍正确。只让 sourceRun 夹具使用同一 monotonicFactory 生成 ID，保留原生产排序和全部176个expect AST、10个测试名称/预算及 store→patch→mark-running/held ACK 断言。

有限 SOURCE1 独立功能门 PASS，指纹 `247568754fcdefe55e0eca6eb0627f4a1e8badff160d005b31d69c00e20168fe`，1 owned/4 controls/4 evidence 首末稳定；两段逆变换恢复完整旧测试，目标format/lint及纯AST证明通过。生产及canonical不变，不重复生成；无本机AW test/typecheck/build/service。保留旧失败及六个观测 E2E job 的完整日志，其归属由原并行会话接续；新正式行为仍待修复提交 exact-SHA hosted CI。

归档内容候选在单独有限功能门中发现 fanout 两处所选效果遗漏、任意 Error.message 转换、新 Agent.outputKinds 夹具及 Windows 原路径 oracle 四项，首 FAIL 将保留并另行修复，不纳入此次提交。完整RFC370/A1–A8/AC00/A-G、CS独立adapters及B/M0–M4继续；尚无AW-in-CS实际部署，不关闭RFC。

## 2026-10-04 端口归档内容切面的有限接线

SOURCE36 首次四项 P2 FAIL 原样保留；有限 SOURCE4 修复了 fanout 两处所选 operations 漏传、任意 Error.message 转换、真实 Agent.outputKinds 夹具和 Windows 原路径 oracle，独立复核 PASS。随后原 canonical 首次生成在任何清单写入前发现 Buffer 与 extends:Omit 两项 opaque 不匹配，17 份元数据保持；中间 inline import 类型的 lint FAIL 同样保留。原规则和 opaque 名单不改。

独立 DESIGN-R3 与 SOURCE8 PASS 后，readInsideRoot/existsInsideRoot 两项完整 native 函数移到 platform/content/local/rootFileQueries.ts，旧 service 继续准确转出口并保留 Buffer|null API；中立 public 只保留 reader、DTO 和纯 helper。NativeReadPortArtifactOptions 显式保留原八字段。原函数 AST、所有旧断言/名称/预算及其它控制文件保持。SOURCE37 最终组合指纹为 658707166cb805a6f25d1fc5ddafdad689cf56e3c9f90459c7befb44f8a1b1dd；这是有限源码组合，不是完整 A-G。

归档与读取由 TE application/domain/composition 拥有，完整 11 方法 content factory 与 operations/reader 只在 undefined 时选 native 默认，保留 frozen/prototype/private receiver；constructor 零 IO。同步 native 兼容和异步路径共用一套 policy；2MiB、8192 字节 NUL 样本、truncation notice、archive v1/meta/only、legacy 与原覆盖行为保持。writer ACK 后才推进 runner 的 maps/outputs/roster/数据库写入，任意拒绝原因保留原诊断与回退。所有五处 runNode 消费点、ordinary/repair review 和 SQLite initial/replacement、PG、独立 HTTP 根共享所选实例；原 mutation lock 与原数据库 AST 不变。

R2 原生成器基于已提交 335cc5333ae3883bd8f9b457c3253add552809d9、冻结 37 个 owned 源码及四份 exact committed 原规则执行一次；非 owned 源码均来自该提交，三个并行观测源码 WIP 与一个新观测测试被保留并排除。实际 sourceDigest 为 sha256:8374c61a4f7114855af3604e243c664db5827232894f00bdfb6800e1ee913323。新增 6 个生产文件（5 TE、1 platform），只按实际五项投影增长登记：mutation 1852→1857、observed imports 5944→5983、exception projection 5289→5323、public surfaces 1075→1101、owners 26376→26410；匹配 canonical 发布后的后继提交再正常退役回执。原 129 项有序手写库存/why 保持，不新增库存或债务条款。原规则仅销账 service portArtifacts→private taskArtifactPathQueries 的一条消失 type R1，其余 302 条记录全文保持；40 required SPI、69 target edges、空 implementation SCC 保持。原 guard 仅随 owned canonical 测试总行数 893→894 更新，业务写点与 transaction/effect 记录仅实际 id/line 投影。

前次 prompt 夹具提交 eef2874b53a073dd19faac654d890a41397a6d88 的 exact 主 CI37151693012 已 completed/cancelled（4 success、1 aggregate failure、42 cancelled），不记为通过。包含修复的后继 57f6c29303a17a2a6b28db5966da1f9bc69b1548 主 CI37151884308 completed/failure（37 success、12 failure、1 cancelled）；其 Ubuntu6 job111287352004 内本批 15 个 prompt binding 用例全 PASS。其余原生观测/W5/R1/超时失败按完整日志归属交由并行 owner 接续，整套 CI 未通过。当前归档批次尚待发布后的 exact-SHA hosted CI；本机无 AW test/typecheck/build/service，只有限 format/lint 和纯 AST/JSON/字节/census 证明。

完整 RFC-370/A1–A8/AC00/A-G 仍开放。A2 runtime 物化、A3 workspace/upload/restore、A4 node/wrapper Git/commit/delivery/conflict/repair、A5 logical materials 与 submit/inspect/events/message/cancel/收据先于激活/reap、A6 purpose commands、A7 authority/recovery 和 A8 全根装配继续；随后独立 CS adapters，先 B/M0 实际部署，再 M1–M4 逐步收编。当前没有 AW-in-CS 部署或验收，不能用有限 PASS 关闭阶段 A 或 RFC。

## 2026-10-04 工作区上传切面交付

SOURCE24 独立功能门有限 PASS，指纹 `daca3967932cf720464fa9c03cae806ecab160dedac0a7e51db777b9048a98a2`；24 owned、14 controls、11 evidence 首末稳定。SC complete factory/六方法 receiver 只解释 workspace/content 引用，TE 保留一份原上传政策；native 同步效果不产生额外 await，旧 helper 不创建目录，旧可变 Map/数组与结果对象身份保持。真实 journal、Task 启动内核和 standalone HTTP multipart 双 provider 回归已写。

原七项业务声明、四项物理 helper 的完整 AST、digest/SQL callback/receipt replay、四个根的原内容、12 个旧 service 出口及 13 份旧源码/测试控制保持。原完整 whole-writer 测试 hook 保留；与显式 selected factory 同时选择时在原 receipt 重放之后明确报错。reserved placement ACK 先于写入，write ACK 先于 written/Task admission，异步回滚有序且首错保持；实际写入后丢 ACK 的重试沿已登记文件名完整字节复核。

一次原 scoped census 基于已提交 `766138c5e371e4b6724458014cd8306878d086dd` 加冻结 SOURCE24；非 owned source/test 使用 exact committed 内容，并行 native page/pump 及前台 WIP 保留、排除。四份原规则不变；sourceDigest `sha256:6c9bcf68d1870290bc9b090ab9e55acfe743ee9ca39efda4a5576c6992fc5b1d`。实际五项增长为 mutation1857→1862（六增一减）、observed imports5983→6015（36增4减）、exception projection5323→5347（28增4减）、public1100→1116（16实际已消费出口）、owners26419→26449（九新生产文件46增、旧service16减）。按原协议登记五项一次回执，匹配 canonical 提交后正常后继退役；129项原有序库存/why、302项原债务全文、40 required SPI、69 target edges 和空 implementation SCC 保持。两项 Task 写点仅 id/line 投影856→859、941→944；14项 ambient root 记录只移行，业务正文保持。原 C2 双向精确相等证明通过。

前次 CI 修复 SHA `de5f90ae80ffdcc4af83fe0a1d39dd01937667a9` 的四个受影响后端 job111317745474/111317745496/111317745535/111317745537、主 Lint/Typecheck/Format job111317745523 和 Windows37162413399 全部 completed/success，满足 SOURCE37 有限正式验证依赖。主 CI37162165195 则 completed/failure（43成功/7失败）；六个浏览器作业及 aggregate 原失败保持。观测失败由并行 owner 接续；macOS四个其它 flaky case 的 daemon-ready timeout 原日志保留，不用后续 retry pass 改记成功。本上传批次仍待新 exact-SHA hosted CI。

本机仅目标 format/lint、纯 AST/字节/JSON 和原 scoped 生成，无 AW test/typecheck/build/service。目标 lint 首轮缺少 HTTP effectiveDeps factory handoff 与 prefer-const 两处 FAIL、首次 AST 根逆变换的分隔 token 误判均保留，源码和证明工具分别修正后有限 PASS；未改变原政策或放宽原回归。完整 A1–A8/AC00/A-G 继续，独立 CS adapters 仍在完整 A-G 后，B/M0先实际部署再逐项M1–M4。尚无 AW-in-CS 部署，不关闭 RFC。

## 2026-10-04 上传测试类型补正

工作区上传 source24 `e3a3f82ab9fd5559d0efba6f9cd1d0a505857865`、canonical18 `65612a232c6c62b3197905c3242fb2040c0d7d6e` 和匹配五项增长回执退役 `2c474db9a50f98b6d16614e81122b38bdfc9228b` 已正常发布。42 个独立路径，post-fetch main/origin 精确 0/0、index empty；其它会话 20 个 WIP 路径保留且未 stage/commit，窗口已交回。SOURCE24、META18 与 META-RETIRE1 均为有限 PASS，不关闭完整 RFC。

2c474 主 CI37168434612 的 Typecheck job111336216504 已 completed/failure，完整原日志保留在 `/tmp/aw-rfc370-workspace-upload-content-ci-lint-job-111336216504.log`。唯一实际 TS2739 是新增 `rfc370-workspace-upload-bindings.test.ts:266` 将 ReadonlyMap 赋给真实 launch uploads.definitions 的 mutable Map。首次采样时 workflow 为 queued，并非终态；该采样的 real PostgreSQL、Ubuntu2/3/13 和 macOS2 四个 backend 分片 success 只作已完成作业事实，不代表主 CI 全绿。其余作业及 Windows 的正式终态由后续回执记录，旧失败不改写。

本次只把该测试的 `definitions: plan().defs` 改为 `definitions: new Map(plan().defs)`，沿同一 defs iterable 创建 mutable Map，键值及次序保持；原 plan() 每次调用本来也新建 Map。逆变换一个表达式逐字恢复已提交完整测试，所有原断言、名称、预算及其它文本保持，未改任何生产实现或旧 API。SOURCE1 独立有限 PASS 指纹 `05892b6e79c480d03e07a954bc7a8d47481a65b16199ae9dff40f9de8b9a6b6b`；1 owned、10 controls、5 evidence 首末稳定。

原 canonical 只扫描三个 package 的 src，加 `.dependency-cruiser.cjs`／`scripts/depcheck.ts` 两输入；本测试不在该语料。故不重跑已成功 census、不改 sourceDigest／数量／库存／规则或增长回执。目标 format/lint 及纯 byte 逆变换通过，无本机 AW test/typecheck/build/service；修复的正式验证仍等新 exact-SHA hosted CI。

完整 A1～A8／AC00／A-G、各层独立 CS adapters 与 B/M0～M4 继续。隔离 workspace 设计正在有限修订，原失败历史保留；源码未实施。尚无 AW-in-CS 实际部署，不关闭 RFC。并行观测 WIP、旧文档与所有 gate/CI 历史保持。

## 2026-10-04 上传切面架构 CI 预言补正

2c474 主 CI37168434612 的正式终态为 completed/failure：35 success、14 failure、1 cancelled，共50 jobs；Windows37168434657 completed/failure，maintenance37168434632 completed/success。所有原日志与失败/取消历史保留。纯类型修复 a7522bbe232d4e8d5cbfbf6df2d25b9515962b12 已发布，5路径、post-fetch 0/0、index empty；其正式 CI 尚待，不把后继改记成旧 run 通过。

本次补正实际上传 SOURCE24 的三个遗漏预言。C2原精确薄 facade 名单新增已经迁出的 services/upload.ts，W7原四写点的 TaskRouteLaunchOperations 地址856→859，三列与原Task SQL全文保持。W29严格原normalizer得 PG声明171→172、SQLite application51→52、HTTP mounts65→65；只更新原计数及三个实际摘要，八phase、所有原scanner/normalizer函数、断言机制、名称和预算不变。完整测试只六项精确编辑，逆向逐字恢复旧三文件。

唯一guard元数据为C2行数894→895，原provenance函数更新contentDigest与本次基准a7522bbe。guard所有其它行/字段、原sourceDigest sha256:6c9bcf68d1870290bc9b090ab9e55acfe743ee9ca39efda4a5576c6992fc5b1d、inventory/ledger/required SPI/债务保持；不重新执行已经成功的生产census。SOURCE3-META1独立有限PASS，指纹 e4a880afa6278c1e1bc73fe9b0998613969485d245f7845dfa02891432584bfe，4 owned/8 controls/12 evidence 首末稳定。纯字节/AST/JSON和目标format/lint通过，无本机AW test/typecheck/build/service。证明工具R1/R2均在任何repo写入前失败，历史保留。

原PG185三成员用例另有两个startup账本失败；原PostgreSQL容器完整日志显示同时间段49次SSI序列化冲突，未把它误记为上传TS或架构预言失败。现有十次满抖动事务重试已核，工作组只读snapshot选择修复另立有限设计复核，生产尚未修改，其效果仍等新确切SHA证据。原三成员并发、brief隔离、独立run/result和聚合断言不放宽。

隔离workspace DESIGN-R3独立有限PASS 2266f5474fd5f53d2f214e548b91e11ac20f45926f2e74bdcefafa6009ab11eb；R1/R2失败与全文保持，A4源码尚未实施。完整A1–A8/AC00/A-G、各层独立CS adapters、B/M0实际部署及M1–M4继续，尚无AW-in-CS部署，不关闭RFC。并行观测源码保留且不纳入本次投影。

## R2：上传 CI 序列化错误计数说明

META4首轮 5453d2fd946e26f1e0339e646df40de1d98468ab428617672543bae2a838c4a5 的数量文案P2/FAIL保留。上一记录的49属于宽字符串 `could not serialize access`：精确SSI `read/write dependencies among transactions` 为41行（原log4167至4331），另8行为 `concurrent update`（4114/4116/4118/4120/4122/4124/4126/4128），不是49条同一种错误，也不是重复诊断。源码、guard与原SOURCE3-META1 PASS不重开。

这些原服务端记录只证明工作组该时段存在两类序列化冲突，末两UPDATE没有参数且时间晚于首个失败输出，不能唯一映射B/C最终失败。原failed member与全测试诊断仍保留，不将读取snapshot修复当作已经解决全部写问题。a752五路径发布回执和旧WindowsFAIL/maintenancePASS已独立确认；正式新CI、完整A-G/RFC及部署仍开放。原四文档全部全文和首轮失败文字保持，只以此段限定数量与证据范围。

### 2026-10-04 RFC-370：只读快照与隔离原生所有权拆分

Resource Catalog 的 Workgroup load 改为既有 DatabaseSession.snapshotRead：PG 使用 REPEATABLE READ READ ONLY，SQLite 与嵌套事务仍走原实现；commit、SQL/CAS、原十次 SERIALIZABLE 写入重试和 full jitter 保持。新六用例使用 branded PG 协议夹具核真实生产调用、同一 transaction、held completion ACK、嵌套 frame 和原拒绝；不把此夹具当作本机真实 PG。SOURCE2 首轮 Bun matcher 泛型 P2/FAIL 保留，只补 expect<unknown> 后 R2 有限 PASS 96d12b4cb1e9d070488dfbe4658a36efcaa323e67c8188d8e329138a704f538c。

隔离工作区本批只完成 native 所有权拆分：37 份完整声明及错误 identity 保留，原 Git/worktree/submodule/ref 机制迁入 platform/workspace/local/isolation；discard 的原 Task observer shell 归 TE infrastructure，pure repoRelForcedPaths 归 SC domain，旧 service 准确转导。原请求/hash/真实行 id、beforeAct 在 try 外、物理 loop、同步 partialFailures 和 settle ACK 保持。SOURCE13 首轮重复 passthrough 检查 P2/FAIL 保留；删除 raw helper 的重复 guard，并新增真实 Git 一次 getter 的回归。R2 有限 PASS 4c496e4c1e00b681190379bbf955dd498b10c43419d706594efc93d3e65c3bc3，其余十一 owned 字节保持。旧四项源码 oracle 只跟随真实 owner；全部原名称/预算/断言保持，C2 按实际薄 facade 增加 nodeIsolation。完整 14-method selected scope 及实际消费者接线仍在下一批，六个新 scope/helper/fixture WIP 不纳入本次发布。

原官方 census 在已提交 2f7c3b672dd8007849348bffe05a95fef7703457 加这十五个冻结 source/test 上只成功执行一次；非 owned tracked 源码与四条原规则读取该提交 blobs，非 owned untracked 排除，全部并行 WIP 保留。sourceDigest sha256:66842743a7d98d3224d4858c5bf0772f5cc0480a2bc5b8498f525a21f01aa607。129 项原库存按原计数函数一致；导入 6015→6023、分类记录 5347→5354、公共符号 1116→1118、符号归属 26457→26461，四项实际增长登记并在 matching canonical 的正常后继退役。按并行 owner 明确交接，2f7 已消费的 RFC-371 owner 26449→26457 一次许可在本次清单中退役，旧 why/回执与已提交完整内容保持在原历史及生成前快照；不把旧许可复用为新四项许可。

mutation 总数 1862 保持，仅两项原 native owner/file 和原 classifier 得到的 targetLayer application→workspace 迁位；原 payload 逆投影后完整一致。原 effect ledger 只有 cleanup owner/file/line/id 迁位并按原排序生成，整份逆投影恢复。两项新增 public 各有两个实际生产消费者，无新零消费者债；原 302 debt 条款/why/退役条件、40 required SPI、69 target edges、空 implementation SCC 与全部原规则保持。C2 guard 895→896、nodeIsolation 薄 facade 和其真实 consumer 投影按源码更新。首私有 metadata proof 遗漏真实 targetLayer 投影的 incomplete 保留，R2 仅补该投影证明，没有重复 census 或改写任何 canonical 判据。

旧上传 SHA 2c474db9 的主 CI37168434612 completed/failure（35 success/14 failure/1 cancelled），Windows37168434657 failure、maintenance37168434632 success；类型补正 a7522bbe 主 CI37170055509 cancelled（37 success/11 failure/2 cancelled），精确手动 Windows37170515895 success 1/1。架构 oracle 补正 b6195a0c 主 CI37171176047 已 completed/failure（43 success/7 failure），后端全部分片及类型/lint 通过，六项页面 E2E 与 required 失败。Ubuntu1 job111344566543 和 Windows3 job111345229706 的原日志核到 RFC-371 观测页面/下钻/捕获断言；其余四份页面日志未逐字核对，不宣称旧整套 CI 通过。并行 owner 已提交其 2f7 修复；本批新源码和原 Git 回归仍交本次发布的 exact-SHA hosted CI。

本机只做 owned format/lint、纯 AST/byte/JSON/原库存投影与一次原 scoped 生成，没有 AW 本机 tests/typecheck/build/service。新行为尚待托管 CI；完整 A1–A8/AC00/A-G 持续，随后各层独立 CS adapters，B/M0 先实际部署再 M1–M4。当前仍无 AW-in-CS 部署，不关闭 RFC。全部旧文档、并行输出、失败与取消历史完整保留。

### 2026-10-04 RFC-370：完整隔离 scope 接线与两项 CI 修复

本批中性 A4 已接入完整 14-method isolation scope 与 node/wrapper/recovery/cleanup 和真实 roots；旧 Task policy 迁 TE，旧 service 薄转导。SOURCE31、W29 三字面值、Workgroup 完整 ACK/重入队列与 Generation lazy 配置提前/关闭修复的四项有限独立 SOURCE 均 PASS；原函数、持久/effect 语义、测试预算和断言保持。两项 CI 修复的新回归仍交 hosted CI；旧 d005 主 CI37177891308 的 42 success/8 failure 保留，不记作已通过。

官方 census 仅在已提交 d3ba4340 与冻结39路径上生成一次，排除且保留并行 WIP；sourceDigest sha256:21807212cede9256bc81ed445607a1f6aa12f4c47896e3847e94e2fbbc2e70fb。129 原库存/why、40 SPI、69 target edges、空 SCC 与原规则保持；五项实际增长随 matching canonical 消费并由正常后继退役。19 新 public 都有生产消费者，两项旧导入债退役 302→300；Task effect 9/0 与 68 code-host bindings 语义保持。详情见 [functional-gates](functional-gates.md)。

只做自有 format/lint、纯 AST/byte/JSON 和一次 scoped 生成，无 AW 本机 tests/typecheck/build/service。剩余 A1～A4、A5～A8/AC00 与完整独立 A-G 继续；随后各层独立 CS adapters、B/M0 先实际部署、再 M1～M4。本任务 M0 首次部署尚未完成，RFC 持续；原正文、旧 gate/CI 历史与全部并行输出保留。

### 2026-10-04 RFC-370：提交／发布 Git 完整物理 scope 的有限接线

完整 RepositoryGitWorkspaceFactory/scope 在 SC 的 application/composition/local adapter 各层落位。Task 提交与递归子仓的本地命令、discovery、临时 preview index，以及 scheduler 两条终态 status 使用同一选定 factory；原一次 network transport/session、receipt 和最终 close 保留。33 个旧直接 Git 地址只属本批有限库存，Task HTTP diff/repair、其他 delivery/conflict/员工验证等 A4 余项未记完成。

首 SOURCE22-DOC1 的三项 P2/FAIL 全文保留；R2 修复 preview 捕获原 options、native query/update 热读 hook 与两处重复装配字段，独立有限 PASS，指纹9026b1c971ffb25ae8b521c4e45845af985ffa53a220eb8e2e4de9382ee2447a。第一次原 canonical 在 private output 中发现一个无消费者的新增 public helper，之后只删除其 public re-export，完整内部实现和真实调用者不变；增量 SOURCE1 有限 PASS，指纹d74eb46f2b94e4aba78d7142d6bb4d4d2c95c05052c123bfd8433a61b508ada9。旧生成完整保留，新内容候选只生成一次，不因移动 HEAD 重开源门或生成。

最终 scoped canonical 基准4fe2fcaeed44426cc0a969f1a8751728f94a7b43，四原规则不改，所有非本批源码从该 commit 读取并排除保留并行观测/native owner在制品。sourceDigest sha256:b24f35e5ddd5b479b6f1a6aa1c44791b1d0f388c2949f99e2e6482357b71c376；129 原有序库存及完整 why 保留。五项真实增长：mutation1866→1867、observed6074→6095、exact compatibility exceptions5388→5406、public1137→1146、owner26516→26529；各自具名登记，匹配发布后以普通后继退役。此前321/1→322/2的两个测试计数许可已在4fe2提交消费，本批只正常退役许可，计数和实际 synthetic PG open debt 保留。原40 required SPI、69 target edges、空 implementation SCC、完整300债务和C2原精确等式保持；Task effect仅runCommitPush地址187→198投影，原九条语义保留。

准备脚本首轮传 provenance helper 的参数形状不符实际签名，原证据保留；R2 按其原对象签名恢复 origin/currentSnapshot，不改完整 payload、五项增长、原 why 或规则，不重跑已完成生成。最终 JSON／字节／原计数证明与有限 metadata gate 单独记录。仅做目标 format/lint 和纯静态证明，无本机 AW tests/typecheck/build/service。

旧04a的正式主CI37187048069为completed/cancelled，34 success、14 failure、2 cancelled，Windows37187051255为success；两项test ledger失败已发布4fe2修正，另一个Windows前端wizard断言仍未归属，原失败不改为绿。原E2E入口加载问题由并行06c4修复；4fe2及本批新SHA正式CI分别继续。完整A1～A8/AC00/A-G、各层独立CS adapters、B/M0首先实际部署与M1～M4逐步收编继续，尚无AW-in-CS部署，不关闭RFC。

### 2026-10-04 Task diff／review repair 完整读取切面的有限交付

SOURCE15-DOC1 R2 有限独立 PASS `6810ac1409c1b961a61f019a55050c7f3da0d17b60b1ef503b699ec0dd322c52`；首门两项P2只在新增夹具，Response/Promise和frozen Proxy问题已经补正，其余14TS和原策略/W29规则字节保持。实际SC五方法完整query与独立native实现贯穿Task diff/repair、双provider及CLI/PG/classic HTTP根。新增真实Git/双provider回归保留ACK、opaque/frozen receiver、409/410、多仓顺序/readonly/空与字符串预算、最新wrapper代际和真实review/docVersion/audit；原断言与预算不放宽。

原四条规则一次scoped canonical只读已提交`b905434e23f8dd670cccc6000ff8fe887a9c2805`加本批冻结16路径，6382个非自有TS取完整committed blob，排除观测的一个tracked及四个untracked TS在制文件；13份输出先生成于私有文件。sourceDigest `sha256:3df159a4dc1ad7036b65be8092f4a904a3d26ca6e9dbbbad1a0f829e0445b66a`。原完整JSON validator已通过。实际entry+1、import+11（17新增/6退役）、exception+5（11新增/6退役）、public+2、owner+6；129行顺序/原why、40 SPI/69 target/空SCC、原debt及effects不改。五项实际增长按原协议登记，匹配提交后另行退役。

Git类型修复`b905434e23f8dd670cccc6000ff8fe887a9c2805`的Windows37193750893正式completed/success；主CI37193533285尚未全套终态，Ubuntu前端3/3的111410608298已确定失败，`rfc371-run-observability.test.tsx:1120`返回弹窗来源Task预期task-1但得到null；日志保留，不改原断言或以Windows替代主CI。更早5490的主CI取消与Windows失败保留。当前批次正式测试仍等待发布后新exact-SHA hosted CI。

仅目标format/lint、纯源码/JSON和一次原scoped生成，无本机AW tests/typecheck/build/service。不关闭完整A4或A1～A8/AC00/A-G；delivery/conflict、DA/DE校验及执行/脚本/执行权恢复继续。其后各owner独立CS adapter，B/M0先实际部署，再逐项M1～M4。当前尚无AW-in-CS部署，不关闭RFC。

## 2026-10-04 Task workspace reader CI 修复投影

Task reader CI 修复 SOURCE5-DOC1 独立有限 PASS，指纹 `899180ddebb19b9b0186f1297b0b701b33137095566793bb2453ff4ae8b8b5a1`。两个原纯地址函数和注释逐字迁到同 owner 的 isolationReferences，native 原名出口与函数身份保持；reader 仅改叶子引用，从实际 no-circular 链拆出完整隔离模块。新增测试只给 JSON 响应补真实返回合同的擦除型类型断言，完整旧测试可逆向逐字恢复，全部原内容断言及预算保持。new leaf/native/legacy 与真实默认查询的引用回归已写。

原 scoped canonical 只运行一次，固定 ae7654de 加五个 TS 候选，其余6394个 nonowned 源码全部按已提交 blob读取；排除并完整保留并行观测17 tracked / 4 untracked TS。sourceDigest `sha256:0b89825f380acb270867144f623daf295a41a725abec08e6979ddd60bdc1e1ed`。原两符号的边改指纯叶子，imports6106、exceptions5411数量不变；localIsolationWorkspace 旧 isoKeyOf import未改，原扫描器因native现在re-export将其 target owner投影为完整文件owner，只有该owner字段变化。原required40 SPI / 69 targets、空implementation SCC、public面、全部债与effects、Task authority及504 ambient保持。新leaf一个fileowner及两个迁位函数，3 added / 2 retired净增1，原owners26535→26536。只登记这一实际增长许可，匹配canonical发布后正常退役，原129 ordered rows / why保持；不改任何rule、allowlist、周期或预算。

9c614ec7 主CI37196589476正式cancelled 11 success / 2 failure / 37 cancelled、Windows37196589510正式failure1/1，原完整日志保留。ae7654de Windows37196996310已正式failure1/1，主CI37196879491的depcheck也已失败；本段是生成前冻结的作业事实，不是主CI整体终态。修复的新确切SHA正式CI仍待发布验收，旧失败不改写。仅精确format/lint、纯byte/AST/JSON和一次原官方静态生成，无AW本机tests/typecheck/build/service。

Conflict DESIGN-R2另已独立PASS，只是设计、尚未实现。完整A1～A8/AC00/A-G继续，之后各层独立CS adapters，B/M0先实际部署再逐项M1～M4；尚无AW-in-CS部署，不关闭RFC。全部旧正文、并行输出与gate/CI历史保持。

### 2026-10-04 冲突／action workspace 有限交付候选

SC 完整七项 ConflictMergeWorkspaceEffects 与 DA 六项 ActionWorkspaceEffects／完整 contents 按原各层 owner 接线；三根九组 conflict 绑定与普通／冲突创建 owner 的持久恢复回收均等待 ACK。SOURCE30 五项 P2/FAIL 保留，SOURCE32-R2 有限 PASS `b8564115bf0e735d9582022fd878ed6fccf4e2d1c9df2271786dfb1264f6657f`。新增真实 Git 与双 provider Mission／DE Case／HTTP 入口回归已写，原断言与预算保持；本机只有目标 format/lint 与纯源码／JSON证明。

匹配清单从已提交 `43808355` 和同一冻结31TS投影一次，sourceDigest `sha256:4d8762a0c70953202b0baf6db646da740c7064a36448d05b79cf0a541adf44ce`；完整并行观测修复包含在基线，下一批和其它在制品排除且保留。13 canonical／129原库存的五项真实增长随匹配发布消费，再普通退役；有限 metadata 门和新 exact-SHA hosted CI 独立留证。Candidate 发布 DESIGN-R2 已通过，补六组 factory 根装配、selected baseline 回读及关闭后持久结算作为下一批推进。

完整 A1～A8／AC00／A-G 继续；其后各层独立 CS adapters，B／M0 先实际部署，再 M1～M4 逐步收编。本批不改变上述验收顺序，不记 M0 或 RFC 完成。

### 2026-10-05 Candidate publication 接线与工作区 CI 修复

Candidate publication SOURCE24 独立有限 PASS `ce7e37678052bedc69d28f5c234c375f701d03f1b798f74ba5a850cd94d4668c`；CI-SOURCE6 首门逐根 receiver 断言 P2/FAIL 保留，R2 仅补精确 CLI／HTTP receiver 与 runtimeDeps→effectiveDeps／fallback／mount 传递链，有限 PASS `865163cdaab7bb0741cf3b63081e4baa199428bfcfaa20c448b387ac619f9e56`。两个不重叠候选共28 TS／2说明，保持原同步 native 实现、真实 Git／双 provider／HTTP／Task node/effect 回归和旧断言／预算。六组真实 factory 根、选定 baseline 回读与四处 publication close ACK 已接线；Task 的原九种结算结果只在 close ACK 后按原次序持久化。native fixture 物理机制归 SC local adapter。工作区选择不再改变独立 native evidence namespace，opaque 证据夹具提交其实际 file writer；DE fixture 使用实际 issue 类型。

原四条规则在完整已提交 `bba36c8960d81718987b26c100d25ff767fa3f14` 加上述冻结候选上仅投影一次，6388个非自有源码取该 commit blobs；并行 native owner／schema 在制品排除且保留。sourceDigest `sha256:d9a6f5eed05880c413b06a84d4cfd32bdb08f5ebf11cf1bbd3aaabf5301982e5`。13产物和129行原顺序／why保持；四项实际增长 import6117→6120、exception5420→5423、public1149→1150、owner26563→26564 按原协议具名登记，匹配提交后正常后继退役。原40 SPI／69 targets／空SCC、300债务、Task authority／effects和504 ambient数量保持。完整原JSON validator通过，有限metadata／精确提交／远端CI各自另留证。

旧148436的主CI37212411283 cancelled（34成功／13失败／3取消），Windows37213640174 cancelled；bba36c896 的 Windows37213907338 success，主CI37213782196 failure（41成功／9失败），原完整作业／日志保持，不改为整套通过。本机仅目标format／lint、纯AST／byte／JSON与上述一次原静态生成，没有AW本机tests／typecheck／build／service。完整阶段A／AC00／A-G仍开放，执行／runtime、脚本与执行权恢复继续；随后各层独立CS adapters，B／M0首先实际部署，再逐项M1～M4。尚无AW-in-CS部署，不关闭RFC。

### 2026-10-05 H4/H5 本机进程机制归位

H4/H5 设计 R3、NATIVE-PROCESS12-R2 与 WINDOWS-COVERAGE1 已分别独立有限 PASS；原 FAIL 回执保持。三份 native 机制完整原体归位 platform/execution/local，旧 API、direct launcher CLI 和 compiled embed 保留；真实双入口 frame/EOF 回归及原四 oracle 保持，Windows push/PR 与实际 suite 同步覆盖。详情见 design/RFC-370-crewstation-hosted-deployment/native-process-mechanisms.md。

原四规则在完整 committed 8f294c0c 加冻结 12 TS 上执行一次，13 份产物通过原完整 JSON validator；sourceDigest sha256:3a1df07ad4bbedc70aba97cbda8b2ebe0e2e14068c12ff328c85b1f78fbe05d3。并行 69d03cb9 只退役其已消费许可，六个源码语料 tree 完全相同，复用生成而保留该退役。实际 owner +3（26565→26568），其余库存数量与完整 why、原 SPI/target/SCC 保持；本批匹配许可正常后继退役。

没有运行本机 AW test/typecheck/build/service；scoped format/lint 与纯字节/AST/JSON 证明不代替新 exact-SHA hosted CI。仍在阶段 A，三个 Agent 的中立材料/执行/取证、脚本、执行权/恢复与完整装配继续；A-G 后才开始各 owner 的 CS adapter，M0 首次部署后逐项 M1～M4，当前没有 AW-in-CS 部署。

## 2026-10-07 RFC-370 Purpose 九操作与配套清单候选

SOURCE62-R5 独立有限功能 PASS；三组完整目的效果、logical staging 和三根内容配对已接线，原策略／native全文／旧断言与预算保持。原一次 scoped 生成固定 fca334493d 加44生产／15测试，sourceDigest sha256:4499dff7c066845b11d7f348dcb29ed397d0d6e961f00a2fd93c24069a3d8f1a；classic R1 43→42、R2 0→0，仅支付实际旧 type edge，356条剩余债原文保留。13原配套产物、129库存／why、SPI／target／guard／SCC保持；五项实测增长按原协议随匹配发布消费，普通后继退役。源码相关服务完整提交含并行 MR export，未剥离任何共享正文。

配套有限门、exact-path commit／远端同步及新 exact-SHA hosted CI继续分别验收。仅本批format／lint、纯AST／byte／JSON及不同最终候选的一次原静态生成，无本机AW tests／typecheck／build／service。H7 D2设计门已有限PASS，完整执行权／恢复／A-T7／A-G尚未完成；之后各层独立CS adapters，M0先实际部署、M1～M4逐项接管。当前没有AW-in-CS部署，不关闭RFC。详情见 design/RFC-370-crewstation-hosted-deployment/purpose-canonical-publication.md。

## 2026-10-07 Purpose 已发布与一次许可退役候选

完整78个相关文件已提交推送 3afffac07455e86118390432359676707f2063c8；发布后main／origin 0/0、index为空，未提交H7在制源码，全部共享MR export及STATE／plan正文保持。SOURCE62-R5与MATCHING16-R5均独立有限PASS。新精确SHA主CI37550317708、Windows37550317792已注册，另有maintenance-soak37550317684；冻结此段时前两项queued、soak in_progress，未宣称正式CI通过。

本次普通后继只退役该提交已消费的五条one-commit增长说明；原129行baseline／顺序／why和其它字段逐字对应完整原JSON，按原payload算法重算ledger digest。原13项source projection、R1 43→42／R2 0→0、356条完整旧债、所有SPI／target／guard／SCC及Task库存不改，不重新census。不改原SOURCE或旧失败，不联系其它会话。退役有限复核、发布及后继exact-SHA hosted CI另验。完整H7／A-T7／A-G和独立CS adapters／M0～M4继续，当前AW尚未部署到CS，RFC未完成。

## 2026-10-07 RFC-370 Purpose Windows 平台选项与匹配清单候选

3afffac0 的 Windows37550317792 已 failure：同一 native 平台选项在较长 cwd 表达式后超出原匹配窗口。SOURCE2-R1 有效稳定 PASS，仅移动纯 spread，完整原规则/断言/预算保持，原 pattern 1→0。一次原 scoped 生成固定 a7c221e6 加该一个生产文件，排除 H7 WIP；13 原产物 sourceDigest sha256:c9cffe87aa91c7f178bdb0b6cc6e4ed63dfbcf0ad447e8859e6cbb280909d4e6，classic inbound/outbound 0→0。

匹配清单如实补已提交 caea61fe 的四条观测 frontend owner，旧 27325 条全文/顺序与129 ledger/why 保持，owner 27325→27329 的一条原协议声明随匹配提交消费后正常退役。不改并行源码；源码/配套有限门、远端同步和新精确 SHA CI 分别验收。无本机 AW tests/typecheck/build/service，H7/R2、所有根/事务/后台执行与 A-T7/A-G 继续，尚无 AW-in-CS 部署，RFC 未完成。详情见 design/RFC-370-crewstation-hosted-deployment/purpose-platform-canonical-publication.md。

## 2026-10-07 Purpose Windows 修正已发布与一次许可退役候选

完整18个相关文件已提交推送 e56198b39737cf83a2c158a13abb60af539e09b3；发布后 main/origin 0/0、index 为空、H7 在制7路径逐字保留。SOURCE2-R1 与 MATCHING16-R1 均有效稳定有限 PASS，原 Windows 失败、前次主 CI 失败及准备错误完整保留。新精确 SHA 主 CI37554447584 已注册；首次登记 queued，未据此记 CI 通过。

本普通后继只退役该提交已经消费的一个 owner 增长声明。全部129行原 baseline/顺序/why/字段与其它 provenance 保持，只按原 payload 算法重算 ledger digest；另三份完整文档仅追加此段。原13投影、27329完整 owner 行与原规则均不再生成或改动，原 native 修正保持。无本机 AW tests/typecheck/build/service，也无新 census。

H7 核心 SOURCE7-R2 有效稳定有限 PASS；三根、Task 事务、19 handles/named admission 与 Task 热配置入口仍须接线，完整 A-T7/A-G 未通过。之后按已批准顺序编写各层独立 CS adapter，先 M0 实际部署，再逐项 M1-M4。当前 AW 尚未部署到 CS，RFC 未完成。

## 2026-10-07 RFC-370 H7 执行权核心有限匹配候选

SOURCE7-R2 有效稳定有限 PASS，原 R1 两项功能失败保留；中立生命周期、借用原 startup lease 的 local factory 和两套回归准备独立发布，实际三个根尚未接线。一次原生成固定 c3857ea5 加3生产/2测试，13输出 sourceDigest sha256:ad9811a0e14eaef3082f488bcd0049568ac1ee62cb445373f7cd022b3bc1e8b9，classic inbound/outbound 0→0；所有旧完整行/129 ledger why与其它opaque字段保持，三项实测 one-commit 计数匹配消费后正常退役。

匹配有限门、exact-path上库/同步、新exact-SHA hosted CI另验。无本机AW tests/typecheck/build/service，三个根/Task事务/19 handles/named admission与Task热配置继续；H7/A-T7/A-G未完成，随后各层独立CS adapters、M0先部署、M1–M4逐项接管，当前AW尚未部署到CS，RFC未完成。详情见 design/RFC-370-crewstation-hosted-deployment/host-execution-authority-core-canonical-publication.md。

## 2026-10-07 RFC-370 H7 核心已发布与三项一次声明退役

执行权核心及完整匹配23路径已推送89cbbe8dc4dd0a3d8fe0287440507a0bbb58369e，main/origin同步0/0、index空，所有并行在制品完整保留。SOURCE7-R2和MATCHING16-R2有效稳定有限PASS；主CI37556821337首次登记queued，正式精确SHA CI终态另验。

本普通后继只退役该提交已消费的三个one-commit声明；完整129行baseline、顺序、why及其它字段保持，使用原payload算法刷新digest。原清单和全部源码不再生成或改动。三个共享文档的旧全文逐字保留，仅追加本段。没有新的census或本机AW执行检查。

实际三个根、Task事务、named admission、19 handles与Task配置接线继续，尚未完成H7/A-T7/A-G，尚无AW在CS部署；随后按各层独立adapter先完成M0部署，再逐步M1–M4。RFC保持In Progress。

## 2026-10-07 RFC-370 Purpose CI 类型修复配套候选

原 c3857ea5 Windows37555994724正式 failure于Typecheck；之前的平台测试已success，后续构建与doctor skipped。恢复 pipeline 的原 lazy evidence receiver与所选 materialization ACK；两个既有回归仅类型修正，旧断言/顺序/预算/native回归保持，新增真实 pipeline ACK 回归。原 SOURCE5-R1误报PASS和补充FAIL完整保留且不用于发布，fixture可变数组补正后的 SOURCE5-R2有效稳定PASS，26项/FP 5f5fbd4cc624c86b9b059a03021f0a1d1b9598f4e6301391a72f3ad6042c713c。

一次原静态生成 fixed79d31c96加1生产/3测试，sourceDigest sha256:678e9adf510a0e9df3f2445433cdaa987b33d5419be0aa67dcecd837b8dad2e7；13输出和所有原payload/行/129 ledger why保持，只更新原provenance，classic 0→0，无增长声明。私有projection wrapper准备错误保留，生成不重跑。独立匹配门与新exact-SHA CI另验，没有本机AW tests/typecheck/build/service。Task/RFC371 WIP保留；仍Stage A，完整H7/真实根/Task事务/19 handles/A-G、CS adapters和M0先部署至M4继续，AW尚未部署CS，RFC未完成。详见 design/RFC-370-crewstation-hosted-deployment/purpose-typecheck-canonical-publication.md。以下旧内容及并行输出保持。

### 旧 Windows 作业步骤记录更正

原 job112582243341 的步骤5（RFC-363恢复）、6（RFC-254平台）及原共享测试已success；步骤15 Typecheck failure，之后的build/doctor未执行。此前将整作业功能测试记为“尚未执行”不准确，本次只更正这句记录；完整原候选、误记、所有复核和正式failure证据保留。新增Purpose回归不在旧Windows原命令中，不能据旧平台步骤success宣称它已在Windows执行。

生产/测试修正与13匹配输出已通过有限SOURCE5-R2/MATCHING16-R2并精确21路径上库e4bd62318e12848d730b1c52f2dd29706e9da5e1；main/origin当时0/0、index空、全部Task/RFC371并行WIP保持。该SHA主CI37561996355与确切同SHA Windows37562206818已启动，终态待验；后者仅沿原平台列表运行，不包含新增Purpose测试。本文更正无生产/测试/架构规则/匹配变化，无新census或本机AW运行，不重签旧历史门，Stage A/H7/A-G及CS部署仍开放。

## 2026-10-07 RFC-370 Task 配置真实入口接线与配套候选

SOURCE19-R3 有效稳定有限 PASS，R1 的显式 file source 与 defaults 类型两项 P2、R2 新回归清理成员名 P2 全部闭合且原失败保留。16 个生产/两回归覆盖 CLI、SQLite HTTP、PG、继续/retry、SC 与 Fusion 的同一所选 query、热读取/ACK、原 cleanup/事务/短 coordinator；四份相关共享 bootstrap 保留完整并行 RFC-371 Native 接线。

一次原静态生成 fixed fcb05bae 加本批 16生产/2测试，13产物 sourceDigest sha256:ce77a1bc533f324c116be9765456bfcd93e13d4ebe4ee870564e5cd4121c7bca；classic 全数组相等 50/0，原 import/exception/owner 行和129 ledger why/顺序保持，仅原派生 public 与 physical line 锚点更新。四项实测 one-commit 声明 imports6782→6789/exceptions5956→5961/public1217→1218/owners27387→27389 随匹配发布消费后普通退役。首次私有投影的 line-derived symbol 比较错误保留，不重跑 census。

独立匹配门、精确上库/同步、新 exact-SHA hosted CI 分别验收。H7/其它并行 WIP 不纳入；无本机 AW tests/typecheck/build/service。三个根的执行权、Task原事务、19 handles与A-T7/A-G继续，之后各层独立CS adapters，先M0实际部署再M1～M4；AW尚未部署CS，RFC未完成。详见 design/RFC-370-crewstation-hosted-deployment/task-launch-configuration-canonical-publication.md。原共享全文和并行输出保持，仅追加此段。

## 2026-10-07 RFC-370 Task 配置接线发布与四项一次声明退役

Task 源码及配套完整35路径已发布53be4913a91aad4385cdf52ee4c195abc0ba0e11，main/origin同步0/0、index空；四份共享bootstrap包含完整并行RFC-371 Native接线，其余H7/RFC-371在制字节保持。SOURCE19-R3和MATCHING16-R3已独立有限PASS，根会话实际完整消费首末所有源/匹配条目和wrappers。新SHA主CI37569551999、Windows37569551998及两项专项已排队，终态另验；不据有限门声称CI绿。

本普通后继只退役已随53be4913消费的四个one-commit增长声明。完整129行baseline、顺序、why及其它字段保留，仅按原payload算法刷新ledger digest。源码和13原产物不重生，三份共享文档完整旧前缀保持，仅追加本段；没有新census或本机AW执行门。

旧H7核心后继79d31c96主CI37557367648已terminal failure，72作业55success/17failure；已发布Purpose类型/receiver修复覆盖其对应错误，剩余功能源码reader/公共入口等按实际日志继续处理，旧失败保留。H7 binding及Task失权quiesce有限SOURCE7-R1已PASS，但实际三根、Task事务、19handles和named admission/A-T7/A-G继续；随后独立CS adapters，先M0实际部署再M1～M4。AW尚未部署到CS，RFC未完成。

## 2026-10-07 RFC-370 功能 CI 公开入口与完整根配套候选

SOURCE16-R1 有效稳定 FAIL 的唯一旧 materializer callee P2 已闭合并保留原回执；SOURCE16-R2 有效稳定有限 PASS，16 自有路径修正 canonical provider alias、exact public 位置、旧 physical reader、完整 Purpose receiver、三条既有 type edge 及 Task/Native 根的原完整判据兼容。根会话实际消费65项与三个wrapper，原双provider用例/预算与完整旧根摘要保持。

原唯一静态生成固定25da3dd4叠加七生产路径（六个存在）与八测试/数据路径，13输出sourceDigest sha256:999f5b299f78863f1ab21c416f1969ea0047deaae920f14c2628da8d7308c779；classic完整数组0/0相等。只新增一条DatabaseProvider类型边及其原exact exception，三个staging owner物理迁移而总数不变；全部其它payload与129原库存why/顺序保持。前继三项已消费临时声明按原协议退役并完整留证；本批两项实测增长6790→6791／5961→5962随匹配发布消费后普通退役，不重跑census。私有provenance比较错误及修正分别保留。

配套独立门、精确上库/远端同步与新exact-SHA hosted CI另验，无本机AW tests/typecheck/build/service/E2E，无跨会话消息。全部H7/RFC-371未发布输出保持。完整H7/A-T7/A-G、各层CS adapters及M0先部署至M4仍开放，AW尚未部署CS，RFC未完成。详见 design/RFC-370-crewstation-hosted-deployment/functional-ci-canonical-publication.md。以下原内容及所有并行输出保持，仅追加此段。

## 2026-10-07 RFC-370 功能 CI 修复发布与两项一次声明退役

SOURCE16-R2 与 MATCHING16-R2 有效稳定有限 PASS 后，源码/回归和配套32路径已精确发布698feafd0b83bbcb6cc6fd52c53807624d44003c，main/origin同步0/0、索引空，全部H7/RFC-371并行在制字节保持。原SOURCE16-R1唯一P2的FAIL、私有provenance比较错误和rename暂存展示校验停止均保留；rename展开两端后全32条暂存内容实际核验，无历史改写。

该SHA主CI37576174673、Windows37576174682已注册，首次均queued，正式终态继续验收，不据有限门宣称CI绿。本普通后继仅退役本次已消费的imports6791/exceptions5962两条one-commit声明，原129库存baseline/why/顺序/其它字段以及source projection保持，只按原五个纯JSON函数更新ledger digest。三份共享文档完整前缀保留，仅追加此段；没有新生产改动、census或AW本机执行门。

完整H7三根、Task原事务、十九handles、早期恢复、named admission/UI及A-T7/A-G继续；随后各层独立CS adapters，先M0实际部署再逐项M1–M4。AW尚未部署CS，RFC保持In Progress，无跨会话消息。

## 2026-10-07 RFC-370 H7 binding/quiesce 与 Windows 回归发布候选

SOURCE7-R2 有效稳定有限 PASS，完整 SO provider/generation 配对及 Task authority-loss 停止派发面已备妥；尚无实际 bootstrap 消费者。唯一原 scoped census 在 6bbe50d 加四生产/两测试冻结文件，十三配套输出沿用原规则；原全体数据与 129 有序库存理由保持，仅四项实测增长 6791→6793、5962→5964、1219→1234、27390→27399 待消费后普通退役。经典完整边界仍 0/0，没有重跑 census。

WF1-R1 有效稳定有限 PASS，四组执行权回归补入原 Windows 触发路径与平台命令，原完整 YAML 和全部旧用例/预算保持。698feafd Windows 已终态 719 pass/3 skip/1 fail；PG 完整体断言的两处旧对象身份比较由独立两路径候选修复，原语句数与旧摘要保持。源码对照、配套门、上库与精确 CI 分别验收，不把纯 AST 当 CI 通过。详情见 RFC-370 host-authority-binding-publication.md。

实际提前恢复、十九 handles、Task 同事务上下文/执行 admission、其他 owner/UI、完整 H7/A-T7/A-G 与 CS M0–M4 均继续开放。AW 尚未部署 CS；完成当前原切面后先部署 M0，再逐步适配。以下旧完整 STATE/plan 前缀及并行输出保持，本批只追加登记。

## 2026-10-07 H7 binding/quiesce 发布及四条增长声明退役

四个独立有限功能门均通过并由根会话绑定实际完整正文；二十六路径已正常提交上库 2826955a61651cb4b5fdce48fcb1256c9b8c8653，main/origin 精确同步、索引为空，当前后继与并行 WIP 保持。main CI 37578776948 和 Windows 37578776914 已按该精确 SHA 登记，终态待验；不把门通过记作 CI 绿。

本普通后继仅退役已经消费的 imports/exceptions/public/owners 四条 allowGrowth，129 个原有有序库存项、why、实测 baseline 6793／5964／1234／27399 及全部其余字段保持，按原五个纯 JSON 函数刷新 ledger payload 摘要。原十三配套与唯一原 census 不重跑；三份文档完整旧前缀及每条原声明的完整理由保持在实际发布证据中。

实际 bootstrap、提前恢复、十九 handles、Task 同事务上下文与执行 admission、其他 owner/UI、H7/A-T7/A-G、CS 独立 adapters 和 M0～M4 部署继续开放。AW 尚未部署 CS。运行会话后续源码与回归另行开发，不包含在这四路径退役提交。

## 2026-10-07 RFC-370 Runtime/Webhook 执行权切面与配套候选

SOURCE11-R3 有效稳定有限 PASS，原 R1/R2 功能失败完整保留。RuntimeSession 的同 generation handle selection、真实停止/排空模式 ACK 和 Integration 自有失权切面已准备发布；两 provider 回归与实际 Webhook worker 联合回归加入原 Windows 路径/命令。实际 bootstrap 十九 handles 尚未接线。

唯一原 scoped census 固定 6825e230，叠加六生产/两测试，Intent 在制品排除，其余 6701 源码读取原 blob。十三配套沿原四条规则，sourceDigest sha256:c73b8ce0d63e535c56fdd7e17701ac289f0ce2e0ab1076b3864496203b82eb4e；经典完整数组相等，本批 scoped 1/0。所有旧完整行、public 形状及 129 库存 why/顺序保持，五项实测增长消费后普通退役，不重跑 census。

配套独立门、精确路径上库/同步与新 exact-SHA hosted CI 分别验收，无本机 AW tests/typecheck/build/service/E2E。真实启动根、提前恢复、Task 原事务/admission、其余 owner/UI、H7/A-T7/A-G 继续，然后独立 CS adapters，先 M0 部署再 M1–M4。AW 尚未部署 CS，RFC 未完成。详情见 design/RFC-370-crewstation-hosted-deployment/host-authority-runtime-webhook-publication.md。共享 STATE/plan 的完整原前缀与并行输出保持，仅追加此段。

## 2026-10-07 Runtime/Webhook 发布及五条一次增长声明退役

源码 SOURCE11-R3 与配套 MATCHING16-R3 的独立有限功能门均通过，根会话核对实际完整内容后精确发布 27 路径：4c87db675494ae695f19e535023cc28e6a56736e。main/origin 同步 0/0、索引为空；Intent、Task 及所有并行在制品完整保持。该 SHA 的主 CI 37591451763 和 Windows 37591451754 已登记，首次均 queued，正式终态待验。

本普通后继仅退役这次已消费的五个 allowGrowth。原 129 个有序库存项、why、实测 baseline 1955／6798／5969／1235／27411 与全部其它字段保持，只按原五个纯 JSON 函数更新 ledger digest。原唯一 census、十三配套生成和生产源码不重跑、不改写；三个共享文档保留原全文，仅追加本段。

真实启动根、提前恢复、十九 handles、Task 原事务/admission、其他 owner/UI 与完整 H7/A-T7/A-G 继续，之后独立 CS adapters，先 M0 实际部署，再逐步 M1–M4。AW 尚未部署 CS，RFC 未完成。后台 Task 新设计和源码仍在独立实施，不包含在本退役提交。

### 2026-10-07 RFC-370 Intent selected 排队恢复候选

SOURCE4-R1 与 WF1-R1 独立有效稳定 PASS：捕获原执行权回调/receiver，配置前后失权不恢复，原待处理集合及真实 ACK 保留，native 零参入口与旧行为完整保持。两份生产加一份新测试进行一次原 scoped census；13 原输出、12 JSON 业务 payload/完整数组/分母及 129 有序 ledger/why 不变，只更新原快照摘要；classic 前后完整相等、无增长声明。匹配清单独立门及源码/清单/Windows 的精确发布与 hosted CI 待闭合。本机不跑 AW tests/typecheck/build/service/E2E；实际启动根、19 owner、Task 原事务/准入、UI、H7/A-G 和 CS M0–M4 继续，尚未部署 CS。旧共享正文及并行内容完整保留。详见 `design/RFC-370-crewstation-hosted-deployment/host-authority-intent-publication.md`。

### 2026-10-07 RFC-370 Task background selected lifetime 候选

SOURCE4-R2 与 WF1-R1 独立有效稳定 PASS；R1 唯一 module-open P2 原 FAIL 保留并闭合，必需 resume ACK 纳入启动成功、autoResume 原 detached/真实 ACK 保持，新增双 provider sealed gate 回归至二十 case。完整原 native AST、三套旧测试、R1 九个 case、原正文保持。一次原 scoped census 只含一份原 production、一份新 Task port、一份新测试，排除全部非本批 WIP；13 原输出完整保持，仅新增四 owner 至 27415、一个文件与一条 timer 物理标记移动，其他全部 payload/数组/分母和 classic 0/0 保持。129 库存/why 保留，一条 owners 实测声明消费后在普通后继退役，无新 census。配套独立门、精确发布与 hosted CI 待验；实际根、19 owner、Task 原 TX/准入、UI、H7/A-G 和 CS M0–M4 继续，尚未部署 CS。旧共享全文及并行内容完整保留，详见 `design/RFC-370-crewstation-hosted-deployment/host-authority-task-background-publication.md`。

### 2026-10-07 RFC-370 Task background 发布及普通后继退役

SOURCE4-R2、WF1-R1、MATCHING16-R2 均由独立 reviewer 有效稳定有限 PASS，root 绑定实际完整正文后正常发布21路径：`a7299dec8d17fcf61f6f431be4e47006d9464cc8`。发布后 main/origin 同步0/0、索引为空，未改变任何并行在制品。主 CI `37599930554`、Windows `37599930580` 已按该精确 SHA 登记，首次 queued，正式终态待验。

本次普通紧接后继只退役已消费的一个真实 owner 增长声明；原129有序库存、所有 baseline/why/其它字段和原 source/projection 保持，仅按原五个纯JSON函数更新 ledger contentDigest。生产四路径、测试、Windows登记和其它十二项配套全部不改，不重跑 census。原配置后 module.resume 真实ACK遗漏的首轮 FAIL 和源码修正 PASS 均保留。

本次只是独立 Task background selected lifetime，实际启动根、所有十九 owner、Task 原事务/准入、UI、完整 H7/A-T7/A-G 与各层 CS adapters、M0首次部署至 M4 仍继续。没有本机 AW tests/typecheck/build/service/E2E、没有跨会话消息，AW 尚未部署到 CS，RFC 未完成。普通后继的独立有限门与精确发布仍须分别核验；CI排队和静态检查不算整仓通过。

### 2026-10-07 RFC-370 selected polling 有限候选

SOURCE3-R1／WF1-R1 独立稳定 PASS，原 native AST／整套旧测试／Windows 原命令与预算保持，新增双 provider 24 个 selected polling 用例交 hosted 精确 SHA CI。清单实际原生成两次：首轮原生成后私有包装器文件数错误导致未完成，保留失败；修正后的唯一完整成功输出先保存，不再重跑。旧全部 owner／background／opaque mutation 行保持，仅 owner +3 至 27419、background +1 至 367、mutation 分类 +1 至 1956，一条原 timer 106→250；其它 payload、SCC／target 和 classic 0/0 保持。129 有序 ledger／why 保留，三个实测声明在普通后继退役。并行 RFC-371 已在 f0c94c3c 普通退役，只有该 ledger 变化，无生产变更，向前投影本批校验且不恢复其声明；STATE／plan 旧全文完整保持。配套门、精确发布和 hosted CI 待验，实际根／19 owner、Task 原事务全入口／准入、UI、H7／A-G 与 CS M0～M4 继续，尚未部署 CS。详见 `design/RFC-370-crewstation-hosted-deployment/host-authority-polling-publication.md`。

## 2026-10-07 轮询切面发布与三项一次增长声明退役

轮询20路径已精确发布 `88d0900064538b0c606836419f9e43ebf1ccfe2c`，推送后 main／origin 0／0、index 为空，独立 Task 持久参与者候选完整保留。SOURCE3-R1、WF1-R1 和 corrected MATCHING16-R3 有效稳定 PASS；原配套 R2 的私有摘要 FAIL 及后续 root 实际消费完整保留，R3 只修当前 proof 的 ledger 摘要，不重跑原生成或改 matching 正文。

本普通后继仅退役三条已消费声明：mutation1956、background367、owner27419。129个完整有序库存、baseline、why、预算及其它字段保持，沿原五个纯 JSON 函数刷新 payload digest。完整三文档前缀及并行输出保持，source3原字节不改。没有新的 census 或本机 AW tests／typecheck／build／service／E2E。

该提交主 CI37612138168／Windows37612138153已注册，终态另验，不能记为全仓绿。Task持久参与者 SOURCE18-R2 有限 PASS，原失权窗口 F01 与新增两个真实双 provider 原事务案例已复核；其源码尚未随轮询发布。实际Task调用者／启动根／19owner／UI、H7／A-G及CS M0～M4继续，AW未部署CS，RFC保持进行中。

### 2026-10-07 RFC-370 Task 宿主写上下文持久参与者候选

SOURCE18-R2 与 WF1-R1 独立有效稳定有限 PASS，root 已实际消费完整正文。原失权到 durable drain 的窗口 F01 FAIL 保留并修复，原 current 方法／receiver 和实际同一事务回滚保持；原十个双 provider 案例保持，追加两个真实案例。新的 SO 生命周期、持久参与者及 Task 独立 adapter 尚未接入实际 claim／heartbeat／runner／业务 caller 或 roots。SQLite 0242、PostgreSQL 0018 沿原安装生成链，全部历史 artifact／旧表／journal 前缀保持。

唯一原 scoped census 固定98bf31c77，十生产（一批四原／六新）加一测试，全部非本批读 committed blob，13原输出先保存；sourceDigest sha256:9d91199c3580bd105ba448223d07aa6583ff10cff408014972bbd7a47048aaed，classic完整0／0相等。原owner／opaque mutation／import／exception行保持，仅新增25 owner、2 mutation、4 transaction、16 import／12原classifier exception、3 offered type；两条platform transaction物理行号与两个原public consumer数组作原派生更新。129有序ledger／why／预算完整保持，六条实测一次声明随发布消费后普通退役，不重跑census。私有投影的两次顺序比较错误和正确R3投影留证，原生成仅一次成功。

配套独立门、精确发布／远端同步与新exact-SHA hosted CI分别验收，无本机AW tests／typecheck／build／service／E2E，无跨会话消息。实际Task调用链／所有事务与named admission、三个roots／19 owner／UI、H7／A-G及CS M0首次部署至M4继续，AW尚未部署CS，RFC未完成。旧共享全文及并行输出保持，详见design/RFC-370-crewstation-hosted-deployment/host-authority-task-write-context-publication.md。

## 2026-10-07 Task 持久参与者发布及六条一次声明退役

SOURCE18-R2／WF1-R1／MATCHING16-R1 有效稳定有限 PASS，root 核对完整正文后精确35路径发布 `9c7c8992e12b0b3e2969a09aa4578003d98c321b`。main／origin同步0／0，index空，Task C1设计、功能CI修复及全部并行WIP字节保持。新精确SHA主CI与Windows已登记，终态另验，有限门不等于全仓绿。

本普通后继只删除六条已消费allowGrowth；129个原有完整有序库存、baseline、why、预算及其它字段不变，沿原五个纯JSON函数刷新ledger payload摘要。原十三输出和唯一成功census不重跑，三文档旧完整前缀与全部并行输出保持，十八个已发布源文件不改。没有本机AW tests／typecheck／build／service／E2E。

实际Task claim／heartbeat／runner、业务事务分类与named admission、三个roots／19owner／UI、完整H7／A-T7／A-G及CS M0先部署至M4继续。AW尚未部署CS，RFC保持In Progress；CI夹具的独立修复另行验收，不包含在这次普通退役提交。

### 2026-10-07 RFC-370 功能 CI 夹具与登记修正候选

修复原4c4ecbc14afa80982298c47a2ac57761bb1ac74c主CI37592876200实际 failure 的六处类型错误、scratch/email 启动输入、恢复续接 v1 payload 和 selected runtime reader；所有原 case、timeout、expect 输入和业务判据保留。Task insert 四站点/三列齐全不变，只更新两个 AST 物理位置；Off-DAG 原46行保留，新增真实Task→SO adapter边一条，原43基线如实纠正到47，一条实测许可普通后继退役。129 ledger全文/why/预算保持，使用原payload digest，无新whole census。有限实现门、精确上库和新exact-SHA hosted CI另验，无本机AW tests/typecheck/build/services/E2E，无跨会话消息。C1在制工作保留；H7/A-G、各层CS adapter和M0先部署至M4仍继续，AW未部署CS。详见design/RFC-370-crewstation-hosted-deployment/functional-ci-fixtures.md。

## 2026-10-07 功能 CI 夹具修复发布与一次声明退役

SOURCE12-R1 有效稳定有限 PASS，root 实际消费完整41项及3wrappers后，十二相关路径精确发布8fb6742f7baf70f57fe223c8c7bf06aa29dcb3b7。main／origin同步0／0、index为空，C1及C2的全部在制工作字节保持。主CI37623212828和Windows37623212950已登记，终态待验，未记全仓通过。

本普通后继只退役已经消费的 rfc294-review-off-dag-offered-edges 一条实测许可；47完整声明及原129有序ledger/baseline/why/预算保持，使用原五个纯JSON函数重算payload digest。原八份测试和所有源码／架构快照不动，无新census或本机AW运行。原source有限门、精确发布、普通后继有限门和正式CI分别留证。

C1的首轮两项测试配置P2、原FAIL/root消费及修正保留，修正后的SOURCE6-R2继续复核，不包含在这四路径提交。实际Task调用者、原退场ACK、19owner/roots/UI、完整H7/A-G及独立CS adapters/M0先部署至M4继续，AW尚未部署CS，RFC未完成。旧共享正文与并行内容完整保持。

## 2026-10-07 RFC-370 Task 原写上下文传递与具名事务候选

原 capture／receipt／方法与 receiver 在 Task 自有私有关联中跨 await 保留，new-work／recovery／issued-ACK 三入口等待同原事务的真实消费；原 SQL／owner 判据与错误优先级保持，native 不变。SOURCE6-R1 的两处真实 provider fixture P2 已实际消费 FAIL 后修正；SOURCE6-R2 有效稳定 PASS，原12个 case／75 expect／预算及另外五个 owned 文件保持，Windows 原78命令与三个新套件位置保持。

一次原 scoped census 固定3dc43c13，四原规则不变、13 raw 输出先保存；3个 production／1个测试，完整 classic 0／0相等，新增21 owner／2 execution-local／2 transaction／1 type-only import及原 classifier exception。129有序账本和 why 保持，只给五项实测增长一次许可并在普通后继退役。无本机 AW tests／typecheck／build／services／E2E；独立 matching 门、上库同步和新精确 SHA CI 另验。

实际 Task claim／heartbeat／driver／业务分类／finalization 重试尚待 C2。三 roots／19 owner／UI、H7／A-T7／A-G 及各层独立 CS adapter、M0 首部署至 M4 继续；AW 尚未部署 CS。详见 [Task 捕获与具名事务发布](host-authority-task-write-capture-publication.md)。以下旧文档及全部并行输出完整保留。

## 2026-10-07 Task 传递层发布与五条一次声明退役

SOURCE6-R2 与 MATCHING16-R1 独立有效稳定有限 PASS，root 实际消费完整正文后精确发布22路径；发布记录保存实际 commit、远端0／0、空 index 和全部并行 WIP 保留的字节证据。新精确 SHA 的主 CI／Windows 分别登记，正式终态另验，有限门不等于全仓绿。

本普通后继仅删除五条已消费 allowGrowth。129项原有完整有序库存、baseline、why、预算和其他字段不变，沿原五个纯 JSON 函数重算 ledger payload 摘要；原13项配套及唯一完整成功 census 不重跑，6个发布源文件和全部原12个 case／75 expect 保持。三文档的完整旧前缀及所有并行输出保留，没有本机 AW tests／typecheck／build／services／E2E。

C2-W1 原 D1／D2 有效 FAIL 已真实消费，D3 原 driver 寿命屏障与锁内复核设计有效稳定 PASS，实际 claim／heartbeat／finalization 接线继续实施。原业务分类、三个 roots／19 owner／UI、完整 H7／A-T7／A-G、各层独立 CS adapter、M0先部署至M4仍开放；AW 尚未部署CS，RFC保持In Progress。

### RFC-370 C2-W1 Task 原受理、心跳与收尾配套候选（2026-10-08）

SOURCE23-R2 实际稳定有限 PASS 已由 root 消费，23 owned／33 control／26 evidence 共82项；原 SOURCE23-R1 FAIL 与 D3／D5／D6 设计回执保留。选定 Task 原工作贯穿 claim、heartbeat、driver、失败受理与原回执清理；D6 等待原 heartbeat Promise 和真实 owner writer 事务确认后才缓存 revision，保留同步失败的原工作重试。完整原32个 provider case 与 native 分支保持，追加四个真实双 provider 回归；Windows 配对注册保持。本机只做自有格式／lint、纯 AST／字节核对，没有 AW tests／typecheck／build／service／E2E。

唯一原 scoped census 固定 `0b9358fc5878bc7cbf52f46def98b45daa746cd1`，输入16个 production（9既有／7新增）、5测试及6714个非本批基线完整源 blob，原四规则保持，13原始输出保留，完整 classic 数组0／0相等。实测92 owner、6 mutation、净增5 background、1 ambient、8 import／7 classifier exception、净增1 transaction；39个旧 Task 写入行仅移动实际物理锚点，原 authored debt／129有序 ledger why 保持，public 仅增加既有 HostExecutionAdmission 的实际消费者。七项实测声明、并行公共入口 public-surfaces1238→1240、既有 public-consumer baseline135→141 和本批 Task→SO offered-edge47→48，共十项，由普通后继退役，无须再次 census；原债务数组和原／后清单实际均141项。原47条 offered-edge记录逐条完整保留，新增唯一具名实际 Task composition受理桥，原判据及W9-D清偿保持。同一 shared ledger 中 RFC-371 先行33769f07的333全行与why追加保留，仅按原规则退役已消费的一次声明。六个已发布入口文件的原运行语句保持；原助手和原九个汇总式补齐依赖投影，完整逆向复现原八个canonical对象，没有新增整仓census。综合sourceDigest为 `sha256:f1463af4ff160e4180faabea06b35698062cba2c4201d896408ec81186fcd8c5`。配套投影第一轮真实失败及修正后的 PASS 保留，STATE／plan 只追加。

配套功能门、精确提交／远端同步和新 SHA hosted CI 尚待验收；详见 RFC-370 的 `host-authority-task-callers-publication.md`。C2-W2 业务写入／effect、19句柄、三个 roots、状态 UI、A-T7／A-G 与 CS M0～M4 仍开放，AW 尚未部署 CS。继续完成 RFC，不以本有限切面收尾。

- RFC-370 C2-W1 配套 R2：并行 AW 接口修复 a443cba8776add749087e3524d50a34b6b776692 exact18 已上库，其实际 SOURCE PASS 和35材料绑定已核对；Task SOURCE23-R2 的82原项全部不变。旧 MATCHING16-R1 因5 control 漂移（2删除）实际 INVALID，原回执保留。沿唯一原 census 对15物理生产差额仅用原助手补依赖，完整逆向复现8 canonical对象，3205输入，最终9一次性声明；129库存/why及并行333保留，47→48 offered只加原具名边，无新增 whole census。本候选待 R2 独立配套门、exact39 发布和精确 SHA hosted CI；W2-E／W2-R 设计已分别获实际稳定有限 PASS，源码尚未实施，H7／A-G／CS部署继续开放。

## 2026-10-08 W2-E与精确Task CI修复有限进度

SOURCE4/CI SOURCE7有效PASS已实际消费；一次原census与并行e28的3文件有限投影，13 matching及旧库存/并行输出保留，仅补两原Driver probe人口68→70一项许可。原290f主CI failure、Windowscancelled保持。此处只登记本片功能门/配套候选，实际精确发布与新exact-SHA CI另留证；不勾选H7或A-G，不记CS部署，runtime lease仅设计/私有草稿。继续Task/Node写入与恢复/owners/三个roots收口，M0先实际部署再M1～M4。详见[effect记录](host-authority-task-effect-writes.md)、[CI修复](task-host-callers-ci-repair.md)。

## 2026-10-08 既有代码回顾优先与 Task CI oracle 修复

- [x] 根据真实 hosted 功能失败，冻结原两阶段 registry、selected finalization / heartbeat 生产实现与两个原测试；设计门已实际消费为有效稳定 PASS。
- [x] 两条原 null 断言完整移至原 settle 完成后，新增四条释放阶段断言；两条 INSERT matcher 仅补固定可选 agent_workflow schema。原 13 / 14 个直接 test 声明、所有旧断言、真实生产 15 秒心跳、60_000 / 15_000 预算不变；全文逆向还原与 AST 对拍通过。无生产 / metadata 变化，无新 census 或本机 AW 测试。
- [ ] 完成既有 449 个历史生产路径的正确性与质量回顾，修复可操作功能 findings，并完成本修复实现门与最终精确 SHA CI；在此之前暂停新 runtime lease / Node / CS adapter 实现。
- [ ] 继续原 H7 / A-T7 / A-G，再按 M0 必须 adapter 先部署、M1～M4 逐项接入；RFC 仍未 Done，AW 尚未部署 CS。

详见[修复记录](task-host-ci-phase-oracles.md)。共享 plan / STATE 的所有旧正文及并行输出完整保留。

## 2026-10-08 原 CI held rejection matcher 时序候选

精确05e主CI37705887143正式failure、Windows37705887174正式cancelled；原PG cause与W5退役对应三作业success，但六后端分片及Windows在三套RFC-370手工barrier测试处自锁。四处rejection matcher移到原barrier释放后，提前只观察原Promise拒绝；全部原断言／名称／预算、生产与canonical保持，无新census／本机AW运行。独立实现门与新exact-SHA CI另验，两项回顾P2已通过独立设计并应用，源码门／配套门与CI分别验收；runtime／Node／CS新实现仍暂停。详见[CI时序修复](ci-held-rejection-matchers.md)。以下共享STATE和并行正文完整保留。

## 2026-10-08 既有功能回顾修复与配套候选

完整 DESIGN46-R2／SOURCE51-R1 有效稳定有限 PASS 已实际消费，两项原 H345-P2-001／H7-P2-001 按原目录／错误／ACK 语义补齐终端 ref 退役与 raw undefined failure 保持。唯一原 scoped census 保存 13 原输出，原 129 有序 ledger 全行／why／baseline 保持、无增长许可；两个既有 public 合同加入真实 forget 方法，其余全部 payload／数组／分母保持。独立 matching 门、源码／配套精确发布与新 exact-SHA CI 分别验收。原 d05fc28b CI 正在正式验收，新 runtime／Node／CS 适配暂停至本片和 CI 收口；H7／A-G／M0～M4 及 RFC Done 不勾选，AW 尚未部署 CS。详见[回顾修复发布](retrospective-functional-repairs-publication.md)。原 shared 全文与并行输出完整保留。

## 2026-10-08 原 CI 类型与 PostgreSQL oracle 跟进

原 d05 Windows `37711897530` 正式 failure；三套 held-barrier 原测试均完成并通过，不能记全仓绿。主 CI `37711897500` 的功能日志确认两处端口 union 的 `.catch` 类型错误、一处本会话新增的 plan 相对链接，以及 failed-claim 的两个 rollback wrapper 与一个 PG retry HTTP oracle。有限修正使用 `Promise.resolve(starting)` 观察而保留原 matcher 输入；PG 原 rollbackError 在 DrizzleQueryError 的 cause，retry 原同步 DomainError 为 400，SQLite 原后台受理保持 200。全部原名称／用例／业务断言／等待预算保持，无生产或第二次 census。

回顾 SOURCE18 和唯一原 13 metadata 均保持，MATCHING60-R1 有效稳定有限 PASS 已实际消费、129 库存／why／baseline 与零增长许可保持。此处只纠正原一条错误链接并追加实际事实，CODE3／DOC3 门、精确发布与新 exact-SHA 主／Windows CI 另验。H7／A-G／CS／RFC Done 继续开放；详见[CI 跟进](ci-followup-oracles.md)，其余 shared plan／STATE 与并行输出完整保留。

## 2026-10-08 回顾回归的两处静态类型修正

回顾 SOURCE18／MATCHING14 和 CI6 已实际发布三笔，最终 `de10350bcf23734e2816795053747706aa4f1dba`；双方共享全文保持、远端同步、索引空。该 SHA Windows `37716532745` 正式 failure；主 CI `37716532515` 基础检查与 Windows 同时报新退役回归的参数 TS7006、原数组第二项 TS2769。本片只补 getter 分支 release 参数的既有 `IntentSystemAgentRunFamily` 窄类型，以及原 `references[1]` 的非空类型标记（原完整两项长度断言保持）；不修改 JavaScript 行为或任何断言／case／等待预算。原生产11、两个真实公共 forget 合同、13 metadata 与129库存／why／baseline 完整保持，不新增 census或增长许可。

独立功能门、精确提交与新 exact-SHA hosted CI 另验；原 de103 失败不倒写，H7／A-G／CS／RFC 仍未完成，新 runtime／Node／CS 实现继续暂停。详见[CI 跟进](ci-followup-oracles.md)；其余 shared plan／STATE 与并行内容完整保留。

## 2026-10-08 澄清续接并行后继的完整根 CI

80f59b75 Windows37719697790 正式 cancelled，类型／平台测试步骤成功、构建未完成；原主37719697713终态另验。完整保留修复的 e6098f5b 后继 Windows37720290354 正式 failure：唯一功能失败是原 MCP 完整根 reader 拒绝已提交的 gateContinuationDeps 新接线。原 de103 主37716532515正式failure保持，不倒写旧结果。

只修 fixture 单项当前语句摘要并记已提交来源；原 previousStatement、四 root 人口和所有原 MCP 完整 body／argument 断言保持。纯 AST 证明四完整 SourceFile 的 before／after inverse 相同，未知 binding 仍拒绝。Windows push／PR 两过滤器各补原 TS／JSON 输入，全部原 workflow 命令／预算逐字保持。零生产、零 metadata、新 census／本机 AW tests／typecheck／build／services／E2E。

有限功能门、精确发布和新主／Windows hosted CI另验；所有旧共享正文与并行输出保留，新 runtime／Node／CS 实施继续暂停，H7／A-G／M0～M4和RFC Done未勾选，AW尚未部署CS。详见[完整根 CI 跟进](ci-live-continuation-root-inverse.md)。

## 2026-10-08 原 RFC-108 启动预算 oracle 的已提交接线跟进

完整根校验五路径已实际发布 `6c2daf58e956519d3a891ee07eaf95a4ce612ebd`，SOURCE5-R3 有限 PASS 已消费，远端 0／0、共享索引空，16 份并行 WIP 保留。该提交主 CI `37725311240`／Windows `37725311251` 已启动，终态另验，未记整仓绿。

原 e609 主 CI `37720290274` 的 Ubuntu 2／32 作业 `113126139077` 只有 RFC-108 源码接线断言失败，仍要求 `selectedQueries`；已提交 `gateContinuationDeps` 实际传 `continuationQueries`。只改这一处 expected 字符串及对应注释，原同步 floor fallback、全部 7 case／18 expect receiver、matcher／名称／预算保持；`120_000`、30 min 默认与不自动传 per-task 预算的原断言保留。纯 AST 全量逆向及原源码 handoff 核对完成，未运行 AW 测试／typecheck／build／服务／E2E，零生产／metadata／新 census。四自有路径的有限独立功能门、精确发布及新 exact-SHA CI 分别验收；原失败不倒写。所有此前 plan／STATE 与并行正文保持，新 runtime／Node／CS 实现继续暂停，H7／A-G、M0～M4／RFC Done 保持开放。

## 2026-10-08 总流水线全绿门槛与 identity 清单 CI 跟进

用户明确选择 GitHub 总流水线全绿后才继续 RFC。7b62be23 的主 CI 37727175165 正式 failure，70 项功能作业和 Windows 37727363630 均成功，不能代签总绿。4efba2f9 的 Ubuntu 1／32 作业 113166465304 仅 RFC-349 完整 identity 清单遗漏新表；同作业的 PostgreSQL DEFAULT、SQLite NULL 和多行事件原判据通过。只补 system_agent_observation_sources 一项，旧清单成员与四 case／完整遍历／预算保持；类型错误由并行 RFC-371 会话修复，本片不改其源码或配套。不增加生产／metadata／census／本机 AW 运行。有限功能门、精确发布和新 SHA hosted CI 分别验收，总流水线成功前 runtime／Node／CS 新实施保持暂停，H7／A-G、M0～M4 与 Done 仍开放。

## 2026-10-08 当前 schema head 的五套既有 schema hosted CI 配套断言

identity 清单已发布 c48db612，新主 CI 37736663092 终态另验。4efba2f9 的 Ubuntu 5／32、15／32、2／32 分别确认 journal 243、active tables 233、backup activeTableCount 233；原精确预期仍为 242／217／217。Ubuntu 31／32 与 12／32 另确认 canonical／SQLite source tables 已为 239，旧预期仍为 223；只更新五套既有测试的这些数字和对应标题，追加 0243／0019 的排序后完整 16 项 System 名单，原 Task／observation\_、六张 archive-only、历史 replay、完整 machine／human snapshot 一致性、Worker 全表分页、全部旧 case／matcher／预算保持。完整逆向和纯 AST 核对，独立有限功能门、精确发布与新 SHA hosted 总 CI 分别验收。零生产／metadata／新 census／本机 AW 产品运行；总流水线全绿前 runtime／Node／CS 新实施继续暂停，H7／A-G、M0～M4 与 Done 未完成。详见[当前 schema head 配套](ci-current-schema-head.md)。所有旧共享正文与并行输出完整保留。

同批 Static scans 必要 CI 排障已获用户明确允许；四个目标依赖的版本／锁文件候选保留原检查规则，有限功能兼容门与 hosted CI 另验，详见[依赖版本修复](ci-dependency-versions.md)。本片 schema 断言门不代签依赖功能兼容或总流水线成功。

### 79b63f48 新增 System 测试的类型修复候选

GitHub 主流水线 `37746020731` 的作业 `113207582002` 在两个新增原测试中报三处类型错误：`refreshKey` 的 UUID 默认值推断过窄、索引后的可选值与 Set matcher、可选 root head 与 Array matcher。仅给 helper 参数声明 `string` 并为两个原 matcher 显式声明可选值类型；原运行时表达式、双 provider、三条原用例、所有断言、记录人口及 60000/120000/30000 ms 预算保持不变。完整 parser 运行时 AST 和独立功能复核作为有限源门，最终仍以 hosted exact-SHA CI 为准。总流水线未全绿，新的 runtime/Node/CS 实现继续暂停，RFC、H7/A-G 和 AW 在 CS 的部署均未完成。

### 2026-10-08：调用分页原测试的显式返回类型

`5b8c7b320d89bb694a872282455e021e8b777463` 主 CI `37761392727` 的共享作业 `113258382764` 在 Typecheck 报告 `rfc371-system-complete-report-provider.test.ts:238` 的 TS7022。本批仅为原调用分页循环的 `page` 添加由现有 `service.page<CompleteObservationInvocation>` 方法推导的显式返回类型；原两个分页循环、游标重置、limit=1、完整 EOF、人口、全部 matcher、名称／Token／费用断言和 60000／120000 ms 预算保留。完整共享测试同时保留并行观测会话已提交的当前输出。

仅做纯解析 AST 等价与定向格式／lint 检查、有限独立功能门和新 exact-SHA hosted CI；不运行本机 AW 产品测试、typecheck、build、服务或 census，不改变生产代码或 CI 检查规则。有限门不能代签 CI 成功。总流水线全绿前继续暂停 runtime／Node／CS 新实施，H7／A-G、M0～M4 与 AW-in-CS 部署仍未完成。详见 [调用分页类型修复](ci-invocation-page-type.md)。

## 2026-10-08 总流水线全绿后恢复 W2-R

确切提交 b8c132497e1845d5268cc6bddf27089374a1c687 的主 CI 37768698721 正式 success：70/70功能、Static scans 与总判定共72/72作业全部成功；同 SHA Windows37768853703 正式 success。用户要求的 GitHub 总绿门槛已满足，两项既有功能回顾修复与后继 CI 修复历史保持。由此恢复已批准 RFC-370 H7 新实现，不以旧局部绿替代本次总绿。

W2-R 所有29原设计材料和六份原生控制在该主干仍一致，独立 R2 设计 PASS 已实际消费；Task-only 执行租约窄port、所选adapter/composition 与八个执行helper类型投影已应用，完整native工厂/SQL/repair/旧测试保持。新增14例/每provider、Windows对称接线保留并行 historical 内容。源门、一次原scoped生成、matching、精确发布与新 SHA CI各自验收；当前不借局部静态检查签运行成功。共享Windows发布要等其引用的并行新测试上库，不收编外任务新文件。

继续Task/Node具名业务写入与恢复、三个实际根/十九handles/状态UI、完整H7/A-T7/A-G；随后各层独立CS adapters，先M0实际部署，再逐项M1～M4。AW尚未部署CS，RFC保持In Progress。详情见 [Task执行会话租约](host-authority-task-runtime-leases.md)。旧共享全文和全部并行输出保留，本机未运行AW tests/typecheck/build/services/E2E。

## 2026-10-08 W2-R 源码门与一次配套生成

SOURCE9-R1 独立正式有效稳定 PASS 已由 root 实际消费：9 owned、19 control、7 evidence 共35项／835583字节，FP `057bf16243206d931363ebdcfe7771afdb407a5ecce7588771dce9d9e6242133`。八项原方法的完整原 context／token／work、实际提交后关联、同一原事务、业务错误及旧 native factory／repair保持；完整旧回归不改。新增14例/每provider由 hosted CI验收，本机只做 scoped格式／lint与纯AST／字节核对。

唯一原scoped census固定已总绿的 `b8c132497e1845d5268cc6bddf27089374a1c687`，覆盖本批7个TypeScript（6生产）和6756个已提交非本批源blob，排除并行源码在制内容；原四规则字节保持，13原始输出完整保留。实测owners27615→27623、mutation1969→1971、observed6853→6855、exceptions6001→6003，登记4项一次声明并由普通后继退役；129项完整有序库存、旧why及全部其余预算保持。原355条 authored debt全文保留，移除实际消失的Task→legacy窄类型边，登记实际新增的facade→Task执行port类型边；总数356，classic inbound309→310／outbound47→46。其余既有所有owner行、公共表面、guard内容保持，原8 canonical与原status输出全文保持，sourceDigest为 `sha256:8f8dfe8bb9a7ed2fba18babadbcbd8d7b4980b91e905e7bdcec499c03d4f8576`。

配套仅调用原纯JSON治理函数及原pretty/ascii格式函数投影；首轮私有presentation断言失败记录保留，修订后复现原4治理对象和原格式字节。未再跑整仓census、canonical采集器或AW tests/typecheck/build/services/E2E。旧共享STATE/plan完整前缀与全部并行输出保持。MATCHING16功能门、精确23路径发布和新 SHA主CI仍需实际验收；共享Windows暂不提交，避免收编其引用的并行未追踪测试。实际roots/provider接线、child/boot恢复、其余Task/Node及19owner/三roots、H7/A-T7/A-G与CS M0～M4继续开放，AW尚未部署CS。

原生成status及新追加文档只作Prettier空白与表格分隔线排版归一，原JSON输出和正文内容保留；配套门按实际最终字节绑定。

## 2026-10-08 W2-R 精确发布与声明退役

源码SOURCE9-R1和配套MATCHING16-R1独立正式有效稳定PASS均已由root实际消费，74正式配套材料及5份另列原源码复用材料均实际EOF核对；exact23发布 fbf85b2710180228f84a7e98b2becf7756ac50ae，远端0/0、空index、50项并行WIP完整不变。共享Windows暂未提交，所引用Task租约新测试已在main，完整Windows新用例接线仍待两方测试均上库。该SHA主CI37782710720与Windows37782710729已登记，正式终态尚待验收，不以功能门代签总绿。

本普通后继只退役4个已消费的allowGrowth；129项有序完整库存、baseline、旧why及其余字段、canonicalProjection/sourceDigest/原provenance锚点保持，只按原五个纯JSON函数更新contentDigest。四原生成规则、全部本批7个源码/测试及其余12架构文件保持；没有新增整仓census、AW tests/typecheck/build/services/E2E。此有限后继功能门、精确提交和新SHA hosted CI各自验收；三个共享/自有文档只追加、全部并行输出保持。W2-P准备/具名结果投影设计继续修正原显式context优先级，实际根、Task/Node其余分类、19owner/三roots、H7/A-T7/A-G与CS M0～M4仍开放，AW尚未部署CS。

## 2026-10-09 W2-P 原准备与具名结果投影

SOURCE7-R2 独立正式有效稳定 PASS 已消费，45 项首末 EOF 绑定与完整分析保持；共享安装 fixture 使用同一 installation/module 下两真实 Task，原 SQL、断言和预算保留。CI 前置在 0319cc77b7e2e46d737b6926725ea90bd4079b36 完成：主 37815498721 的 72 项和 Windows 37815498722 SUCCESS，旧失败仍保留。本批 5 个生产文件只在显式 composition hostWrites 选择时接入，保留完整原方法、receiver、callback、显式 context 优先级和同笔事务；新投影测试每 provider 21 项尚待 hosted 执行。

一次原 scoped census 固定上述成功基线，完整 13 输出、四原规则及各并行贡献保持，生产摘要 sha256:221b5e177750b14afbe9984196bb60352b5578ef51296f188b320abea5d10fa9。新增 3 个 Task infrastructure 文件、7 owner、2 factory、2 个 database-adapter erased type imports；classic targeted inbound/outbound 0→0，原 356 条 authored debt 与全部旧 why 保留，没有新 classic debt。129 项有序账本实测四项差额为 1979→1981、6886→6888、6030→6032、27690→27697，在本源码发布消费后以普通后继退役。原 status raw 字节完整保留，历史格式化失败与修复记录均保留。

MATCHING16 独立配套门、精确提交/推送、普通后继退役与新 SHA hosted CI 分别验收；新测试先上 main，再单独登记完整 Windows 三处命令。没有额外全仓生成或本机 AW tests/typecheck/build/services/E2E。实际根、其余 Task/Node、child/boot、19 owner/三 roots、H7/A-T7/A-G 与 CS M0～M4 仍开放；AW 尚未部署 CS。

## 2026-10-09 W2-P 精确发布与验证接线

2675701af71c7905ab75dce1a41e8cefe1c34393 已将通过独立源码及配套门的 22 个文件正常推送 main；远端精确 0/0、共享 index 为空，原完整文档前缀和所有冻结材料保持。新测试源码已在 main，每 provider 21 个用例仍待新 SHA hosted CI 验收。

本普通后继只退役 4 个已随源码消费的 allowGrowth，保留完整 129 项有序库存、实测 baseline、全部 why、canonicalProjection/sourceDigest 和原 provenance 锚点，仅按原 5 个纯 JSON 函数重算 contentDigest；另在 Windows 的 push/PR 两处路径过滤与原平台测试命令各加入一次已上库的新测试。移除这 3 个新引用可整字节还原原完整 workflow，所有并行接线及断言保留。原 6 个 TS 与其余 12 份架构配套保持，无第二次 census 或本机 AW tests/typecheck/build/services/E2E。有限后继独立门、精确发布及新 SHA 主/Windows 总流水线各自验收；H7/A-T7/A-G 和 CS M0～M4 仍开放，AW 尚未部署 CS。

## 2026-10-09 W2-P hosted 类型修复

Windows 37830372844 在 2675701af71c7905ab75dce1a41e8cefe1c34393 的 Typecheck 确认两处 TS2769：matcher 的其他 Task 原始快照和原 selection session 变量可空。仅在原分支中增加显式 undefined 拒绝，保留原快照/对象身份 matcher、14 个定义、21 个用例/provider、全部 107 个 expect 与完整原业务体；5 个生产 TS 及原 13 架构/status 输出保持，没有再次 census 或本机 AW 执行。原失败保留，新 SHA 主/Windows 总绿另验。

d5cc90f476ade1f7bd971918f2ff72da54b834d6 已精确发布四项已消费增长退役和 Windows 两路径过滤/一原命令登记；独立有限门的 41 项完整绑定与分析已实际消费，远端精确同步且共享 index 为空。此次类型修复仍需自己的有限源码门、精确发布与 hosted 运行证据；其余 Task/Node/真实根、H7/A-T7/A-G 和 CS M0～M4 开放，AW 尚未部署 CS。

### W2-P 总流水线修绿后恢复 RFC（2026-10-09）

39393abbdd0d9d9d33efbf8dd5bdab39bc926245 的主 run 37834573995 全 72/72 作业成功、Windows run 37834574026 成功，Windows Typecheck 与平台套件通过；原始两 run/两 jobs API 的完整 EOF/bytes/SHA 及确切 main SHA 已由 root 实际消费。总绿前暂停后续 RFC 的门槛现在满足，原 2675701a/d5cc90f4 TS2769 失败历史保留。Ubuntu job 113508208876 新投影 SQLite/PostgreSQL 各 21 例、macOS job 113508209036 SQLite 21 例、Windows job 113508205993 SQLite 21 例全部通过，三个原完整 group 与每个实际 case 已核对；无本机 AW 执行或重复 census。

W2-P 的有限 adapter/工厂与回归交付验收完成。下一步 C2-W2-N 先独立设计 preparation/issuedResults Node 目的视图、保留原完整 native 方法及缺省装配，再分批明确真实 caller 依赖。工厂支持不代签 caller/三个根/十九 capability owners；完整 H7、A-T7/A-G 与 M0～M4 仍开放，AW 未部署 CS。阶段 B 仍按各层独立 CS adapter、必要先行、M0 先部署再收编后续能力执行。

### C2-W2-N N1：独立 Node 目的视图源码候选（2026-10-09）

原 DESIGN4-R1 39 项有效稳定 PASS，root 完整消费 14 个功能分析字段与首末实际 EOF 绑定；未推进 N2 实际 caller。新增 Task-only 目的端口/独立 native adapter，原 Task aggregate 只在显式 hostWrites 下增加 nodeWritePurposes；原完整 native nodeRuns/nodeExecution、默认装配和原 recovery 保持，两个既有文件的全字节逆向成立。共享 1c624ba2 仅改 RFC-371 文档，原设计 candidate 内容不变。五个源码候选和原双 provider Node 合同/测试各自冻结验收。

新套件 15 个定义/49 案例每 provider/162 个静态 expects，使用原真实共享 installation、两真实 Task、claim/token/work 与原 native SQL，覆盖完整两目的写族/上下文/receiver/事务回滚重试/错误优先与纯读空输入；只给三个新增多操作案例 15_000 预算，所有旧断言和预算保持。静态格式/lint/纯 AST/字节证明不代签执行；SOURCE9、一次原 census、matching、精确上库、Windows 后继登记和新 hosted CI 依序完成。完整 H7/A-T7/A-G、实际 callers/十九 owners/三 roots 和 CS M0～M4 未闭合。

## N1 SOURCE9-R1 功能失败与最小夹具修正

独立 SOURCE9-R1 首末实际 EOF 的 50 项有效稳定 FAIL 已由 root 完整消费全部 16 个功能分析字段；原正式回执 526619 bytes、SHA256 74e09fdadd6621472108f9eb8c8cb37a9e6fb1229a9a4a279413fe91b001614e 保留。唯一 N1-P2-001：同库 draining 用例逐轮重复 prepare 原单一 installation，第二轮在原非 closed 拒绝处失败，后七项 Node 写入断言不可达。另列两个原 prepare 合同的 10285 bytes 首末实际 EOF 已核对，原 50 人口/FP 保持。

修正复用一次真实受理的 fixture，先 lose，再循环原八写；每轮清零同一消费计数，真实 SQL 全行 before/after、BEGIN/ROLLBACK、原 work/lease 断言逐轮保持。其余测试全文精确逆向复原原候选，全部 15 定义、49 案例每 provider、162 静态 expects 和三个新增 15000 预算保持；四 production 和原 controls 不变。三个文档只追加，全部共享历史保留。SOURCE9-R2 独立重审、唯一原 census、配套门和 exact-SHA 全仓 main/Windows CI 仍待验收；尚未本机执行 AW 或新 census，N2/H7/A-G/CS 部署未签。

## N1 原生成、配套增量与发布边界

SOURCE9-R2 独立有效稳定 PASS、0 findings 已由 root 实际消费全部 56 项首末 EOF 绑定和完整 9 个功能分析字段；原 SOURCE9-R1 的唯一夹具 P2、正式 FAIL 及其消费记录保留。15 个定义/每 provider 49 个案例/162 静态 expects 和全部预算保持，新用例仍须 hosted 执行。四生产文件及六实际 caller、所有旧 Node/provider 回归保持。

唯一一次原 scoped census 固定 2b1e93de995870076b160198e26eb845271711af，使用 5 个冻结 TS 输入（4 production）和 6786 个非本批已提交 source blob；四原规则逐字保持，13 完整原始输出保留，sourceDigest sha256:58fa16d2d8fc8b91f284758859b5bc2b22ae5d6adb555cefcdd4ea95b2469d5d。两新增 Task application/infrastructure 文件实测增加 5 owner、1 factory 和 1 个 erased database-adapter type import；四实际生产输入 classic inbound/outbound 均为 0→0，原全仓 SCC/边界、356 条 authored debt、所有旧 why 与完整业务 payload 保持。

129 项有序账本仅配套四项实测增长：rfc294-mutation-entrypoints 1981→1982, rfc294-cross-context-observed-imports 6888→6889, rfc294-architecture-exceptions 6032→6033, rfc294-module-symbol-owners 27697→27702。原四个纯治理/JSON emission 先完整复现原始输出，再给四项一次性声明；源码发布消费后以普通后继退役。全部八份 canonical 和另三份治理的完整原输出保持，status 使用原 renderer 的完整 9215 bytes，不作全文件格式归一；本批真实指标变化同步于原始渲染。

配套 MATCHING16 门、精确 22 路径发布、普通声明退役与已上库测试的 Windows 三处登记、新 exact-SHA main/Windows 全绿逐项验收。没有新增整仓 census 或本机 AW tests/typecheck/build/services/E2E。N2 实际 Node caller、其余 Task/child/boot 分类、十九 owners/三 roots、完整 H7/A-T7/A-G 与 CS M0～M4 继续开放，AW 尚未部署 CS。三个文档只追加，全部共享和并行内容保留。

## 2026-10-09 N1 精确源码发布与 Windows 验证接线

cee3853bffdfafc61d9ea08a3b8f63aa6b59a744 已将独立 SOURCE9-R2 与 MATCHING16-R1 有效稳定 PASS 的22个文件正常推送 main；root完整消费正式材料、全部分析，远端0/0、空index及并行内容保留。新49/provider测试源码已上库，本普通后继后等待新SHA main/Windows总绿及实际案例验收。原R1夹具FAIL和修正继续保留。

本后继只退役随源码消费的四个allowGrowth，完整129有序库存、baseline、所有why、canonicalProjection/sourceDigest及原provenance锚点保持，原五纯JSON函数只重算contentDigest。Windows两处push/PR过滤和原平台命令加入已上库Node新测试（三引用），并在两过滤分别加入本N1三个尚未受监测的生产路径（六引用）；原composition路径已有两处保留。移除九新增引用可全字节还原完整原workflow，所有旧命令、并行接线、断言和预算保持。三个文档只追加，全部旧正文保留；另18已发布路径不变，无新census或本机AW tests/typecheck/build/services/E2E。独立后继功能门、精确发布及新SHA hosted总绿逐项验收；N2实际caller、H7/A-T7/A-G/十九owners/三roots、CS M0～M4继续，AW未部署CS。

## 2026-10-09 N1 hosted TS2339 最小测试修复

cee3853b 原 main run 37854363636 的 Lint + Typecheck 作业、Windows run 37854363696 的 Typecheck 均实际报同一 TS2339：新 Node 目的测试第616行，按 purpose 索引后的 union 别名不能随 purpose 分支缩窄。原错误日志和 failure 历史完整保留；此事实不能签总绿。

此前 RETIREMENT-WINDOWS5-R1 对43项首末真实EOF的独立有效稳定PASS、0 findings已由root完整消费。本次必要修复仅保留原一次 traceNative 返回值为 purposeViews，原八操作继续选择 purposeViews[purpose]，原 preparation 分支的 mint 明确使用同对象的 purposeViews.preparation.nodeRuns。未加 cast、跳过分支、删断言或改预算；移除一条局部绑定及还原 mint 接收对象可全字节恢复原42933-byte测试，15定义/每provider49例/162静态expects/三个新增15000预算保持。四生产和旧原端口、已退休 ledger 与 Windows 九处接线保持，不重复 census 或本机AW执行。测试及三个历史追加文档再经有限独立功能门，与前次5-path门组合为最终6路径普通后继，精确推送后以新SHA main/Windows总绿及实际49例逐项验收。N2/H7/A-T7/A-G/CS M0～M4继续开放，AW未部署CS。
