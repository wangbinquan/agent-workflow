# RFC-615 实施与验收

用户已明确授权第二轮；全部实现与用例完成后集中验证。

- [x] T1 源码/失败/队列证据复核，设计与授权范围落档。
- [x] T2 历史行桥payload与调用内缓存，完整语义和变异回归。
- [x] T3 G1单次JOIN/窄投影、原始样本与诊断、cold/warm/custom/generic及分页回归。
- [x] T4 job内冻结SQLite缓存、并发/完整性/隔离/失效回归；compiled缓存经成本验证撤回，保持原每case编译。
- [x] T5 计算workflow与required分离、runner调整、计时来源兼容、全部拓扑与守卫接线。
- [x] T6 集中验证、实际计时对照、独立功能复核；修复本人缺陷并复验相关范围。
- [ ] T7 精确路径发布、exact-SHA CI跟踪，记录两个失败及后端长尾/队列的实际变化。

## 验证记录

T2–T5完整实现及全部用例已于集中验证前写齐。静态复核确认原13组/69个计算作业只增加backend缓存准备step，所有原命令、矩阵、provider和预算保留；父门仍为第70个实际作业。actionlint通过；计时collector使用Bun原生YAML，无npm安装依赖。随后开始集中验证，结果将在下方记录。


- T5：16文件共227项最终有通过证据（初跑226通过、一个负fixture的文本替换误命中输出名称；改为完整job行匹配后相关12项全通过）。真实Bash门逐一拒绝每组failure/cancelled/skipped/缺失/未知值，全部success才通过。
- 全workflow actionlint通过；没有新增忽略项。采用JSON往返逐项保留job结果，避免上游直接result空输出问题。
- 真实旧source `92222f0c3` / run `45797271947`：backend完整44份、3092文件、23925119ms成功，来源仍精确指向旧ci.yml；E2E完整11份通过完整性校验后中性跳过4个retry文件，不产出污染权重。首次E2E命令误传便于阅读的目录名而被完整性守卫拒绝，随后使用带原artifact名称的既有完整来源成功；未更改脚本判据。
- 统一backend tsc在8GB堆完成并找出两处新增测试的readonly类型错误，正在修复；4GB探测OOM不计有效结果。

- GitHub主分支实际保护规则只要求`CI required`（strict=true，GitHub Actions app_id=15368），当前没有额外ruleset检查；本轮保持其父workflow名称和job名称，未修改任何分支保护配置。
- 与CI一致的全量design本地链接检查：3445项、0错误。额外扫描STATE历史记录发现两条原有失效路径，均不在本轮新增段落与CI design扫描范围，不擅改历史记录。

- T2：8文件72个实际用例通过（首轮71通过+缺PG的明确阻断，配置PG后仅补验真实PG用例）。新增20项回归全过；原13版本/78fold单用例1150.72ms，仍默认5000ms。属于本机无coverage证据，不与hosted秒数混算固定提速比例。
- T3原完整perf：PG17.12/Bun1.4.3，双provider、isolate/randomize、seed58947、coverage，一次25通过/0失败/235断言、184.85秒。G1 PG P95 13.12ms、SQLite18.36ms，仍4SQL/52返回行/最大50参数；9样本、50x/250ms/180秒原判据保持。
- T4新21项均有通过证据。集中验证修复了测试取消顺序、一个冻结种子表误选以及真实编译命令的参数问题；相关范围复验，未扩大预算。原SQLite升级5文件13通过/0失败/1项PG待补，63断言、255.57秒；跨文件1次模板冷构造与12次命中。原语内部构造约523ms、命中复制6–23ms，不含输入/admission工作，不作为完整fixture或hosted加速比。

- T3最终新增/关联语义与计划39个不同用例通过。新plan fixture单独禁用6张目标表后台autovacuum，确认cold无任何analyze/列统计，再明确VACUUM后的warm；8组合执行0.576–1.361ms，prefix/fallback与oracle全等。此补严只复验新文件1项，未重跑或修改原perf。
- T4原release补样本与PG缺口：v0.18.18 PostgreSQL155.09s、SQLite40.93s，均保留240秒预算并完成真实流程；compiled cache前者miss后者跨文件hit。fresh PostgreSQL startup6.70s通过，补齐唯一PG skip。专用PG容器/卷已清理并验证不存在。
- 汇总：T2 72 + T3 64 + T4 37 + T5 228 = 401个不同用例有通过证据。没有运行重复全量本地gate。统一backend tsc（8GB）0错误，39个TS文件ESLint、41文件Prettier、全workflow actionlint通过。T3/T4/T5有内部独立只读功能复核PASS；T2纯机制与拒绝边界另经root复核。
- T7：候选实现与本地验证完成，准备精确路径发布；托管exact-SHA结果及实际队列/长尾仍待发布后取证，不能由本地通过代替。


### 发布前成本裁决

完整准备成本补测发现compiled缓存没有可靠净收益：原编译片段一次114.31ms；候选热helper225.65ms，另有约94ms边际import成本。源码、Bun版本和OS一致但完整环境key不同，不作为精确因果差值或hosted预测。最终撤回本RFC自己的compiled缓存接线及两份新增专用文件，保留原每case真实编译和原断言。SQLite模板缓存保留：完整helper冷/热一次样本2518.72/1855.00ms（包含admission/key，模块import另计），最终以hosted长尾测量为准。

以上先前401项记录属于成本裁决前候选。最终保留的当期用例为395项；删除的6项仅验证本轮撤回的新增compiled缓存，不涉及任何已有测试覆盖。恢复原编译路径后追加原SQLite release样本复验，其他未变范围证据继续复用。

恢复后的原v0.18.18 SQLite release流程复验1通过/0失败，case40.461秒，预算不变。daemon.ts与原HEAD无差异；最终T4仅保留5路径（共用缓存、冻结SQLite helper、原auto-upgrade接线及两份新回归）。最终发布路径为43个；无compiled缓存或额外TypeScript runtime依赖。
