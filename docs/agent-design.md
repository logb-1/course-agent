# 设计记录：从一个工具到一个 agent（形态对比与落地路线）

> 这是改造过程的决策记录，不是使用说明——用法看 [README](../README.md)，工具字段看
> [agent-contract.md](agent-contract.md)。
>
> 状态：设计提案（v1.18.0 基线，2026-11-19）。基线事实：`index.js:720` 注册单个 `course_assistant` 工具（9 个 action），`index.js:880-889` 在 `analyze` 里阻塞轮询最多 150 s 才返回；返回体只有各章要点、`reportPreview`（前 1500 字）和 `reportPath`。

## 1. 结论

- 现在它是**一个工具**，不是 agent：固定 pipeline + 固定模板 + 一次性报告；模型只负责"调用哪个 action"，不参与任何决策，也看不到章节正文。
- 真正 agent 化要补三层：**身份/流程**（谁、按什么流程干）→ **能力粒度**（agent 能自己做哪些小动作）→ **状态**（跨天记忆与目标）。
- 推荐路线：**A 先落地（preset 角色化，半天）→ B+C 为主线（原子工具 + pipeline 三个 LLM 决策点，约 2 周）→ E 学习闭环（再 2–3 天）→ D 多 agent 按需（PLUS/批量）**；F 独立 ACP 服务暂缓。
- **不要**把 pipeline 整个交给 LLM 自由生成：成本约 10×、61 项单测失去意义、结果不可复现。pipeline 保留为确定性内核，agent 在外层编排。

## 2. 为什么现在不算 agent

| 维度 | 现状 | agent 需要 |
|---|---|---|
| 决策 | 规则选 action，pipeline 内部全启发式 | agent 决定读哪一章、要不要 OCR、讲多深 |
| 粒度 | 1 个工具 9 action，`analyze` 一跑到底 | 8–9 个原子动作，可中断、可重试、逐章 |
| 反馈 | 只回要点 + 1500 字预览 | 章节正文摘录、错题归因、进度 |
| 纠错 | 失败只能整份重跑 | 看 warnings 换策略（换 OCR 引擎、跳过纯图页） |
| 状态 | 每次任务独立，无学习进度 | 掌握度、错题本、上次学到哪 |
| 身份 | 通用会话，用户自己描述需求 | 助教人设 + 标准工作流 |

## 3. 候选形态

| 形态 | 实质 | 工作量 | 收益 | 代价/风险 |
|---|---|---|---|---|
| **A. Preset 角色化** | 新 preset `course`：persona + 工作流 prompt/skill + 工具裁剪 | 0.5–1 天 | 立刻可演示"课程助教"；不改 pipeline | 只是外壳，智能不变 |
| **B. 原子工具化** | `analyze` 拆成 ingest/status/outline/chapter/quiz/plan/export/ask，异步 jobId | 5–8 天 | 真 agent 编排：中断恢复、逐章、多轮答疑、混合输入 | 模型步数↑、e2e 要重写、阻塞语义变化 |
| **C. pipeline 内 LLM 决策点** | 标题、页级分诊、体裁、低分 OCR 复读四处交给 LLM | 3–5 天 | 直击已知限制（扫描件/公式/模板报告） | 确定性下降，需 golden set 回归 |
| **D. 多 agent 并行** | `workflow` 按章 fan-out，或 `subagent` 深聊单章 | 3–4 天 | 多章/五册并行，速度快 | 成本 ×N、合并与状态一致性 |
| **E. 学习闭环** | `goal` + `schedule` + `storageDomain` 记进度/错题 | 2–3 天 | 从"一份报告"变"每天陪学" | 需要进度模型与复盘策略 |
| **F. ACP/SDK 服务** | 把 pipeline 包成外部可驱动的 agent 服务 | 3–5 天 | 对外集成 | 脱离 DSH 会话生态，当前价值低 |

## 4. 推荐路线（分层 + 分期）

