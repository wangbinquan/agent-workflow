# RFC-625 第二批 CI 优化验收

本批实现、测试、功能检视与完整托管 CI 已完成。最终证据是包含本轮全部代码和权重的立即后继 `033f5fafe76a93b3eee31583104b22c8f1e6bbb8`：[主 CI 45986840401](https://github.com/wangbinquan/agent-workflow/actions/runs/45986840401)，首次 workflow attempt，**69/69 作业成功**。这不是最终权重提交 `5f46ad9` 自身的全绿结论：该提交的失败完整保留在下文。

**结果是部分性能目标改善，整体周转未改善。** 相对第一批基线，Q3 累计成本减少11.0%、原最慢 V2 文件池减少54.7%、最慢后端作业缩短55秒；但后端P95上升、总runner运行区间之和略增，整轮墙钟增至3小时07分48秒。尚不能宣称 CI 稳定性已经根治。

## 1. 实现与覆盖

- Windows 锁首行继续保留PID，版本化owner增加acquisition token及可用的精确64位进程创建身份。同PID、同创建身份的活owner仍独占；明确不同创建身份或已退出才可判旧owner失效；unknown及旧PID-only活owner保守处理。watch和自动升级接管产生新token，旧lease迟到释放不能删除新owner。Windows身份查询使用同一handle并在所有分支关闭；默认API为不可变绑定。stop/status/恢复等消费者保持兼容。
- 新增真实Windows回归和恢复诊断。历史PID7256事故缺少创建身份，**不能追溯断定它就是PID复用，也不能宣称重现并根治了那次事故**。本轮验证的是进程实例区分机制与当前实际恢复行为。
- Q3/V2的完整SupportedSourceManifest在现有job临时目录内复用，保留原builder、每次frozen admission、完整输入身份、整个prepare的90秒截止及迟到发布防护；每次反序列化得到独立数据图，保留图内引用关系。禁用缓存直接走原builder，不缓存数据库、连接、reader或daemon。
- 原Q3十一文件、88项定义case及V2十四文件保持；原人工门三条case与kill/restart顺序保持。source每例独立数据库；target保持原流程：SQLite每例新文件，PostgreSQL在describe内复用物理库但每例重开runtime并重置两个schema，再真实安装。原reader/查询取消/清理与数据、恢复、幂等断言保留。Q3的服务reopen故障恢复不等于OS进程SIGKILL测试。
- 新增后端身份15项、缓存16项、真实双provider manifest8项，以及前端诊断1项。非Windows上的4个native条件skip在真实Windows另行执行。原测试文件没有删除；全后端3130→3135中的另两个新增文件分别属于并发自动升级提示及MR事实重采，不计作本RFC贡献。
- 后端仍44片、每片15分钟，保留`--isolate`、`--randomize`、LCOV采集与原Codecov上传配置、真实PostgreSQL；E2E仍3/3/4片、20分钟、4 workers、retry 1；人工门每case150秒；13组required及聚合门保持。Codecov上传原有`fail_ci_if_error: false`未变；不把69个绿色job等同于额外的数值覆盖率门验收。

## 2. 精确验证来源

| 来源 | 实际结论及用途 |
|---|---|
| `240ee338` / [45939395356](https://github.com/wangbinquan/agent-workflow/actions/runs/45939395356) | 第一批完整基线，69/69成功；Windows人工门一条failed0→passed1 |
| `19ef280` / [Windows 45965073715](https://github.com/wangbinquan/agent-workflow/actions/runs/45965073715) | 平台workflow成功；[身份/锁job](https://github.com/wangbinquan/agent-workflow/actions/runs/45965073715/job/140391705913)实际23pass、0fail、0skip，其中4项Windows native全部执行；同SHA主CI的Windows编译job实际通过production/E2E二进制version smoke |
| `3aa7b03` / [45966117958](https://github.com/wangbinquan/agent-workflow/actions/runs/45966117958) | 权重末次校正前的完整69/69成功，44份backend raw和10份E2E报告完整，E2E零retry |
| `5f46ad9` / [45986712955](https://github.com/wangbinquan/agent-workflow/actions/runs/45986712955) | 最终权重提交自身failure：66success、2failure、1cancelled；不作为全绿或完整后端成本样本 |
| `033f5fa` / [45986840401](https://github.com/wangbinquan/agent-workflow/actions/runs/45986840401) | 本来已触发的立即后继，69/69成功、44后端片成功、3135文件完整测量；13个工作输出与FULL_CI_RESULT均实际success |

本任务29份代码/测试/workflow/权重在`5f→033`逐字节相同；`033`另包含developmentMrFacts修复及一份六case回归，两份文档也改变。比较单列并发测试与既有RFC508直接消费方，不能描述成全仓源码不变的隔离实验。Windows原生证据仍属于精确`19ef`，通过未变的身份/锁实现绑定复用，不冒充在033又跑过原生workflow。本任务未dispatch或rerun任何主CI。

最终[计时collector 46013203493](https://github.com/wangbinquan/agent-workflow/actions/runs/46013203493)成功，artifact `reviewed-ci-timings-45986840401`（ID15205735022，digest `d06c7381864d5a28d0345b3b143a15813e0948ffba85551ebcaa876d93e42e11`）明确指向source033。collector自身head为`ff85fa785b5e163c17c518763e557a3cdaeeac35`，不是测量源。

## 3. 实际耗时：保留两组完整对照

整文件成本包含导入、hooks、case和清理；单位为秒，各池相互包含，不能相加。

| 指标 | 基线240 | 校正前3aa | 最终后继033 | 033相对240 |
|---|---:|---:|---:|---:|
| Q3原11文件 | 992.055 | 923.637 | 882.905 | −11.0% |
| 原最慢V2的14文件 | 801.568 | 282.105 | 362.810 | −54.7% |
| 新增RFC625三文件 | 0 | 151.331 | 138.018 | 新成本全部计入 |
| RFC625去重关联池31→34文件 | 1814.296 | 1381.973 | 1403.792 | −22.6% |
| 全后端3130→3134→3135文件 | 23888.536 | 22819.369 | 23078.560 | −3.39% |

033新增三文件分别为identity0.076秒、cache17.894秒、native120.048秒；并发新增MR重采文件0.014秒。全后端累计减少809.976秒（13分29.976秒），不是单轮墙钟节省，也不能全部归因于RFC625。

| 后端44片指标（秒） | 基线240 | 校正前3aa | 最终后继033 |
|---|---:|---:|---:|
| 首真实step→job完成，中位 | 592.5 | 575.5 | 585.5 |
| 首真实step→job完成，P95 | 717.4 | 708.4 | 751.1 |
| 首真实step→job完成，最大 | 837 | 756 | 782 |
| test step，中位 / P95 / 最大 | 549.5 / 677 / 802 | 527.5 / 662.25 / 712 | 537.5 / 705.35 / 739 |

033最慢为shard35，13分02秒，距原15分钟预算约118秒。它比240缩短55秒，但比3aa增加26秒；P95比两组对照均差。**额外权重校正尚未证明能够继续降低实际尾部。** 不用模型预测替代这一负结果，也不根据样本选取较好的一组对照。

| 周转与资源区间 | 基线240 | 校正前3aa | 最终后继033 |
|---|---:|---:|---:|
| run创建→最后job完成 | 34分25秒 | 2小时10分48秒 | 3小时07分48秒 |
| 创建→首个实际工作step | 2秒 | 1小时17分30秒 | 2小时08分35秒 |
| 首工作step→最后工作job，含内部等待 | 34分18秒 | 50分36秒 | 55分55秒 |
| 最后工作完成→required首step | 3秒 | 2分40秒 | 3分15秒 |
| 全部job首step→job完成之和（分钟） | 559.200 | 552.583 | 561.850 |

等待包含workflow准入、依赖和runner分配，不能一律称纯macOS runner排队。最后一行不是CPU或计费分钟。最终墙钟与累计runner运行区间均未改善；等待期间的实证快照显示两条计算通道被前序运行占用，并有大量未分配runner的作业。本批没有改变通道数、取消前序运行或放宽门禁。

## 4. 前端、E2E与稳定性保留项

033六份前端日志每OS均897文件、7810pass；较240的7804增加6项，其中本RFC1项、并发RFC616五项。E2E原生计划与报告逐项匹配：Linux/macOS各471个最终passed及65个原expected skip，Windows465个最终passed及65个原expected skip；身份、文件和expectedStatus与基线相同，无缺失重复。

本轮调整PID首行读取的三个RFC319 CLI specs属于原`@nightly`范围，主CI继续按原配置排除；不能把主CI的69个绿色job说成这些nightly用例也已执行。CLI/身份相关的本地及Windows原生证据按各自来源记录，未减少原主CI人口或改变nightly门控。

**033不是零重试运行。** Linux的`rfc490-mindmap-guided-journey.spec.ts`有一条failed0→passed1；原retry1保持。collector按原标准跳过E2E权重刷新，未降低准入。Windows与macOS无retry，人工门三条在三个平台的九个结果全部passed/retry0；整文件跨度Linux88.422秒、macOS243.041秒、Windows110.341秒，跨度不是单case预算。此前3aa和5f的人工门九项也均首次通过。这些观测不证明长期flake率为零。

该Linux重试的实际日志定位到`:351`的`pickRootOnCanvas`：390→1024宽度切换后，canvas已可见且稳定，但Question outline header反复拦截点击，内层click耗尽15秒、外层toPass耗尽20秒；首次约30.0秒失败，原retry1约37.3秒通过。缺少失败坐标、布局几何与observer时序，camera/布局同步只是待证实推断。相关test/Canvas/Workspace/CSS源码未变，harness相对3aa/5f也未变，但这不足以排除所有间接影响；没有据此认定为daemon锁或runner根因，也未擅改该用例。

必须保留的失败：

- `81a78c2 / 45958038699`：63success/6failure。本轮四个后端守卫问题已补精确登记或真正删除可变API单例，保留原扫描器与28条例外上限；macOS focus两次240秒超时根因未知。原Windows平台run被后继请求取消，未执行的native不能计为通过。
- `19ef280 / 45965073732`：顶层cancelled，65success/3failure/1cancelled。并发71d原始interval引发两个后端片三个断言，由后继3aa改用既有平台定时器；本任务未代改。macOS第二片达到20分钟job预算，底层原因未明，原PID7256所在第二条human反而首次通过。后来的通过不能解释该历史失败。
- `5f46ad9 / 45986712955`：backend28的原staging-page-cost单case5119.83ms超过5000ms；直接代码和关键依赖未变，但新分配的间接资源/顺序影响不能排除，责任和底层原因仍未知。backend41的206文件全部结束，2116pass/4skip/0fail、881.46秒，随后触及15分钟job上限；201/206文件比3aa同文件普遍变慢，具体host/I/O/PG/GC/顺序原因不足以判定。新增cache16项约21.465秒全部通过，结束后又继续执行约284秒，未挂在该测试中。
- 5f只取得42份raw、2887/3134文件，缺247文件，整后端成本不完整；完整Q3池795.759秒和V2池297.239秒仅作局部观察。44作业中含失败/取消的最大912秒不能描述为成功分布。5f墙钟2小时35分58秒、初始等待1小时34分22秒均保留。

**033全绿不等于5f的两个超时已被修复。** 没有足够根因证据时未改其代码、断言、case/job预算或重试。下一轮稳定性工作仍需要定位原5秒用例的慢阶段和CPU密集守卫的整片成本波动；本批不以继续追跑或删除测试替代归因。

## 5. 权重来源与本地验证

初始权重为790/9cb/240三个完整绿色源的逐文件max；取得完整3aa后，末次更新采用9cb/45933650528、240/45939395356、3aa/45966117958，覆盖固定目标689be5398的3134文件。先前四个缺测文件有了实际测量，但各仅一个绿色样本。正式CLI输出与独立预览字节相同，发布5f两份JSON；不使用81、19或5f失败样本生成权重。033并发新增文件沿用原Bun缺测fallback，未为追最新SHA再次发布权重。

Bun原生映射逐片校准后，同成本向量模型最大值715.131→697.056秒；反事实3aa成本为710.069→697.056秒，预测仅13–18秒。最大已观测overhead64.197秒不是未来上界，5f已实际证伪把模型余量当作保证的解释；033也未实现相对3aa的尾部改善。

集中验证包含原Q3/V2套件、真实双provider/cache回归、锁与CLI回归、原守卫、前端harness13项、后端6144MB类型检查、改动范围lint/format/actionlint和独立功能检视。末次两份权重的计时/准入回归32项通过。未跑重复完整本地gate；本机共享源码变化导致的跨进程缓存命中无效证据保留，最终以干净hosted提交执行为准。

本地详细证据根为`/private/tmp/aw-rfc625-20261126/`：`comparison/final-033f5fa/metrics.json`及原始artifact、`comparison/final-5f46ad9/failed-observation-summary.json`、`validation/final-5f-backend28-attribution.json`、`comparison/final-5f46ad9/backend41-attribution/`、`validation/immutable-api-repair/hosted-19ef280/`与`hosted/5f-to-033-task-content-binding.json`。最终数字以这些固定source的原始报告和Git对象为准；源码保留证明不等于穷尽所有并发和环境组合的覆盖证明。
