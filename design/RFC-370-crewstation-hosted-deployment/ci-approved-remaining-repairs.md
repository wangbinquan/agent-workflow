# 已批准的三组 CI 修复

用户在 2026-10-14 明确批准接手临时预览中的三组已归因缺陷、必要生成配套及当前任务内一次只读功能审阅。该授权是 AGENTS 第 4 条的限定例外；统计性能在制实现、未知归属的运行超时和其他功能不在接手范围。仍在原共享 main 开发，无跨 session 消息。

## 原因与修复

确切 `829e67d54` 的主 CI `38491705813` 是失败依据。本会话过期增长声明已经单独发布为 `0292aedd7`；并发 `ec08bc7ce` 已修复原 JSON 测试的异步快照回调类型，完整保留该修复。

- 原 JSON 路径：job `115618173315` 在 PostgreSQL 的非法绑定文本 `{` 上抛 `22P02`。两个现有路径方法的合法性判据参数也显式转 TEXT，与原 THEN 的 TEXT→JSONB 解码一致；原嵌套 CASE、数组和字符串语义保持。原双 provider 测试新增绑定文本／真实 TEXT 列、plain client／snapshot transaction 的非法、缺失、null、标量和错误成员类型对照，仍要求原 NULL 结果。没有改变 jsonMemberText。
- 原 dev reload：job `115618173420` 的原 T19c 两项断言发现 main 的 start 分支有两个调用点。现在普通启动和原 reload 回调共享同一 `start` 函数，唯一调用仍在原 case 内，保留端口／地址、原 generation 合流、排空和错误语义。dev.ts 作为实际 host 装配根登记；原类型经已有 SO composition 入口透出，新增 dev 正向覆盖，保留普通 business consumer 负向控制及原严格调用点守卫。
- 当前员工包夹具：`651f956df` 正式将包从 revision 10 升为 11，原运行夹具未同步。两处后端运行用例从同一个已安装 descriptor 的 typeRef 取值；正式注册接口只公开 descriptorJson，因此复用原 descriptor parser，不新增生产字段。并发的两份浏览器夹具和列表 seed 已明确绑定当前 @11，完整保留其原修改及所有行为断言；同文件中手造历史 Case 的 revision 10 保持。

## 集中验证与发布

本轮全部生产和回归用例编写完成后，才进入集中诊断和一次只读功能审阅。使用原 JSON 真 provider harness、原 dev reload／CLI 用例、原 T19c、真实根边界、原员工运行与列表用例；不增加超时、删断言或以重试通过代替原因修复。没有配置本地 PostgreSQL URL时，SQLite 定向诊断必须明确记录其边界，真正 PostgreSQL 结果以新提交 GitHub 对应 job 为准。

源码按明确路径发布，再从实际已提交 source-ref 用原算法生成配套，保留所有已提交并发祖先与共享文件完整内容。新源码和配套的精确 SHA、远端同步及 GitHub 全 CI 分别验收；旧失败不追记为通过。完整阶段 A 的既有功能门结论保留，本次有限审阅不代签总 CI 或 A-G。B/M0 仍待总绿，AW 尚未部署 CS。

## 已完成的集中诊断与有限审阅

五份原功能测试在显式 SQLite harness 下合计 25 pass／0 fail，含两个真实 CLI hot reload 用例；原 T19c 和五根边界两文件 27 pass／0 fail。backend Typecheck（8 GiB Node 堆）exit 0，限定 ESLint exit 0，格式／diff 检查通过。没有本地 PostgreSQL URL，因此这些结果不替代 PG 实测或完整 E2E。

用户批准的当前任务只读功能子代理审阅完整 15 路径，15/15 SHA-256 与候选一致，PASS／0 findings。审阅确认普通／hot 调用参数、原 reload lifetime、两个 JSON 方法的所有参数位置、当前 descriptor 夹具及历史 Case 区分。没有运行测试／服务或联系其他 session；后续文档只增本结果记录。必要生成配套及新确切 SHA 的主 CI／完整 Windows 仍分别验收。

## 必要配套中的已选快照计数修复

源码 `655181228` 已提交并完整保留三份并发夹具，随后并发 `1ccc07525` 保留在 main。首轮原生成没有发布：其 report.moduleContexts 仍走 live moduleShapes，把原 source-ref 外的新文件计为 185，而该已选 Git 人口是 184。这个 committed-source 输入遗漏属于本会话原生成能力；首轮产物留为无效证据，不代签一致。

报表现在从同一选定 backend corpus 汇总 context 文件数；普通模式仍读取完整 live backendUnits，显式 source-ref 则只计原 Git 输入。原 moduleShapes 的形状规则、其余采数和并发文件保持。新增回归用真实完整 Git 输入和从不创建的不存在目录构建，逐 context 与总人口对账，明确不依赖文件系统副本。原 Git 读取与新增报告回归 2 pass／0 fail，限定 lint／格式通过；同一获批功能门对这两文件必要续审 PASS／0 findings。先前 25／27 项有效结果沿用。修复实际提交后重新生成本会话尚未发布的配套，全部 130 条 ledger、原预算和共享输出继续保留。

新回归直接消费原生成器后，原 corpus 守卫要求可追溯的显式下限。追加对其实际唯一生产文件集合 >1000 的断言，保留原全部人口与结果预言；未改扫描器、预算或豁免表。原下限守卫定向通过。修正后的八份 canonical 输出、四份 provenance 和 status 已逐项相等；130 条 ledger 的完整字段／顺序相同，无 allowGrowth。最初对全部生成文档做的额外 Prettier 检查涉及不在仓内 format:check 范围的原 status renderer 输出，因此保持原生成字节和严格投影，不为这个范围外诊断改渲染器。

## 真实 PostgreSQL 暴露的转换位置遗漏

已发布 `b65259b76` 的主 CI `38500169461`：质量作业 `115644984389` 和真实 PostgreSQL 集成作业 `115644984360` 成功，但 Ubuntu 20 的 JSON 专项 `115644984841` 仍有两项 `22P02`。前轮 SQLite 通过没有覆盖此处，原参数 TEXT 化不是完整修复，不追记为 PG 通过。

PostgreSQL 可在规划阶段折叠 CASE 分支中的常量转换，外层合法性判据不能保证那个 `::jsonb` 不会提前执行。两个原路径方法现在先由 CASE 返回有效 TEXT 或 SQL NULL，再对整个 CASE 结果转 JSONB；字符串／数组类型筛选与取值仍走原路径操作。保留全部绑定文本、真实 TEXT 列和 plain／snapshot 回归，增加静态非法字面量、空文本和 SQL NULL 的双引擎回归。没有改变 jsonMemberText、扫描器、断言或超时。实现和用例完整后集中复验，真实双引擎诊断及新确切 SHA 总 CI 另行记录；统计成员修复仍归原负责会话，A-G 未签，B/M0 未开始。

集中诊断使用已有 PostgreSQL 17 镜像新建本任务专属临时容器，原双 provider harness 全部 12 项通过（SQLite 6、真实 PostgreSQL 17.11 6，82 条断言）；容器随后正常删除，没有复用业务数据库。限定 ESLint、Prettier 和 diff 检查通过。同一次获批功能审阅对这两文件续审 PASS／0 findings、2/2 hash 相等；这是新转换位置的结论，替代旧仅 TEXT 化的静态结论，不代签 hosted 总绿。并发统计源码 `e75934269` 及配套 `32885dc45` 已由原负责会话发布，完整保留为祖先；本轮修复和必要配套随后精确发布并验收新确切 SHA。