```
用户 ⇄ DSH 会话（preset: course）
          │ persona / systemPrompt 段：助教身份 + 标准工作流
          │ skills/course-tutor：按需加载的流程知识（不占常驻 token）
          ▼
   tutor agent（通用 agent loop）
     ├ course_ingest    → jobId（有界等待 ≤60s）
     ├ course_status    → phase / progress / warnings
     ├ course_outline   → 章节表（index/title/页码/字数）
     ├ course_chapter   → 单章正文摘录 + 已生成要点（讲解用）
     ├ course_quiz      → 出题（含答案解析）
     ├ course_grade     → 判分 + 错题归因
     ├ course_plan      → 排期（复用 core/sprint.js）
     ├ course_export    → md/pdf/json/csv 路径
     ├ course_ask       → BM25 带页码片段（复用 core/search.js）
     ├ todo / goal / schedule / subagent / workflow（DSH 原生）
     ▼
   pipeline 内核（core/*：OCR 分诊、摘要、报告、PDF、缓存）
     └ store：jobs / 缓存 / 报告
```

分期：

| 期 | 内容 | 验收 |
|---|---|---|
| **P0（半天）** | preset bundle：`course` 人设 + 工作流 skill + `tools.restrict` 裁掉无关工具 | 新会话选"课程助教"，一段话完成"分析课件→分章讲解→追问→出题" |
| **P1（3–5 天）** | 工具粒度化 + `ctx.provide('courseAgent')` 服务化 + 面板复用同一 service | fake 全链路 e2e；`analyze` 旧路径保留为兼容别名 |
| **P2（3 天）** | 四个 LLM 决策点 + golden set 回归 | 扫描件 / 公式 / 纯图页三例质量对比 |
| **P3（2 天）** | `goal`（14 天复习）+ `schedule` 每日学习包 + 进度/错题 | 连续两天"今日学习包"基于昨日错题 |
| **P4（按需）** | `workflow` 章节并行（并发 = `config.concurrency`） | PLUS 五册耗时对照 |

## 5. P0：preset 骨架（不改 index.js）

新增目录（作为独立 bundle 安装，或并入本包新增 exports 子路径）：

```
course-agent/
  preset/
    package.json        # name: course-agent-tutor；dsh.bundle.patch → ./cordis.patch.yml
    cordis.patch.yml
    tutor.js            # preset 内插件：补 prompt 段 + restrict 全局工具
  skills/course-tutor/SKILL.md
```

`cordis.patch.yml`（示意，字段以 dsh-doc 的 preset 声明为准）：

```yaml
- insert:
    id: preset-course
    name: '@deepseek-ai/dsh-agent-preset'
    config:
      id: course
      name: 课程助教
      description: 课件 → 目录 → 分章讲解 → 出题 → 复习排期
      plugins:
        - id: course-persona
          name: '@deepseek-ai/dsh-persona'
          config:
            prefix: '你是「课程助教」，先把课件讲清楚，再出题检验，最后排期。'
        - id: course-tutor
          name: 'course-agent-tutor/tutor'
        - id: course-skill
          name: '@deepseek-ai/dsh-tool-skill'
        - id: course-todo
          name: '@deepseek-ai/dsh-tool-todo'
        - id: course-ask-user
          name: '@deepseek-ai/dsh-tool-ask-user'
```

`tutor.js` 里两件事：`ctx.systemPrompt.section({...})` 写标准流程；`ctx.tools.restrict({ deny: [...] })` 裁掉与本场景无关的全局工具（`tools.restrict` 只作用于调用方 scope，scoped 注册仍然可见）。

**不要**在 preset 里挂整份 `course-agent`：它的 HTTP 路由依赖 Host 的 `webServer`，preset realm 拿不到；preset 内直接 `import` 本包的 `core/*` 即可（同进程模块单例）。

## 6. P1：工具表

