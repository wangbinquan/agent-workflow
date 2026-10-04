# RFC-371 完整执行事实、缺口 Task 和维度明细验证

本批对应用户所见“完整统计尚未就绪”后整页消失，以及维度数字缺少实际原 Task 下钻。原 EOF 报告独立核对 Task/attempt 人口后保留执行事实；用量缺口不成为零值，不将部分 Token 或金额升级为完整总量。质量列表由同 snapshot 的原 Task fold 产生，不设总体数量上限。

批准设计：`usage-gaps-and-tasks.md`，DESIGN1 指纹 `2b79b0744b345d4fda4cc50471c58c97240b703e95e16fe39976aa92058cd0f8`、独立 PASS `d6cf39c393b6dcade261d5a2bbcbd02e9b912b0a8ab0021ac8bb5e52292d7d61`。SOURCE16 原三 P2/FAIL 保存于私有回执，不覆盖；SOURCE18 v2 指纹 `1b0da7765f458c585651d97f0a913a72333f7eb8d9329e5d441d7e2f2920fc08`，独立 PASS `7de1d84282f8263f978090fc692bb750903dfe6cf70d33c04c2c86103d3b7dde`，18候选、7直接控制、6引用与清单首尾稳定。

原质量索引有格式标记、原 reason/Task 父人口封存核对和同 report/snapshot 分页；旧无索引、页人口变化、未知 parent 均明确拒绝。显示真实缺口原因的对应 Task 列表，使用共享 Card/Dialog/Pager；关闭或 Task 返回仍在原父维度/质量页面和焦点。Task 名称维持任务列表样式。实际 Task 总量不与维度贡献混算。模型、注册配置、受理名称、协议和人民币资格来自原冻结数据。

新增 backend 回归使用真实 SQLite/PostgreSQL harness：202 Task 中201缺口任务，按37条传输逐页到 EOF，核对全体原 ID、父计数与未知值；随后删除旧报告的质量索引标记并验证直接 API 拒绝。旧 facts UI 回归全部保持，新 zh/en 单页/最后页质量 Task 下钻、真正鼠标触发焦点及新维度 Dialog 回归交 hosted CI。没有运行 AW 本机测试、类型检查、构建或服务；本机 scoped ESLint/Prettier 均退出0。

原官方静态 census 一次，固定已发布 b6195a0 加18个候选，不把外部 WIP 当生成输入。13产物、production2958、原129库存和原 canonical validator通过。仅 owner/root 净增8（26449→26457）；原可枚举规则、40 required SPI、69 target edges、302条原债务及公开面/mutation规则不变；唯一一次增长许可需在匹配提交后正常退役。原 SOURCE10 native owner 页/持久 ACK 基础仍单列待装配，不在本批发布或完成宣称内。

当前 live AW 原报告425 Task/2869 attempt/14 accepted invocation，缺口 reason 数334/1/1相互可能重叠。该诊断只证明旧 live API 人口与未就绪原因；不能用本批 fixture 或静态 PASS 声称已恢复真实 Token。必须继续 native producer/原历史上限清除与正式任务四桶/CNY核对，100K Task/10M usage、所有普通/Windows/定时 exact-SHA CI 和正式浏览器也未完成。

## 2f7 新确切 CI 的测试 API 与完整弹窗登记修正

2f7c3b672dd8007849348bffe05a95fef7703457 已发布34路径；主CI37172781557尚在运行，但静态job111349000064和frontend Ubuntu/Mac/Windows第三分片111349000141/177/225已明确失败，完整原日志保留。不把未终态workflow、有限SOURCE/META PASS或其它已完成job升格为全绿。

三处实际失败只涉及本批测试：ByRoleOptions不支持exact字段（字符串name原默认精确匹配保持）；本仓未装配toBeDisabled Chai扩展（改核原HTMLButtonElement.disabled===true，分页/前页/首页原断言和预算保持）；RFC-198原双向严格AST清单漏列新增dimension及迁出的quality Dialog，同时旧root Dialog已迁出。只将旧CompleteRunObservability一项移到真实Quality并登记真实Dimension，原95调用文件变96，其它原登记与3个scanner函数字节保持。

原scanner/相同完整frontend/src语料的纯AST对拍与实际96登记完全相等，两测试完整原文逆向核对只包含上述精确编辑；没有导入/执行任何Vitest或Bun用例，没有本机AW test/typecheck/build/service。目标format/lint已通过，production18源码及原13canonical未因这些测试修正重开或重跑census。新精确SHA hosted验证仍待，旧四job失败和原所有FAIL/cancelled保留。真实浏览器、E2E旧运输合同迁移、native实际owner/ACK/历史caps、Token/CNY真实任务、CS部署和规模验收继续，两RFC In Progress。

## 2026-10-04 RFC-371 恢复独立完整任务的实际用量

同一本机原数据库、原 daemon 和七天范围实际有8个任务、28次尝试、14次受理调用。旧全范围缺口遮罩误把7个独立完整任务的指标一并隐藏；本批只恢复普通Task的原完整fold资格，保留一个历史Task的真实缺口和全范围未知。四页到EOF的8个Task身份与原人口一致，7个Task的四桶Token及人民币估值逐字等于各自独立生命周期报告，没有把已知7个的和冒充完整总量。

实际服务首次报告因原文件spool的旧child指标条件失败；此回执保留。生产spool增加相同的普通Task例外，cache资格升级task-scope-metrics/2，原immutable缓存及失败报告不改。双provider新增回归使用真实文件spool，含混合完整/缺采集Task、全范围未知、原四桶/CNY、分页EOF、独立生命周期对拍和损坏存储拒绝；原测试及预算保持。中英文提示准确描述各范围资格。源码功能检视与hosted CI、实际页面验收分别记录，不能相互替代。

官方纯静态census基线fc688a54加本批7候选，保留并排除其他会话及native owner在制品，13原产物/129原库存验证通过，无新增增长许可，原规则与完整封印/publish/读取核验保持。未在本机运行AW测试、类型检查、构建或启动/替换服务；实际API由原已运行daemon验证。浏览器工具尚不能读取AW实际页，本批新确切SHA CI待发布；旧CI失败与未完成native采集/历史caps/真实任务和规模验收仍保留，RFC保持In Progress。


### 2026-10-04 原 SPA 缓存资格补正

服务requestKey已升级时，页面仍可能凭旧query/retainedIds读取旧reportId；client两个键同时采用task-scope-metrics/2，旧immutable报告和原cache保留。新增真实QueryClient缓存回归及SOURCE2-META1有限检视PASS，原13产物只digest/provenance变化、129库存无增长。实际既有Vite5174已提供新模块；浏览器停在开发SSO，管理员登录待明确授权，因此源码/API回执不能当作正式页面验收或hosted测试通过。旧失败与完整native/规模未完成结论全部保持。
