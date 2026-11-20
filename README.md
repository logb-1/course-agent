# course-agent

> 一个会教课的 agent：把课件交给它，它会先把这叠纸读透，再问你要什么，然后按章讲、出题、判分、排期。

它不是一个「上传文件 → 吐报告」的处理器。它是一个 agent：有九件工具、一套工作纪律、一条可被追问的
证据链。你问「第三章那个指针到底怎么算」，它会去课件里找到那一页，用那一页的原文回答，并告诉你页码；
那一页是扫描件、没读出文字，它会直接说「这页没读到」，而不是编一段。

它跑在 **DeepSeek Harness** 上，作为可安装的 agent（preset + 工具面）。没有 Harness 也能用同一条流水线：
`node bin/run-job.mjs`，或 `server/` 里的网页版。

---

## 快速开始

```text
1. 装进 Harness（见下）
2. 新建会话 → 预设选「课程助教」
3. 说话：
   我下周三考计组，课件在这个文件夹：D:\课程\计组
```

它会先问一句（只问一句）：「要讲义式讲解，还是直接出题？」

装进来的方式，按省事程度排：

**A. 让 agent 自己装**（需要能连上 github.com）

```text
帮我安装这个插件：install_bundle(target="github:logb-1/course-agent")
```

**B. 从目录装**（不用网络、适合改源码）

```text
帮我装这个目录里的插件：C:\path\to\course-agent
```

**C. npm**

```bash
npm i dsh-course-assistant     # 包名沿用旧名，见「关于名字」
```

装好后刷新页面，左侧栏出现「课程助手」图标——那是面板；agent 用的是同一套实现，两条入口不会分叉。

> 改源码后必须重载 Host（`remove_bundle` + `install_bundle`）：Node 的 ESM 模块在进程内缓存，
> 只改文件不会热替换。Client 部分刷新页面即可。

---

## 九件工具

工具名都带 `course_` 前缀，参数扁平、返回有界；长内容一律靠 `jobId` + 偏移续读，不整块灌进上下文。