| 工具 | 参数 | 行为 | 说明 |
|---|---|---|---|
| `course_ingest` | files, reportLevel, withVideos, waitSeconds≤60 | 建 job，短等待后返回 jobId/状态 | 替代 `analyze` 的 150 s 阻塞 |
| `course_status` | jobId | phase / progress / chapters / warnings | agent 自决定何时查 |
| `course_outline` | jobId | 章节表 + 课程总结 | 让 agent 知道"有哪些章、哪些章可疑" |
| `course_chapter` | jobId, chapterIndex, mode=explain\|review | 该章正文摘录 + 已生成要点 | 解决"agent 看不到正文"；不重复生成 |
| `course_quiz` | jobId, chapterIndex, count, difficulty | 题目 + 答案解析 | 写入进度 |
| `course_grade` | jobId, answers[] | 判分 + 错题知识点归因 | 复用 `core/keywords.js`、`core/terms.js` |
| `course_plan` | jobId, days, target, minutes | 排期表 | 复用 `core/sprint.js` |
| `course_export` | jobId, format | 文件路径 | 不变 |
| `course_ask` | jobId, question | 带页码片段 | 不变 |

约束：每个工具描述 ≤300 token；工具定义总量目标 <2.5k token（用 `Tool.listTools` 实测）。`course_assistant` 保留为兼容别名，面板继续走 HTTP，但两者都改为调用 `ctx.provide('courseAgent', api)` 的同一个 service，避免两套逻辑漂移。

## 7. P2：pipeline 的四个 LLM 决策点

1. **章标题/切分**：现在 `applyModelTitles` 只在摘要时顺带给标题；改为 outline 阶段一次结构化调用，输出"合并/拆分/命名"建议。
2. **页级分诊**：`locatePages` 纯规则；只对边界页（≤10 页/章）让 LLM 判"这页值得读吗"。
3. **体裁与讲解角度**：报告模板固定；由 LLM 给每章一个讲解角度（先修概念、易错点），注入 `core/report.js`。
4. **低分 OCR 复读**：`ocrPick=best` 现在固定策略；改为按 `core/ocr-score.js` 分数 + 上下文判断是否换引擎/复读。

每处都要有 golden set（3–5 份代表性课件）与"关掉 LLM 决策"的降级开关，保证可回归。

## 8. P3：学习闭环

- `goal`：`create_goal("14 天复习 <课程> 到 80 分")`，自动续跑。
- `schedule`：每日固定时间推送"今日学习包"（章节 + 题 + 昨日错题）。
- `storageDomain` 域 `course-progress`：`{ jobId, chapterIndex, mastery 0-1, lastStudiedAt, wrongAnswers[] }`；答对升、答错降，次日优先推 mastery 低的章。
- `course_plan` 从"一次性排期"改为"按进度重排"。

## 9. 测试与验收

- 单元：现有 61 项保持；新增工具 schema 快照（含 token 预算断言）。
- fake e2e：`ingest → status → chapter → quiz → plan → export` 全链路无真实模型（沿用现有 fake 引擎）。
- 真实三例：PPTX normal / 扫描 PDF max / PLUS 五册；外加一次中断恢复（`kill -9` 后 `status` 应显示 zombie，`reapZombies` 已有）。
- 成本记录表：单次 `analyze` vs agent 逐章总 token，写进 WORKLOG。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| preset realm 拿不到 Host 服务或无法 import core | 同进程模块单例，import 可用；service 用 `ctx.get('courseAgent')` 且带兜底 import。先做 1 小时 spike |
| 工具变多模型乱选 | preset prompt 固定标准流程；先 `ask_user` 问清目标；描述里写约束 |
| 轮询耗 token | `waitSeconds` 有界等待；只在 jobId 存在且状态 running 时查 |
| pipeline 决策不确定 | 决策点全部可关（config 开关），golden set 回归 |
| 开发期每次改 Host 要重启 | 日常用 fake e2e；真实验收集中做一次 |
| 面板与工具双轨 | 统一 `courseAgent` service |

## 11. 明确不做

