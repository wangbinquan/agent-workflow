# RFC-370 Task 真实根选择实现候选

D1 设计门已有效稳定 PASS，29项完整绑定／首末FP `96878072089ab3f26c15528dfbd2e7ab6c79e1023a1ef53ec817377b180bfff4`。原设计候选全文保留，本片只实现该有限切面，不关闭完整 Stage A 或 A-G。

Task-owned application 合同只承载内容 namespace、运行配置 opaque 引用、task／execution context／signal 和原 owner-owned 依赖。三个实际根显式整体选择，HTTP reader 与 drive writer 共用同一内容实例，每次 drive 重新绑定 Agent／script。共同运行时不再引用 LocalTaskAgentRunFamilyBinding；legacy appHome／binary／config 只在 bootstrap／local bridge 保持原输入和惰性读法。原4工厂同步次序保留，所选异步 binding 先等 Agent 再 script，绑定失败传原 Error；没有 per-member native 补齐。

Task 原 workspace exclude 效果通过 source-control-owned 完整 factory／participant 选择，native 复用原正文。多仓顺序、directChildMounts、profile版本／digest 判据、owner context、persistence ACK、失败事实和停止后续仓库仍属于原 Task policy；native home 在原 per-repo binding 时点读取。

新3 suites覆盖完整选择／缺成员／receiver／引用／sync lazy／async ACK／原 Error、真实双provider HTTP root 重装后的 prompt 与 archive 内容、真实双provider root／已持久化 child／后续 drive 重新绑定，以及多仓 profile ACK与原失败事实。child 案例直接播种已关联子任务，再经同一真实 scheduler driver，并不把它记成实际 call-workflow 铸造端到端验收。原 child lifecycle／call-workflow suites 全文保留，完整 M1 子任务业务验收仍须后续 hosted／CS 验证。Windows只追加新增路径和3 suites，原其它全文字节逆变换保持。

纯源码证明：三个完整 Root SourceFile AST 移除精确新增切面后与原文完全相等；实际 Task engine 三个精确跨度逆变换后全文 byte相等；15份未改生产控制全文保持。旧5测试文件的cases／expect／预算分别保持5／17、7／53、14／85、10／91、10／75，所有预算不变。原 W29 PG body176 statements／摘要9130fad6…、SQLite55／9e66815e…保持，不更新旧hash或收缩旧断言。24个自有TS格式／lint通过，没有本机 AW tests／typecheck／build／service。

下一步有限独立实现门、最终生产候选一次原scoped matching census、元数据门、精确发布及hosted exact-SHA CI。已知旧67c1839d主run的CI清单与引用失败由独立小片修复，原失败不倒写。本片尚未实际运行验收；CS adapter未编写，AW未部署CS，purpose9操作与H7早期恢复／authority仍开放。

SOURCE27-R1 是有效稳定 FAIL，仅一项 legacy receiver P2，首末 FP `54e79566eef76b9fd7f30b9d684f41b86a537f98c43b9d5a06af37428c07621c`；原回执与冻结正文保留。R2 将已完整装配的 provider input 原对象交给 local bridge，同一个对象补原默认内容工厂和完整 binding，并交共同参与者；四个旧回调每次 drive 仍以该完整对象为 receiver，保留 db／persistence／lifecycle／activity／stop／运行时 owner 和彼此的工厂引用。新增真实双 provider 回归分别覆盖默认内容工厂与四个显式工厂，根任务及已持久化 child 均验证 receiver 稳定及 profile 持久化。没有导入 native bridge 到共同基础设施。

CI 修复片已独立 PASS并精确发布为 `717b8610e0b3c2d0920b34cd7b4bdb8d75718918`，发布后 main／origin 为0／0、index为空；本 Task 候选当时未入提交。新主 run 37523493598 尚无终态，本修复不宣称 CI 绿或部署完成。
