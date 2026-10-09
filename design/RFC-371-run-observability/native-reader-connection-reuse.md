# RFC-371：报告内复用原生读取连接，保留每个根的独立快照

本片接续已批准的完整统计性能修复。相同正式范围约22.1秒、原生采集约9.04秒，仍未达到加载验收；不减少任何任务、调用、原生 part/step、子树、历史回执或已有已知部分金额。

## 原库诊断

同一1730个已EOF直接根、37113个part、38843次逐行查询及8717个消息缓存项，在原SQLite文件上分别使用“每根新建连接”和“复用物理连接但每根独立BEGIN/COMMIT”。两模式保持当前消息缓存SQL及每根完整TEMP表初始化；每根结束时前者close，后者删除该根全部TEMP表。原字段摘要均为`7dfd4c65a13dd76f2cb37146a8d67c7d52563d98080cd080999d876b63311a1c`。原库只读诊断6478.28ms→3855.95ms，开连接/初始化1602.34ms→344.60ms，字段读取4652.80ms→3389.96ms。这是原SQL读法证据，不能代签完整子树、协议、两provider或正式整页性能。

## 层级与生命周期

复用只属于RuntimeManagement infrastructure中的报告用historical reader工厂；baseline/final与原独立历史reader入口仍默认新建/关闭原物理连接。工厂绑定一个原文件路径，返回原open和新增本地close；由既有RuntimeManagement composition和原observationReportWorker唯一装配。对外HistoricalNativeUsageQuery与共享read/open/generation端口保持，composition只给返回类型附加本地close供Worker finally调用，不新增应用级池、服务、URL、任务、费率或跨报告缓存。

工厂最多保留一条闲置物理连接，按每次原generation实际值匹配。它约束连接资源占用，不限制任何统计人口。每次open借用匹配的闲置连接；不同generation先关闭旧闲置连接，再打开当前原路径。并行打开的reader各有独立连接，任意多的根均可完整处理；超过一个闲置时关闭多余连接。活跃旧generation只属于其原reader，不供新根借用。

## 原读语义

原reader内部可接收工厂提供的窄readonly连接；原公开reader函数的默认路径、原fields/CASE/join/order/LIMIT、root出生时间、所有计数/fingerprint/issue、page row/byte边界、pending/ACK/EOF和identity保持。每个根仍执行原PRAGMA、BEGIN和实际root读，建立原独立SQLite快照，创建原queue/index/open_steps/message_models TEMP并逐行读取，不把一个BEGIN扩成跨根快照，不提前解析后续字段。SQLite在新的BEGIN中观察其原WAL变化；不以文件generation当内容版本。

借用连接的query/get/all只转发同一原SQL和参数，并记录原BEGIN/COMMIT是否已成功。原reader逻辑close仍幂等且立即失效：若该根事务尚在进行先ROLLBACK，然后删除它创建的三个TEMP表（queue索引随表删除）；只有清理完整成功的连接才可闲置复用。清理异常则关闭该物理连接，绝不将残留root、模型、游标或未完成步骤交给另一个根。原异常/关闭不转换成完整EOF，不改变原已知部分事实；原自有close行为和失败必须有真实回归。生成/初始化失败的借用也释放，不能泄漏。

工厂close幂等，先关闭全部活跃reader，再关闭闲置连接，并禁止随后open。EOF ACK、显式取消、初始化失败和读取错误都经过原readerclose释放；独立reader与各原BEGIN互不影响。Worker在compose成功、失败、取消和结果发送前finally关闭工厂，不依赖GC/terminate释放；原composition失败必须保留原错误，不因清理替换失败来源。不要把本地close添加为跨模块public接口或新数据authority。

## 回归与验收

新增真实SQLite/WAL工厂回归，真实默认连接和可计数的原readonly连接适配均读原文件：两顺序根/重复根完整原fingerprint和四桶一致；前根EOF后writer更新模型/part，后根看到新值，前根快照保持；原同message不同session/NULL及坏JSON原位置；并行reader独立、前根未ACK不影响另一根；显式close/坏根/坏JSON释放后新根无残留；不同generation不复用旧连接，真实替换文件后读新根；工厂finally关闭所有活跃/闲置，关闭后禁止open。统计完整性按原真实独立SQL/旧reader oracle核对，不能只检查连接计数或新helper的自证返回。所有旧reader/Worker预算及断言保持，新测试登记现有Windows和实际SQLite构造高水位。

设计与实现有限独立功能门、一次实际候选matching和新exact-SHA hosted CI分别验收。本机只做原SQL诊断、静态检查与正式原后台/API验收，不跑AW产品测试/typecheck/build/新服务/规模CI。正式相同范围须全部37533明细、16259组、12集合31页EOF、原四桶/CNY/缺口逐条一致后才记性能改善。连接诊断的2.6秒节省不能直接写成产品提速；两个RFC仍未完成。

## 正式原报告实测

报告 `0786d83d-3c32-4c21-9478-58b82a54758d` 在同一原范围正式生成22195.27ms，collector15697.38ms，其中native8942.4ms；与上一候选22118.66ms相比没有明显提速。原137任务、595尝试、446调用、198历史引用保持，全部37533物理明细、16259分组和12顶层集合31页EOF逐条相等。输入1189241、缓存读取1255680、缓存写入0、输出186002，总2630923，已知人民币¥4.078952，原9项未完整资格保持。静态格式/ESLint通过，未在本机运行产品测试或typecheck；hosted CI和有限源码复核另验。此片只证明连接资源复用保持原数据语义，不记为已解决加载性能。