- 不把报告生成改成"LLM 自由写全文"（成本、不可回归、丢缓存）。
- 不在 preset 内重复挂 Host 插件（路由缺失）。
- 不为 9 个 action 各建一个工具（语义重叠，模型难选）。

## 12. P0 已落地（2026-11-19）

形态 A（preset 角色化）已实现并装进本机 desktop profile，未发布、未提交版本号。

文件（均在仓库内，自成一个 bundle）：

| 文件 | 作用 |
|---|---|
| `preset/package.json` | bundle 清单：`name: course-agent-tutor`、`exports["."] = ./tutor.js`、`dsh.bundle.patch` |
| `preset/cordis.patch.yml` | 一条 `@deepseek-ai/dsh-agent-preset` 声明：`id: course`、`name: 课程助教`、13 个插件行（persona / tutor / agent-instructions / time-context / tool-pwsh / tool-fs / tool-fs-search / tool-skill / tool-ask-user / tool-todo / tool-web / present / compaction 组）；**全部提示词措辞都在 persona 的 `prefix` 里**（见下方「措辞为什么放在 YAML」） |
| `preset/tutor.js` | preset 侧插件：只保留激活时的 `import('course-agent')` 探针，证明 preset realm 能 import Host 包；P1 在这里长出细粒度工具 |
| `skills/course-tutor/SKILL.md` | 按需加载的技能：提问/成本闸门 + 六步 + 质量底线 |

安装（已执行，重复执行会走 upgrade）：

```powershell
plugin_manager install_bundle target=C:\Users\ThinkPad\Documents\deepseek-harness\default-workspace\course-agent-new\preset
```

安装后 profile 里 `course-agent-tutor@0.1.0` 为 link，Loader 行 `preset-course` 已 live（`Config listConfigs` 与 standard/ptc/minimal/cordis 并列，status=schema）。

**首轮「选择器里找不到」的真实原因**（同日修）：声明注册成功，但 preset 的 mount 审计失败，roster 里带 `broken`：

```
tool-fs-search (@deepseek-ai/dsh-tool-fs-search):
invalid config: $.sampleOverCapGlobResults missing required value
```

`dsh-tool-fs-search` 的 config 有必填字段（出厂 standard preset 写 `sampleOverCapGlobResults: false`），漏写即整份 preset 被判 broken；而会话输入区的预设快捷选择器只列 `broken === undefined` 的项（`@deepseek-ai/dsh-client-ui-agent-preset/src/client/settings-store.ts:122`），所以表现为「完全没有这一项」。设置页的预设列表仍会显示该行，带「加载失败」徽章和原因全文（`src/client/AgentPresetSection.tsx:116-139`），是新 preset 排查的第一现场。

排查手段（可复用）：临时装一个 `inject: ['agentPresets']` 的探针插件，定时 `await ctx.agentPresets.list()` 把 JSON 写到工作区；改动后 `plugin_manager set_bundle enabled=false → true` 会立刻重排队 profile，**不必重启 DSH**。顺带排除的怀疑：不是包解析问题——`pluginPackages.packageOf('@deepseek-ai/dsh-persona', presetBase)` 返回 null，但 Loader 仍能从安装目录解析并挂载；也不是 realm/服务泄漏。

**措辞为什么放在 YAML 而不是 `tutor.js`**（同日改）：`@deepseek-ai/cordis-plugin-loader` 的 `import(name)` 不带 cache-busting 查询串，preset 重排队时复用的是进程内的 ESM 模块缓存——改 `tutor.js` 里的字符串，不重启就看不到新文本；而 patch 文件每次重排队都会重新读盘。所以提示词一律写在 persona `prefix`（即时生效），`tutor.js` 只留代码侧的探针/工具。代价：第一次把措辞从 `tutor.js` 搬到 YAML 时，缓存里的旧 `section` 会与新 persona 并存，需要重启一次才能清干净。

