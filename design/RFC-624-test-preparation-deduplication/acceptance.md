# RFC-624 实测验收

状态：In Progress。第一候选完整CI已通过；依据实测复核修正初始key的重复冻结夹具校验后，将验证最终候选。本记录保留首轮正负结果，不通过选择最快的一次运行来声明收益。

## 精确来源与门禁

- 基线：`79085123ad2a953955a25c250f8c937fa3af1e28`，[CI 45925598806](https://github.com/wangbinquan/agent-workflow/actions/runs/45925598806)，首次尝试69/69 success。
- 第一候选：`9cbf497ac393053235816af1172071ca511c97c8`，[CI 45933650528](https://github.com/wangbinquan/agent-workflow/actions/runs/45933650528)，首次尝试69/69 success；[视觉回归](https://github.com/wangbinquan/agent-workflow/actions/runs/45933650513)通过。
- 完整计时：[基线collector](https://github.com/wangbinquan/agent-workflow/actions/runs/45933509875)与[第一候选collector](https://github.com/wangbinquan/agent-workflow/actions/runs/45937727467)。后者workflow本身运行在当时main `9be36b1fb`，产物的sourceRun/sourceSha明确指向45933650528/9cb；不以collector自身HEAD冒充测试来源。
- 两侧均44后端片、六个前端片、E2E 3/3/4、13组required输出，所有预算与provider保持。原始计时均完整，没有缺片拼接。权重产物只读取，没有应用。

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

Q3初始key求取确实引入了每case一次额外`loadFrozenEpoch1History`核验，即使history已缓存也读/hash342个文件、6,350,374字节；88case累计30,096次文件核验、558.8MB逻辑读取。修正仅在每个describe/file实例内惰性缓存明确固定的key，失败求取可重试；每次install的原冻结语料完整校验保持，不新增跨文件manifest缓存、不共享可变DB。其耗时贡献尚未单独量化，不能把Q3全部+235.209秒都归为它；非opt-in的五个Q3对照文件同轮也合计变慢59.4%。最终修正候选的结果将另列，第一候选数据保留。

辅助CI feedback被后继纯文档push按同ref concurrency取消，官方annotation明确原因；未将未完成Lint/Typecheck计为通过。权威主CI和视觉回归结论如上。并发RFC616文档收口完整保留。

修正候选本机复验为7文件103case全部通过（seed62402），包含23个fixture/resolver case、Q3样本、默认V1路径、分区与三份账本门禁；类型/lint/format通过，独立测试PostgreSQL容器已清理。原前端/浏览器候选内容未变，复用有效结果；最终完整hosted CI尚待发布后验证。

固定key两路径独立功能复核PASS，无P1/P2；只新增惰性key resolver/接线和5个行为用例，原18数据库回归正文保持。