| 工具 | 参数 | 用途 / 返回 |
|---|---|---|
| `course_health` | — | 环境自检：模型、PDF 排版、OCR 引擎、限额。**每个会话第一次用之前调一次** |
| `course_ingest` | `files[]` · `appendTo` · `reportLevel` · `withVideos` · `days/target/minutes` | 建档，**立刻返回 `jobId`**（不阻塞）。`reportLevel` 默认 `normal` |
| `course_status` | `jobId` | 进度、各章状态、失败章节、警告、**读取统计**、下一步该调什么 |
| `course_outline` | `jobId` · `syllabus` | 目录：每章章节号/标题/页码范围/字数/要点/**能不能读到**；给考纲时附覆盖率 |
| `course_read` | `jobId` · `chapter` · `offset` · `maxChars` | 读某章原文，可续读；默认 6000 字、上限 12000 |
| `course_ask` | `jobId` · `question` · `topK` | 在全文里检索，返回带章号与页码的原文片段（默认 3 条、上限 4） |
| `course_export` | `jobId` · `format` | 导出 `md` / `pdf` / `csv`(Anki) / `json` |
| `course_library` | `limit` | 历史课程（最多 20 条）。用户没给 `jobId` 时先查这里 |
| `course_cancel` | `jobId` | 取消正在跑的任务 |

契约细则（字段、状态机、`next` 约定）见 [docs/agent-contract.md](docs/agent-contract.md)。

---

## 一次完整的学习闭环

```text
course_health                       环境能用吗
   ↓
问清目标（一次一问）                 讲义 / 出题 / 排期？多少天？目标多少分？
   ↓
course_ingest  ──→  jobId          建档是异步的，立刻返回
   ↓
course_status（轮询）                running → done；落后了会给出 next.tool
   ↓
course_outline                      先看目录，决定讲哪几章、跳哪几章
   ↓
course_read / course_ask            讲解只依据这里读到的原文 + 页码
   ↓
出题 → 判分 → 记错题                 题目带原文依据；判分给评分点
   ↓
course_export                       讲义 / 冲刺五册 / Anki 卡 / PDF
```

纪律写在预设的 persona 里，不是靠你反复叮嘱：

- **一次只问一件事**。建档前最多问一句，不摆问卷。
- **成本闸门**。`normal` 是默认；`max`（复习资料）、`plus`（冲刺五册）明显更贵，升档前必须先问你。
- **页码溯源**。讲解、题目、答案里的每个结论都要能指回某章的某一页；指不出来就说指不出来。

---

## 产出长什么样

**报告（`normal`，默认）**——要点式学习报告：

```text
# 《课程名》学习报告
## 一、课程目录
## 二、各章知识点      ### 第 N 章 …  - 要点 / - ⭐重点 / - ⚠️难点 / - 关键词
## 三、课程总结        （≤300 字）
## 附录：B 站相关网课推荐
```

**复习资料（`max`）**——每章 `K` 知识点（目标等级/原文/讲解/易错/最小例题）+ `E` 例题 + `Q` 题目
（答案/原文依据/步骤/评分点/分值/校验状态）。

**冲刺五册（`plus`）**——在 MAX 的基础上本地排期，**不额外调用模型**（成本 ≈ MAX）：
`01-复习计划.md`、`02-主册.md`、`03-答案册.md`、`04-速记手册.md`、`05-刷题宝典.md`，
可直接分开打印。计划里有目标分–掌握度矩阵、放弃项、按天学习包，最后一天整卷模拟。

**导出**：Markdown、**PDF**（pdfkit 直排：封面 → 课程结构图 → 正文 → 附录，中文字体自带，不依赖
LibreOffice）、Anki CSV、结构化 JSON。

---

## 它敢说「这页没读到」

这是这个 agent 最要紧的一条：**缺页不能伪装成「这章内容少」**。

历史上三个静默 bug 都长这样——图片 OCR 从未执行、OCR 缓存从未命中、纯图页被直接丢掉——报告看起来
一切正常，只是内容莫名其妙地薄。现在每章都带读取统计：

| 字段 | 含义 |
|---|---|
| `pages` | 这一章有几页 |
| `withText` | 有可读文字（文本层或 OCR）的页数 |
| `ocred` | 其中靠 OCR 读出来的页数 |
| `unreadPages` / `unreadChapters` | 整份作业层面的缺失页 / 章节数 |

`course_status` 会把它折算成一条**可行动的警告**：「有 12/67 页没有可读文字（扫描件或纯图），涉及章节的
讲解依据可能不全」；`course_outline` 的每一行也带 `read` 与 `note`。agent 看到这条，就该先告诉你缺口，
再继续讲——而不是假装讲得很全。

口径上有个刻意的选择：**页码对不上的页算「未知」，不算「没读到」**。用猜测去制造缺口，和当年用猜测去
制造健康，是同一种错。

---

## OCR：把扫下来的课件读准

扫描件、深色代码截图、手机拍的板书，走的是「页级分诊 → 重读只读不出来的页」：

1. **分诊**（`core/ocr-triage.js`）：`auto` 只重读文字层不可用或明显可疑的页；`all` 整份重读。
2. **双语言行级合并**（1.19 起）：中文用 `zh-CN`，凡含代码的页再跑一遍 `en-US`，按行位置配对后择优
   替换——中文引擎会把 `class Base` 读成 `c 1 a s s`，英文引擎读代码行反而干净，两种都要。
   守卫：latin 占比 ≥0.6、CJK 字数不得减少、可见长度 ≥0.7×。
3. **渲染修正**：深色页灰度反相、小图放大到小边 500px；宽度可配（默认 1600，实测再放大反而更差）。
4. **文本归一**：全角 `．`→`.`、数字内合拢（`3 ． 14159`→`3.14159`）、`c 1 a s s`→`class`、`lnt`→`int`、
   `run()o`→`run().`。

提升幅度（同一套脚本、同口径 CER，`tools/bench/`）：

| 样本 | 之前 | 现在 |
|---|---|---|
| 合成：亮色页 | 11.6% | **5.2%** |
| 合成：深色页 | 7.9% | **5.5%** |
| 合成：模拟扫描件 | 12.5% | **7.5%** |
| **三页均值** | **10.7%** | **6.1%** |
| 真实课件（PDF 自带文本层当答案） | 53.3% | **46.8%** |

代价：单通道约 1.9–2.0 s/页，双通道 4.0–4.6 s/页（双通道只对含代码的页触发）。

自己量一遍：

```bash
node tools/bench/ocr-bench.mjs --tag after            # 合成三页
node tools/bench/real-bench.mjs --pdf <真实PDF> --pages 1,2,3
```

---

## 它怎么读你的课件

```text
课件（pptx / pdf / docx / md / txt）
   ↓ 解析：ZIP+OOXML、PDF 文本层（书签、字号、ToUnicode）
   ↓ 去页眉页脚 / 页码 / 模板行
   ↓ OCR 分诊 + 双语言重读（只读读不出来的页）
   ↓ 认目录：书签 → 标题层级 → §编号/章号 → 定长分块
   ↓ 每章：截断到 ~3600 字 → 固定 JSON 提示词 → 要点/难点/关键词
        ∥ 同时用关键词检索 B 站（1s 节流、24h 缓存、风控降级为搜索链接）
   ↓ 知识图（前置依赖 / 环检测）、要点覆盖率审计、引文核对
   ↓ 报告 · 复习资料 · 冲刺五册 · PDF
```

省 token 的做法：抽取与清洗全在本地；每章只发本章文本；关键词直接复用为搜索词；全课程总结只吃各章
要点；章节按文本 sha256 缓存 30 天。

---

## 配置

写在 `cordis.patch.yml` 的同名列（也可在 Harness 设置页改）；优先级 **请求参数 > 配置文件 > 内置默认**。

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `<DSH_HOME>/course-assistant` | 上传/缓存/报告根目录 |
| `concurrency` | `4` | 并行总结的章节数（1–5） |
| `withVideos` | `true` | 全局关闭 B 站检索 |
| `provider` / `model` | profile 默认模型 | 覆盖总结模型 |
| `reportLevel` | `normal` | `normal` / `max` / `plus` |
| `ocrMode` | `auto` | `auto` 只重读可疑页 / `all` 整份 / `off` |
| `ocrLangMerge` | `auto` | 含代码页再跑一遍英文引擎并按行合并；`off` 关闭 |
| `ocrMaxPages` | `60` | 一次最多重读多少页（1–400） |
| `ocrPick` | `first` | `best`：低分页换第二个引擎复读并取高分（耗时翻倍） |
| `ocrEngine` | 自动 | `windows`（WinRT）/ `rapidocr`（Python，可选） |
| `images` / `imagesMax` | `ocr` / `40` | 幻灯片内嵌图片的 OCR 开关与上限 |
| `coverage` | `auto` | `fast` 省 token / `auto` / `thorough` 逐节摘要 |
| `chapterTitles` | `auto` | 允许模型顺带给出更准的章标题；`rules` 只用本地规则 |
| `domain` | 自动识别 | 强制课程领域（如 `C++`），用于特征太碎识别不出的文件 |
| `spacingMs` | `1000` | B 站请求间隔（≥1000） |
| `keepUploadsDays` | `7` | 上传件保留天数（1–90），仍被任务引用的不删 |

---

## 不开 GUI 也能跑

```bash
# 一条命令跑完整条流水线（不需要 Harness）
node bin/run-job.mjs --spec job.json        # job.json 里 {"offline": true} 即不调用模型
node bin/run-job.mjs --spec -               # 从 stdin 读 spec

# 网页版：FastAPI + 账号 + 配额，可部署公网
python -m venv server/.venv
server/.venv/Scripts/pip install -r server/requirements-dev.txt
server/.venv/Scripts/python -m uvicorn app.main:app --app-dir server --port 8099
```

网页版细节见 [server/README.md](server/README.md)；GPU/云端部署不走 OCR（Linux 镜像里没有 WinRT）。

---

## 开发与验证

```bash
node tools/regress.mjs --unit --strict      # 70 项，任何机器可跑，缺夹具即失败
node tools/agent-contract.mjs               # 24 项：工具面契约（名字、参数、边界、状态流转）
node tools/client-contract.mjs              # Client 槽位与 key 契约
node tools/e2e-fake.mjs                     # 假模型端到端
node tools/bench/ocr-bench.mjs              # OCR 基准，结果落到 tools/bench/results.json
npx playwright test                         # 视觉回归（需带 token 的 DSH_WEB_URL）
server/.venv/Scripts/python -m pytest server/tests -q   # 11 项
```

CI 在 Windows + Ubuntu 双矩阵上跑 unit、Client 契约与假模型端到端，并校验 npm tarball 清单——`files`
白名单漏文件（`preset/`、`skills/` 这类）是别人装了却用不了的经典原因，这一关专门防它。

---

## 目录结构

```text
course-agent/
├── index.js            # Host：HTTP 路由 + course_* 工具 + 任务表 + PDF 导出
├── client.js           # Client：拖拽面板（左侧栏 + 会话内 dock）
├── cordis.patch.yml    # bundle 声明与默认配置
├── core/               # 流水线与能力，全部无第三方依赖
│   ├── parser.js zip.js pdf.js ooxml.js text.js     解析
│   ├── ocr.js ocr-triage.js ocr-score.js ocr-text.js ocr-merge.js ocr.ps1    OCR
│   ├── outline.js titles.js                         目录与标题
│   ├── summarize.js review.js report.js pdfdoc.js diagram.js                   生成与排版
│   ├── search.js coverage.js knowledge.js graph.js audit.js verify.js          检索与校验
│   ├── pipeline.js store.js bili.js                                            编排与存储
│   └── agent-tools.js agent-view.js reading.js                                 工具面与视图
├── preset/             # 预设 persona（一次一问 / 成本闸门 / 页码溯源）
├── skills/course-tutor # skill：agent 的工作流
├── docs/               # 契约、设计取舍、截图
├── server/             # FastAPI 网页版
├── bin/run-job.mjs     # 无 Harness 的命令行入口
└── tools/              # 开发期脚本与基准（不随包发布）
```

---

## 已知限制

- **扫描件的公式与小数**仍不稳（`2.3` → `23`）。公式密集的页，讲解会提醒你对照原图。
- **深色代码截图**偶尔把 `0` 认成 `9`；规则层解决不了，需要视觉模型（`vision` 预留）。
- **纯图页**只能拿到文字，图里的箭头、连线读不到。
- **MAX / PLUS 里的「补充」「参考答案」是模型写的**，不是原文；用到公式或数字时对照原页。
  页码引用只在单份课件时可靠；多文件合并时报告会禁止写页码。
- **B 站是关键词检索**，不是语义检索；对「研究汇报」型课件噪声明显，此时只给搜索链接。
- **成本**：MAX 每章输出约为 Normal 的 3–5 倍；PLUS ≈ MAX。升档前它会先问你。
- 单次最多 12 个文件、单文件 60 MB；上传保留 7 天，报告保留 90 天。
- 不登录、不抓取任何 B 站账号信息；除 B 站公开搜索外不产生其他请求。

---

## 关于名字

仓库叫 `course-agent`，包名与数据目录仍是 `dsh-course-assistant`——已安装的 profile 用链接指向该目录，
改包名会让现有安装断链，所以先保持一致；`course-agent` 是项目名，「课程助手」是它在界面上的名字。
要做一次彻底改名（包名、插件行 id、数据目录一起换）得重装并重新选预设，那是单独一步。

## 设计来源与许可

B 站的 WBI 签名与端点按
[SocialSisterYi/bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) 的文档实现
（该仓库已归档，故只按文档实现、不引入其代码）；ZIP / OOXML / PDF 文本层 / CMap 均为最小自写实现，
思路参考 jsZip、pdf.js、python-pptx 的公开文档，未引入它们的代码。

代码 [MIT](LICENSE)；图标自绘；示例报告不随仓库发布。