**首版措辞的三个毛病**（同日修）：① persona 那句「先弄清课程/目标分/剩余天数/要讲义还是题」等于教它一次性盘问——改为「一次只问一个问题，能先动手就先动手」；② 步骤 2「先问清 reportLevel」与 persona 的提问指令叠加，建档前被拦两次——改为默认 `normal` 先跑，只有升 `max`/`plus` 才必须先问；③ `WORKFLOW` 开头「按需跳过不适用的步骤，但不要跳步」自相矛盾——删掉，改成固定的六步顺序 + 明确的三条硬约束。措辞的三条闸门现在是：一次一问、成本闸门、页码溯源。

**怎么试**：新建会话 → 预设选择「课程助教」→ 发"帮我复习这份课件：<路径>"。预期行为：先 `health` → 用 `normal` 直接 `analyze` 建档（只有想升 `max`/`plus` 才问一句）→ 按章讲并给页码 → 出题判分 → 需要时排期 → `export` 给路径。

P0 已知欠账：

1. ~~`skill-filesystem.customSkillDirs` 写本机绝对路径~~ —— 2.0.0 已改：preset 不再挂 `skill-filesystem`，技能由 Host 半边（`index.js` 的 `registerTutorSkill`）读 `skills/course-tutor/SKILL.md` 后注册到全局 skill 层（`skills.register({ source: 'bundled', resourceBase })`），不依赖任何路径解析；`core/agent-tools` 的契约测试断言了这一条。
2. 尚未用真实模型跑通一次完整"分析 → 讲解 → 出题"（验收项）。
3. preset 未设为 `agent-preset-registry.selectedDefault`，保留用户自己选。
4. 面板与工具仍是两套入口；P1 用 `ctx.provide('courseAgent', api)` 收口。

## 13. P1a 第一步已落地（2026-11-20）：原子工具面 + 服务收口

<section 12> 里的 `analyze` / `health` / `ask` / `export` 是旧形态；从这一步起工具面换了。

**形状**：删掉 9 个 action 的单工具 `course_assistant`（其 `analyze` 在工具里 `const deadline = Date.now() + 150000` 阻塞轮询），改为 9 个原子工具：

`course_health` / `course_ingest`（立刻返回 `jobId`）/ `course_status` / `course_outline` / `course_read` / `course_ask` / `course_export` / `course_library` / `course_cancel`。

**服务收口**：`index.js` 里 `ctx.provide('courseAgent', agentApi)`，工具层只是这层 API 的薄壳；后面要重做网页面板，也接同一个 api，不再两套逻辑。

**取消**：`makeJob` / `makeRerunJob` 各建 `AbortController`，`signal` 一路传到 `runPipeline` / `rerunChapter`；`course_cancel` 与插件卸载都会 abort，作业记 `cancelled`。

**上下文纪律**：作业不把报告正文回灌给模型。正文只存在搜索索引 `<dataDir>/jobs/<id>.index.json`，`course_read` 按 offset/maxChars 从 passages 还原（`splitPassages` 按句末标点切，同章 `join('')` 即原文），`course_outline` 只给每章元信息，`course_export` 的 `preview` 截 1200 字。

**可执行契约**：`node tools/agent-contract.mjs`（21 条断言，假 Host ctx + 临时夹具，无模型无网络）。含「`course_ingest` 3 秒内返回 jobId」——这条就是防回归「工具内阻塞轮询」。

**文档**：`docs/agent-contract.md` 是给人看的同一份契约（8 条硬规则 + 工具表 + 状态机 + `next` 约定 + 破坏性变更）。

**破坏性**：旧 `course_assistant` 名不再存在，不留兼容壳；面板 HTTP 路由不变；`preset/cordis.patch.yml` 的 persona 与 `skills/course-tutor/SKILL.md` 已同步改为新工具名与轮询说明。

**欠账**：Host 插件改动需重启 DSH 才生效（改的是 `index.js` / `core/*.js`）；尚未用真实模型验收；P2（记忆/错题本）未做。

