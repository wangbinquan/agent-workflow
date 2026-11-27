# RFC-624 实测验收

状态：Done，2026-11-26。第一批测试优化及实测后的固定key修正已发布，最终代码240ee338完整CI首次69/69通过。本记录同时保留第一候选与最终候选的正负结果，不选最快样本声明收益。最终有一条Windows E2E触发既有retry，不能称为test层零重试。

## 精确来源与门禁

- 基线：`79085123ad2a953955a25c250f8c937fa3af1e28`，[CI 45925598806](https://github.com/wangbinquan/agent-workflow/actions/runs/45925598806)，首次尝试69/69 success。
- 第一候选：`9cbf497ac393053235816af1172071ca511c97c8`，[CI 45933650528](https://github.com/wangbinquan/agent-workflow/actions/runs/45933650528)，首次尝试69/69 success；[视觉回归](https://github.com/wangbinquan/agent-workflow/actions/runs/45933650513)通过。
- 最终候选：`240ee33846083810b7456f31990b23e963595b52`，[CI 45939395356](https://github.com/wangbinquan/agent-workflow/actions/runs/45939395356)，首次workflow/job尝试69/69 success；[CI feedback](https://github.com/wangbinquan/agent-workflow/actions/runs/45939395275)通过。
- 最终[collector 45942711721](https://github.com/wangbinquan/agent-workflow/actions/runs/45942711721)通过，backend计时44片3130文件完整；E2E由于一条Windows测试重试按原规则拒绝刷新权重。来源指向240/45939395356，未把collector成功等同于E2E clean。
- 完整计时：[基线collector](https://github.com/wangbinquan/agent-workflow/actions/runs/45933509875)与[第一候选collector](https://github.com/wangbinquan/agent-workflow/actions/runs/45937727467)。后者workflow本身运行在当时main `9be36b1fb`，产物的sourceRun/sourceSha明确指向45933650528/9cb；不以collector自身HEAD冒充测试来源。
- 两侧均44后端片、六个前端片、E2E 3/3/4、13组required输出，所有预算与provider保持。原始计时均完整，没有缺片拼接。权重产物只读取，没有应用。

## 最终候选实际结果

完整指标与精确来源另存[metrics.json](metrics.json)。以下总墙钟统一取run创建至最后job完成；GitHub run.updated_at代理多1秒，所以此前进度消息的34m26s对应同一轮，严格job终点为34m25s。累计runner分钟取每job首个真实step至job完成之和，是实际区间合计，不是计费分钟。排队、宿主性能、随机顺序及并发负载均可能影响观测。

| 整体口径 | 基线790 | 第一候选9cb | 最终240 |
| --- | ---: | ---: | ---: |
| 总墙钟 | 80m58s | 42m47s | 34m25s |
| 首个实际work step前等待 | 25m57s | 2s | 2s |
| 首work step至末work完成（含内部队列） | 54m54s | 40m21s | 34m18s |
| required尾部等待 | 5s | 2m21s | 3s |
| 累计runner分钟 | 585.25 | 577.0167 | 559.20 |
| 后端job执行median | 10m39s | 10m15s | 9m52.5s |
| 后端job执行P95 | 12m55.70s | 13m08.55s | 11m57.40s |
| 后端job执行max | 13m37s | 13m23s | 13m57s |
| 后端所有文件计时合计（秒） | 24911.954 | 25144.491 | 23888.536 |

最终墙钟比基线少46m33s（57.5%），其中首次work前等待少25m55s；累计runner时间少26.05分钟（4.5%）。不能将墙钟降幅全归因于代码。后端全部文件计时合计下降4.1%，median/P95下降，但最慢job增加20秒，不能称为已解决全部长尾。

| 受影响后端成本池（含新增回归） | 基线秒 | 第一候选秒 | 最终秒 | 最终对基线 |
| --- | ---: | ---: | ---: | ---: |
| 旧15个守卫 → 原15个＋集中scanner | 113.056 | 12.020 | 11.457 | -89.9% |
| 两文件内报告3→2次独立构建 | 88.001 | 96.454 | 69.429 | -21.1% |
| Q3全部11阶段、双provider | 954.994 | 1190.203 | 992.055 | +3.9% |
| V2/V3 dormancy两文件 | 17.814 | 13.432 | 12.525 | -29.7% |
| 夹具生命周期 | 0.688 | 2.400 | 1.391 | +0.703秒，含新增16项回归 |
| 新执行合同回归 | 0 | 2.750 | 2.787 | +2.787秒 |
| 受影响文件去重合计 | 1174.553 | 1317.259 | 1089.644 | -7.2% |

Q3修正后比第一候选少198.148秒（16.6%），但仍比基线多37.061秒，因此这里只认定无用CREATE/DROP和重复求初始key的操作量已减少，不宣称Q3已获得实测提速。最终报告构建比基线快21.1%，第一候选却慢9.6%，也说明单轮不能确定稳定收益幅度。保留原预算、负向覆盖与两次独立报告构建，不为速度放宽门禁。

前端两OS最终仍各897文件/7804case，每片299文件；原4文件28case运行于Node，其他893文件保留DOM setup，文件与分片集合保持。六个测试step合计1412→1231秒（-12.8%；Linux449→413，Windows963→818），第一候选为1179秒；这是全分片观测，不能拆出4个Node环境带来的独立秒数收益。

三平台canvas-controls合计34.634→5.492秒（-84.1%），各平台基线→最终为Linux10.138→2.537、macOS13.226→1.524、Windows11.270→1.431秒；这些case均零retry，保留真实浏览器与正反断言。其余三个独立重试文件的实际spec span合计：Linux214.385→217.044秒、macOS477.456→369.948秒、Windows373.995→497.461秒，Windows含一次重试，不作为clean E2E提速结论。

三轮E2E的逐test ID、expectedStatus与file集合一致：Linux/macOS各536 tests/122 files，Windows530 tests/121 files；3/3/4分片exact-once，原13个独立恢复场景保持。最终唯一retry位于Windows shard3：`rfc294-human-gate-restart.spec.ts:451`，clarify/review在commit后wake前SIGKILL的恢复用例；首轮31.7秒因新daemon ready前退出而失败（仍发现pid7256及`.daemon.lock`），原retry1在59.3秒通过。同文件另外两个case各只运行retry0，没有随失败case重跑。由实际执行证明失败单元已收窄，但没有对“若仍serial会省多少秒”做反事实计时。

独立功能归因确认：这次不是150秒用例预算或ready超时，而是启动子进程主动code1退出；原killChild会等待child close，随后同一case重启同home，进程租约检查认为锁内PID仍alive。本次该spec仅由serial改default，原150秒预算和kill/restart链没有变化；fullyParallel=false与实际执行记录均不支持同文件并发或跨case共享home的解释。但日志缺少旧child PID、close时刻和进程身份，不能区分旧进程状态可见性、PID重用或其他锁时序。因此记录为“Windows同home重启锁冲突，根因未定，单case重试成功”，不认定由本优化引入，也不声称已知环境超时。未修改归属未定的产品进程锁实现，未重跑整轮CI追绿。

主CI的首次workflow/job全绿与测试内部重试是不同层级。最终collector以`retried-tests`拒绝更新E2E权重，标准保持；backend计时仍完整。完整实际墙钟/runner成本包含这次重试，E2E不得标为全轮零重试，也未使用该轮刷新任何权重。

本次验收只关闭批准的第一批。后续性能研究可继续关注Q3全链和backend最长片；本批没有追加更大范围缓存、共享可变DB或更改分片权重。

## 第一候选实际结果

墙钟从run创建计至最后job完成；runner分钟累加每job首个真实step至job完成，不是计费账单。两轮之间还有不同排队、runner、随机顺序及并发负载，单轮数据不能分离这些因素。

| 整体口径 | 基线790 | 第一候选9cb |
| --- | ---: | ---: |
| 总墙钟 | 80m58s | 42m47s |
| 首个实际work step前等待（含admission/runner） | 25m57s | 2s |
| 首work step至末work完成（含内部队列） | 54m54s | 40m21s |
| required尾部等待 | 5s | 2m21s |
| 累计runner分钟 | 585.25 | 577.0167 |
| 后端job执行median | 10m39s | 10m15s |
| 后端job执行P95 | 12m55.70s | 13m08.55s |
| 后端job执行max | 13m37s | 13m23s |

总墙钟下降38m11s，累计runner分钟仅下降8.2333（约1.4%）；不能将约47.2%的墙钟下降全归因于本RFC。后端所有文件计时合计24,911.954→25,144.491秒（+0.93%），不是后端全面降耗。

| 受影响成本池（包含保留断言和新增回归） | 基线秒 | 第一候选秒 | 观察 |
| --- | ---: | ---: | --- |
| 旧15个守卫 → 原15个＋集中scanner | 113.056 | 12.020 | -89.4% |
| 两文件内报告3→2次独立构建 | 88.001 | 96.454 | +9.6%，没有在本轮证明耗时下降 |
| Q3全部11阶段、双provider | 954.994 | 1190.203 | +24.6%，进入归因与修正 |
| V2/V3 dormancy两文件 | 17.814 | 13.432 | -24.6% |
| 夹具生命周期 | 0.688 | 2.400 | 包含新增11项真实DB回归 |
| 新执行合同回归 | 0 | 2.750 | 新成本计入总池 |
| 后端受影响文件去重合计 | 1174.553 | 1317.259 | +142.706秒，保留负结果 |
| 三平台canvas-controls | 34.634 | 4.288 | -87.6%，仍为真实浏览器 |
| 六个前端测试step合计 | 1412 | 1179 | -233秒；三个分片仍变慢，非纯代码归因 |

## 覆盖与隔离证据

前端两OS各897文件，三片各299；与基线逐文件和逐片集合相同，无遗漏/重复。source-guards精确4文件28case，DOM893文件；总case每OS7801→7804。配置与原生Vitest4.1.8 resolved/worker配置逐字节对应，保留30s预算、isolate、原DOM setup/URL/alias；hosted日志证明项目归属，但未打印每个worker全局变量。

E2E两轮均Linux/macOS536 tests、122 files，Windows530 tests、121 files；逐test ID、expectedStatus、file及3/3/4 exact-once人口一致，全部零retry。因此本轮不能量化取消serial后避免的实际重跑，只以真实runner故障注入的default/serial对照证明重试单元变化。macOS各片文件分配也相同，shard3的931→256秒伴随大量未改spec同时约4倍变快，不能单归因于本RFC。

本机集中验证410case/41文件，409 pass＋唯一T14账本初轮失败；按原算法如实修复后，RFC583及三份账本/语料/负夹具门禁65case复验通过。18项真实SQLite/PostgreSQL17.12生命周期回归、前端7文件41case及修补后的10case、真实Chromium canvas、原生Playwright调度/发现、相关类型/lint/format/actionlint通过。没有重复启动完整本地gate；本机容器已清理。独立功能设计/实现门及修补复核通过。

## 实测后复核

报告构建没有新增build：仅将原第三次报告的四条人口/SHA断言移至现有first结果，仍两次独立读取/构建。两轮同一backend shard1的122文件/2055tests对应，121个未改文件中117个也变慢，合计410.678→660.516秒（1.608倍）；报告主要双构建case51.884→87.444秒。现有证据无法把新增少量集合断言与runner/随机顺序差异的成本完全分开，不宣称报告项已实现实测提速。

Q3初始key求取确实引入了每case一次额外`loadFrozenEpoch1History`核验，即使history已缓存也读/hash342个文件、6,350,374字节；88case累计30,096次文件核验、558.8MB逻辑读取。修正仅在每个describe/file实例内惰性缓存明确固定的key，失败求取可重试；每次install的原冻结语料完整校验保持，不新增跨文件manifest缓存、不共享可变DB。其耗时贡献尚未单独量化，不能把Q3全部+235.209秒都归为它；非opt-in的五个Q3对照文件同轮也合计变慢59.4%。最终修正将初始核验88次降至11次，减少77次调用、26,334次逻辑文件读取/hash（488,978,798字节）；不是物理I/O或隔离测得的秒数。最终结果已列于上方，第一候选数据保留。

辅助CI feedback被后继纯文档push按同ref concurrency取消，官方annotation明确原因；未将未完成Lint/Typecheck计为通过。权威主CI和视觉回归结论如上。并发RFC616文档收口完整保留。

修正候选本机复验为7文件103case全部通过（seed62402），包含23个fixture/resolver case、Q3样本、默认V1路径、分区与三份账本门禁；类型/lint/format通过，独立测试PostgreSQL容器已清理。原前端/浏览器候选内容未变，复用有效结果；最终完整hosted CI随后在240ee338首次69/69通过。

固定key两路径独立功能复核PASS，无P1/P2；只新增惰性key resolver/接线和5个行为用例，原18数据库回归正文保持。

收口提交只更新RFC验收资料、指标与状态；完整代码CI结论绑定240ee338，不把这份已完成证据冒充后继纯文档提交的CI结果。
