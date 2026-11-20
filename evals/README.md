# evals

行为评测。判分只用程序能证明的事实——页码、字数、字段、拒绝码——所以这些检查不需要模型，也不会因为模型换了就漂移。

```bash
# 真实课件（路径自备；每块课件跑一次建档）
node evals/run.mjs --deck "实验3=C:/Users/ThinkPad/Desktop/实验3-面向对象编程&函数式编程.pptx"
node evals/run.mjs --deck "栈帧=C:/Users/ThinkPad/Desktop/栈帧专题_方法真题变式答案.pdf"

# 不存在的路径会被跳过；CI 用合成夹具，不需要任何课件
node evals/run.mjs --fixture

# 记录当前行为（之后每次跑都和它比）
node evals/run.mjs --fixture --write-baseline

# 只跑一类
node evals/run.mjs --fixture --only gate
```

## 测什么

| 任务 | 判据 | 为什么值得钉住 |
| --- | --- | --- |
| `reading-honesty` | `unreadPages = pages - withText - unknown`，且 >0 时必须出现在 `warnings` | 三个 OCR 静默 bug 当年就是「没读到」和「这章短」长得一样 |
| `citation-range` | `course_read` 的页码落在该章页码范围里 | 引到不存在的页 = 编造来源；纯文本文档没有页码，判为「不适用」 |
| `read-bounds` | 返回字数 ≤ 请求上限，`chars` 与 `text` 一致，未静默丢后半章 | 上下文膨胀最常见的方式是「顺手多返回一点」 |
| `read-continuation` | 长章必须给 `nextOffset` | 没有续读，模型只能重复读同一段或囫囵吞下 |
| `ask-miss` | 问课件里没有的东西 → 0 条 + 解释 | BM25 永远会排第一；不给空结果，模型就会把无关段落讲成答案 |
| `ask-hit` | 真问题 → 每条片段都带 `chapter` + `page` | 可溯源的片段才能支撑「第 12 页说……」 |
| `confirm-gate` | `max/plus` 无 `confirm:true` → `needs_confirm` | 成本闸门写在描述里不算闸门 |
| `export/status/read/outline-gate` | 未知 job → `job_not_found` + `hint` | 模型要靠 code 分支，不能靠中文猜 |
| `cost-visibility` | `status.cost`（模型调用/缓存命中）与 `status.tools`（调用序列）存在 | 「慢」「贵」没有数字就只是感受 |
| `memory-roundtrip` | 写下的目标（`days`/`target`）与章节进度能被 `course_recall` 原样读回 | 只在对话里答应等于没记，下次会话会重问一遍 |

## 不测什么

**讲解写得好不好**。那需要真实模型和人的判断。做法是在 DSH 里用「课程助教」预设跑同一批课件，人工对照 `baseline.json` 里的读取统计与工具序列——确定性部分由这里保证，语言部分由人保证。把 LLM judge 也放进来之前，先别假装它能替代人。

## 讲解：能证明的那一半（`talk.mjs`）

讲解里有一半是可判定的：**它引的页存不存在、它声称照抄的句子在不在原文里、缺页有没有说、是不是敷衍**。这些不需要模型，也不该等到人来看。

```bash
# 先证明判分器自己是对的（CI 跑这条）
node evals/talk.mjs --self-test

# 给收集到的回答打分（回答可以从真实会话里复制）
node evals/talk.mjs --answers evals/answers.json

# 或者让一个 OpenAI 兼容模型用同一份正文作答，再打分（需要密钥，不进 CI）
EVAL_API_KEY=... node evals/talk.mjs --live --in questions.json --out answers.json
```

回答文件的格式（数组，一条回答一个对象）：

```json
{
  "id": "ch2-explain",
  "chapter": 2,
  "chapterPages": [3, 4, 5],
  "paginated": true,
  "reading": { "pages": 5, "withText": 4, "unreadPages": 1 },
  "readText": "[p3] …（course_read 的原样输出）",
  "question": "讲讲这一章",
  "answer": "……第 4 页……"
}
```

四项判据：

| 检查 | 判据 | 为什么 |
| --- | --- | --- |
| `citations` | 每个 `第 N 页` / `[pN]` 都落在 `chapterPages` 里，且分页课件至少要引一页 | 引到本章不存在的页 = 编造来源 |
| `quotes` | 声称「原话/原文/写道」的引号内容必须能在 `readText` 里逐字找到（`「」` 只当强调时不判） | 转述冒充原文，是最难被读者发现的一种错 |
| `unread-note` | `unreadPages > 0` 时讲解必须提到没读到 | 沉默是默认行为，必须显式要求 |
| `length` | 80–4000 字 | 太短是敷衍，太长是灌水 |

`--live` 度量的是「模型拿着我们给的正文能不能不跑偏」，不是预设本身的行为；预设的行为要在 DSH 会话里看。

### 人工评分（讲解质量）

只对能读到正文的章做，每章打 1–5 分，三项各一行，写在回答文件的 `human` 字段里（`talk.mjs` 不读它，用来留档）：

| 维度 | 1 | 3 | 5 |
| --- | --- | --- | --- |
| 结构 | 一段流水账 | 有分段但顺序随意 | 先框架后细节，前后有承接 |
| 贴原文 | 大段自由发挥 | 关键点有出处 | 每个要点都能落到页，且不超出原文 |
| 可复述 | 看不懂 | 能跟着读一遍 | 合上课件能讲出来（有类比/对照） |

一个季度抽 10 章打一次分就够；它衡量的是「换了 persona 或 SKILL 之后有没有变好」，不是单次回答的合格线。

## baseline

`baseline.json` 是上一次通过时的记录：每块课件的 `reading` 数字与每个任务的通过状态。日常跑会对比它，出现「原本通过的任务失败」或「未读页数变化」就报 drift 并以非零退出。

生成 baseline 的课件不在仓库里（学生课件不该公开），所以 CI 只跑 `--fixture`；真实课件的 baseline 在本地机器上维护。