## 14. P1b 已落地（2026-11-20）：把「读没读到」变成字段

P1a 之后工具面是对的，但模型仍分不清两件事：**这章内容本来就少** 和 **这章根本没读到**。历史上三个 OCR 静默 bug（图片 OCR 从未执行、OCR 缓存从未命中、13 页纯图页被丢）在报告里的表现都只是「这章有点短」。

**口径单点**：`core/reading.js`（纯函数）定义唯一判断——一页算「读到」= 去空白后 ≥ `MIN_PAGE_CHARS`（20）字；`ok` / `ocr` / `unknown` 三态分开计数，`unknown`（页码对不上）绝不当成「没字」。

**归因**：页码是**每文件独立**的，所以 `buildOutline` 给每章记 `doc`（在 `mergeSameTitle` 之后、多文件标题前缀之前写），统计时按 `(doc, page)` 查；两个文件页码重复时**不硬猜**，只有单文件才允许按页号回退。

**落到视图**：
- `course_status.reading` = `{pages, withText, ocred, unknownPages, unreadPages, unreadChapters}`；
- `course_outline` 每章 `read: {pages, withText, ocred}` + 缺页时的 `note`；
- 有未读页时 `warnings` 首位自动多一条「有 X/Y 页没有可读文字…」，`warningsTotal` 计入；
- `rerunChapter` 重算 `stats`，重跑不会把统计清空。

**测试**：5 条 unit check（计数 / 多文件不猜 / 措辞三态 / 派生警告 / 未知与旧作业不乱报），总数 61 → 66 pass。

**一个细节**：`unknown`（页码对不上）不算「没读到」——否则等于用猜测制造缺口，和当年用猜测制造健康度是同一种错。真实样本 `实验3-面向对象编程&函数式编程.pptx`（56 页）读到 56/56，0 未读章节。

## 15. 2.0.0：一个名字，一个 agent 端（2026-11-20）

目标是「它自己是一个 agent 端」，不是「某插件的伴侣」。所以 2.0.0 只做一件事：把 `dsh-course-assistant` 这个**插件名**从所有对外表面上拿掉，只留 `course-agent`。

| 表面 | 2.0.0 |
|---|---|
| npm 包名 / Loader 行 id | `course-agent` |
| HTTP 路由 | `/course-agent` |
| 默认数据目录 | `<DSH_HOME>/course-agent`（升级时回退读旧目录 `course-assistant`，见 `core/store.js` 的 `resolveDataDir`） |
| Cordis 服务名 | `courseAgent` |
| 课程 schema | `course-agent/course@1` |
| 日志标签 | `[course-agent]` |
| 浏览器全局 / 面板槽位 | `__COURSE_AGENT_CLIENT__` / `course-agent`、`course-agent-dock` |
| 预设包 | `course-agent-tutor`（预设 id 仍是 `course`，显示名「课程助教」） |

三条约束值得记住：

1. **升级不能像全新安装**。数据目录、schema、缓存键都带名字，改名后旧作业看起来会「消失」；`resolveDataDir` 的旧目录回退 + `tools/regress.mjs` 的 unit check（先旧后新、显式 `dataDir` 优先）就是为这条钉的。
2. **历史名保留在文档里**。`course_assistant`（下划线）是旧工具名，`docs/agent-contract.md` 明确写「已删除、无兼容壳」——这比假装它从没存在过更有用。
3. **技能不再靠 preset 找路径**。preset 曾用 `skill-filesystem.customSkillDirs` 指向本机绝对路径，那既不可发布，也会让 `!!js` 求值失败拖垮整份 preset（一次 preset 只 broken 不报错，输入区的选择器还直接把它藏起来）。现在 Host 半边 `registerTutorSkill()` 读包内 `skills/course-tutor/SKILL.md`，注册进全局 skill 层，`agent-contract.mjs` 断言它注册成功。

**中文文案**：「课程助手」只作为面板标题保留，「课程助教」是 agent 身份。代码里没有第二套概念。
