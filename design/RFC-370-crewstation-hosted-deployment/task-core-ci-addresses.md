# Task 核心迁移的 CI 配套修复

bbbef9f 的 CI37383152708 与 Windows37383152628 暴露了旧源码地址、登记分母、fixture 类型和一处已提交 migration snapshot 的格式问题。本批在已发布 f9052371 的类型修复上继续收口，不把已失败的 run 记作成功。

四个源码锁继续使用原断言与预算，仅把 Runner 或 envelope reader 指向实际完整 Task application core 或 local output implementation。DAG 外的三条 memory 消费、native compatibility 的两条实际跨模块地址按迁移事实逐文件登记，所有旧账与原分类判据保留。

canonical effect collector 原本跳过整个 Task application 目录；完整 Runner 迁入后，原 process act-site 被跳过，真实登记从九项变成八项，原 `> 8` 判据报错。只让这一条确切 application/taskAgentRun.ts 生产文件继续进入原 collector；其他 application coordinator 仍保持原规则，effect 分类、字段投影、负 fixture 与数量门槛不变。需要按新的 collector 输入生成配套 canonical 清单，不能只修测试期望。

三个已提交 RFC371 测试只增加原 TEMP getter 的具体泛型、before-spawn fixture 的 literal 类型与已由原断言验证为 string 的 generation 非空类型标注。运行时输入、所有断言、完整 fixture 内容和预算保持。一处 snapshot 仅格式化，解析后的 JSON 与原件完全相等。其余并行在制源码和文档保留且不纳入本批。

本机只做 scoped format/lint 与纯源码 AST/JSON 对拍，不运行 AW tests/typecheck/build/service。正式功能结果交本批发布后的 exact-SHA hosted CI。六个实际 Task 调用与完整 family/root 仍是独立在制候选；A-T5、A-G、CS adapter、M0 首次部署、M1～M4及完整 RFC 尚未完成。
