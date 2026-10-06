# RFC-370 Task 执行族的真实根选择

状态：阶段 A 的 A5／A8 设计候选，待独立功能设计门。实施和上库已获授权；本片补齐真实装配，不实施 CS adapter，也不关闭完整 A-G。

现有 Task Agent 和 script 已各自拥有完整中立执行族，但 SQLite daemon、PostgreSQL daemon 和独立 server 都直接选择 local 工厂。共同运行时参与者还引用 `LocalTaskAgentRunFamilyBinding`。因此替换测试可证明共同 policy 使用所选族，却还不能从实际启动入参替换这两种族。prompt／archive 内容已有独立所选合同，新的装配必须沿用同一实例，不能另开内容存储。

本片增加 Task-owned 的完整 run selection。它包含 root 共享的 `NodeRunPromptOperations`、`PortArtifactOperations`，以及每次 drive 重新绑定的 Agent／script 族。只允许整体选择；显式所选件缺少任何必需成员时，在效果启动前报装配错误，不从 native 工厂补成员。未选择时，由独立 local composition 保留现有四个绑定和原调用次序。

新的 application 合同表达内容 namespace、运行配置引用和现有 owner-owned 业务依赖。运行配置引用由装配的实现创建并解释；公共 standalone drive 的 `appHome`、`binaryOverride`、`configPath` 兼容词汇在 bootstrap／local bridge 转换，不搬入 application 合同，也不把原 `Local…Binding` 原名改掉便视为中立化。共同运行时只取得所选完整族和 opaque 引用，不解析宿主路径、binary 或 CS DTO。

三个真实入口都增加同一个 exact composition 选择入口，daemon 初装、provider 重装和 server 复用均透传同一选择。原未选分支保持 lazy 读取及每个 drive 的绑定时点；所选分支保留 method receiver、同步 throw 和原错误对象。不在启动时提前冻结原来每 drive 或每 mint 才读取的配置。共同 provider runtime 保持原 SQLite／PostgreSQL ownership、activity、stop 和 child lifecycle 绑定。

一次有效 drive 取得四个完整绑定，然后执行原共同 Task policy。root、call child、resume、retry、fan-out 和动态 workflow 的每次有效 drive 都重新绑定 Agent／script，不能把族、receiver、promise 或 opaque 配置引用序列化进 `INHERITABLE_RUN_CONFIG_KEYS`。根级 prompt／archive reader 和实际执行写入必须使用同一内容选择；已有独立内容 effects 入参在未选分支保持，不以仅执行侧选择制造读取失配。

实际 `taskEngineApplication` 仍直接调用 native workspace exclude binding，并以 `Paths.root` 补宿主目录。该效果同步纳入本片：source-control 已有 `WorkspaceExcludeParticipant.ensure` 和原 receipt，补精确所选 binding 工厂，native 实现复用原完整正文。Task 保留多仓顺序、`exclusionPlanFor`、版本／digest 判据、原 persistence 更新、execution context、错误分类与停止后续仓库的规则。等待 `ensure` ACK 后才更新相应 repo profile；失败仍形成原 `workspace-exclude-profile-failed` 事实。CS 翻译和 task 工作卷留阶段 B。

现有公开 standalone runtime／resume DTO、合法的 config 旋钮及继承清单保持兼容；application 不再据这些兼容值调用物理效果。default adapter 保留每个原输入在原效果边界的取值，不做全局替换或扩张可用能力。其它 purpose 命令、H7 authority／早期恢复及其余 A8 根仍按原 RFC 收口。

实施涉及 Task 新合同和 exact composition、独立 local selection、共同 runtime participants／provider runtime、三个实际根及 SC workspace exclude 合同和 local 接线。原 Agent／script policy、两种 Runtime 协议、原四类内容回归和 workspace profile 状态机作为完整受控正文；仅真实接线断言随迁位更新，不缩减原 assertions 或预算。

新增双 provider 功能回归覆盖实际入口透传完整所选件、四个 reader／writer 与 receiver 一致、root／child 每次绑定、held bind／profile ACK、显式缺成员拒绝且无 local fallback、绑定或 profile 失败保留原错误／业务事实、default 原序列与旧 native override。Windows 加入实际新增路径和 suites，原 workflow 其它全文保持。

验证顺序为独立设计门、源码和功能回归、独立实现门、最终生产候选的一次原 matching census、元数据门、精确上库及 hosted exact-SHA CI。只做自有格式／lint 与纯源码／AST／JSON 对拍，不运行本机 AW tests／typecheck／build／service。全部原规则、库存／why、guard 语义和并行内容保持；这份设计不签实际运行、完整 A-G 或 AW-in-CS 部署。
