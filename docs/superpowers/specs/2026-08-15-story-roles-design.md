# 设计文档：故事板角色扩展（story-teller 与 object-designer）

日期：2026-08-15
状态：已确认（2026-08-15 分节评审通过）

## 一、背景与目标

导演工作台当前只有「画布工作台」一个主界面（五区布局）。用户创作流程缺少画布之前的两步：

1. **story-teller（故事向导）**：一步步引导用户从 0 完善故事细节（主题→主角→配角→冲突→场景→结局）。
2. **object-designer（物体设计器）**：设计故事的场景、人物、物品，引导用户完成视觉描述，并通过 ComfyUI 生成成品图像作为参考图。

两个角色都位于画布之前，产出物（故事文档、设计描述、参考图）统一进入全局素材库（`~/.director/assets`），供画布节点引用。前端顶部增加两个路由（tab），点击切换到对应角色。

## 二、已确认的关键决策

| 维度 | 决策 |
|---|---|
| story-teller 形态 | 结构化问卷向导，预定义步骤 + AI 辅助（每步可选 pi 润色） |
| object-designer 形态 | 对象列表 + 表单（人物/场景/物品三类），ComfyUI 生成参考图 |
| 文生图模板 | 用户自备模板，目录扫描 + 下拉选择 |
| 路由 | URL hash 路由（`#/story-teller`、`#/object-designer`、`#/canvas`），顶栏 tab 切换 |
| 产出物 | 故事文档→txt/md 素材；设计描述→txt 素材；参考图→img 素材（均进全局素材库） |
| 持久化 | 项目内 `.director/story.json` + `.director/design.json`，跟随项目切换 |
| 实现方案 | 方案 A：复用现有 `/api/agent/chat` SSE 桥（仅换角色提示词）+ 新增领域 API |

## 三、架构

```
┌───────────────────────── 浏览器 ─────────────────────────┐
│  顶栏: [logo] [故事向导] [物体设计] [画布] [项目名] [ComfyUI] │
│                                                          │
│  #/story-teller      #/object-designer     #/canvas      │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────┐  │
│  │ StoryTeller  │   │ ObjectDesign │   │ 现有五区布局  │  │
│  │ 向导视图      │   │ 设计器视图    │   │ (画布/AGENT/  │  │
│  │              │   │              │   │  时间线)     │  │
│  └──────────────┘   └──────────────┘   └─────────────┘  │
└──────────────────────────┬──────────────────────────────┘
                           │ REST + SSE
┌──────────────────────────▼──────────────────────────────┐
│ Fastify 后端                                              │
│  ├─ /api/story            GET/PUT 进度 + POST /complete  │
│  ├─ /api/designs          CRUD 对象 + POST /:id/generate │
│  ├─ /api/workflows        列出 workflows/*.template.json │
│  └─ /api/agent/chat       复用（角色提示词由前端传）        │
│  ├─ src/story/            步骤定义 + story.json 读写      │
│  ├─ src/design/           design.json 读写 + 生成提交     │
│  └─ 现有: 素材库 / ComfyUI / 项目切换                      │
└──────────────────────────────────────────────────────────┘
```

### 3.1 路由（前端）

- 手写轻量 hash 路由：`useHashRoute()` hook（约 30 行），三视图条件渲染。
- 默认路由 `#/canvas`（现有画布工作台）。
- 顶栏三个 tab 高亮当前路由，点击切换（`window.location.hash` 赋值）。
- 不引入 react-router（避免新依赖，三视图 hash 足够）。

### 3.2 角色提示词（AI 辅助）

- 前端两个视图各持一份角色 system prompt：
  - story-teller：问卷润色器（基于当前步骤问题 + 已有答案，产出补充建议）。
  - object-designer：描述优化器（基于 name + style + 现有 description，产出优化后的视觉描述）。
- 发送时作为 message 前缀传给现有 `/api/agent/chat`（后端 `buildAgentPrompt` 已支持消息拼接），**零后端改动**即可让 pi 扮演对应角色。
- AI 辅助是**可选按钮**（「✨ AI 建议」/「✨ AI 优化描述」），不自动调用；流式输出追加到当前文本框末尾，用户可编辑后保留。

### 3.3 持久化

- `.director/story.json`：`{ step, answers: Record<stepId, string>, completedAt: string|null }`
- `.director/design.json`：`DesignObject[]`
- 跟随现有 `ctx.projectDir` 机制，切换项目时前端重新拉取。

## 四、story-teller 详细设计

### 4.1 预定义步骤（默认 6 步，定义集中在后端 `src/story/steps.ts`）

| # | id | 问题 | 提示词 | 必填 |
|---|---|---|---|---|
| 1 | theme | 故事主题是什么？ | 一句话主题（如「精灵与哥布林的战争与和解」） | ✅ |
| 2 | protagonist | 主角是谁？ | 身份、性格、目标 | ✅ |
| 3 | support | 配角有哪些？ | 每个配角一句话（可留空） | ❌ |
| 4 | antagonist | 冲突来自哪里？ | 对手/障碍/内在矛盾 | ✅ |
| 5 | scenes | 故事发生在哪些场景？ | 每个场景一句（进入 object-designer 的种子） | ✅ |
| 6 | ending | 结局如何？ | 开放/圆满/反转 | ✅ |

### 4.2 页面结构（每步一屏）

```
┌────────────────────────────────────────────────┐
│ 故事向导 · 第 2/6 步 · 进度条 ▓▓▓▓░░░░░░       │
│ ────────────────────────────────────────────── │
│ ❓ 主角是谁？                                   │
│    提示：身份、性格、目标…                      │
│ ┌───────────────────────────────────────────┐ │
│ │ textarea（草稿自动保存）                    │ │
│ └───────────────────────────────────────────┘ │
│ [✨ AI 建议]  ← 流式生成建议追加到文本框        │
│ 右侧: 本步回答摘要 + 前几步回顾                 │
│ ────────────────────────────────────────────── │
│      [← 上一步]          [下一步 →]            │
└────────────────────────────────────────────────┘
```

### 4.3 交互细节

- 每步输入**自动保存**（防抖 500ms → PUT /api/story），刷新/切换项目不丢。
- 「✨ AI 建议」→ 调 `/api/agent/chat`（角色提示词 + 已有答案）→ 流式输出**追加**到当前文本框末尾，可编辑后保留。
- 「下一步」校验必填项；未填弹提示。
- 最后一步「完成故事」→ 前端把全部答案汇总成 Markdown 文档 → `POST /api/story/complete` → 后端 `importAssetText()` 入库为 `story_<项目名>.md` 素材。
- 完成后再进向导显示「已完成」状态 + 重新生成入口（重新生成会清空 completedAt 并重新走步骤）。

### 4.4 后端 API

```
GET  /api/story              → { step, answers, completedAt }
PUT  /api/story              → 保存 { step, answers }（合并写入 story.json）
POST /api/story/complete     → 汇总文档 → 素材库入库 → 返回素材记录 + 更新 completedAt
```

## 五、object-designer 详细设计

### 5.1 对象模型（`design.json`）

```ts
interface DesignObject {
  id: string;            // uuid
  kind: 'character' | 'scene' | 'prop';  // 人物 / 场景 / 物品
  name: string;          // 如「精灵骑士」
  description: string;   // 视觉描述（AI 优化/手写）
  style: string;         // 风格（吉卜力风 / 写实 / 赛博…自由文本）
  template: string;      // 选定的文生图模板（如 my-t2i）
  status: 'draft' | 'generating' | 'done' | 'failed';
  assetId?: string;      // 生成的参考图素材 id
  error?: string;
  createdAt: number;
}
```

### 5.2 页面结构

```
┌──────────────────────────────────────────────────────┐
│ 物体设计器 · 3 类对象 · 5 个设计 · 2 张参考图           │
│ ┌─────────────┬─────────────┬─────────────┐          │
│ │ 👤 人物 (2) │ 🏞 场景 (2) │ 🎒 物品 (1) │          │
│ │  精灵骑士 ✓ │  迷雾森林 ✓ │  精灵地图    │          │
│ │  哥布林王   │  地下洞穴   │  [+ 新建]    │          │
│ │  [+ 新建]   │  [+ 新建]   │             │          │
│ └─────────────┴─────────────┴─────────────┘          │
│ ──────────────────────────────────────────────────── │
│ 名称   [精灵骑士________]                              │
│ 风格   [吉卜力风 ▾ 常用风格下拉+自由输入]                │
│ 描述   ┌───────────────────────────────────────────┐ │
│        │ textarea（草稿自动保存）                    │ │
│        └───────────────────────────────────────────┘ │
│ 模板   [my-t2i ▾] ← GET /api/workflows 扫描结果        │
│        [✨ AI 优化描述] [⚙ 生成参考图]                 │
│ 状态: ✅ 已生成 · 参考图缩略图（点击放大）               │
└──────────────────────────────────────────────────────┘
```

### 5.3 交互细节

- 三类对象 tab 分组 + 右侧选中对象详情表单；新建默认 focus 名称。
- 表单自动保存（防抖 500ms → PUT /api/designs/:id）。
- 「✨ AI 优化描述」→ agent 桥润色 description（基于 name + style + 现有描述）。
- 「⚙ 生成参考图」→ `POST /api/designs/:id/generate`：
  1. 后端 `buildWorkflow(template, { prompt, seed, width, height, ... })` — 提示词 = 风格 + 对象描述组装（风格优先）。
  2. 提交 ComfyUI → 轮询完成（复用现有 `ComfyUIClient.waitForDone`）。
  3. 下载图片 → `importAssetFile()` 入库 → 素材 id 写回对象 → status=done。
  4. 失败 → status=failed + error 文案，前端可重试。
- 生成中显示进度状态，期间按钮禁用；可删除对象（确认门）。
- ComfyUI 未连接时点生成：直接提示「请先配置 ComfyUI 地址」，不创建任务。

### 5.4 后端 API

```
GET    /api/designs            → DesignObject[]
POST   /api/designs            → 新建 { kind, name } → 返回对象
PUT    /api/designs/:id        → 更新字段（name/description/style/template）
DELETE /api/designs/:id        → 删除（confirm=true）
POST   /api/designs/:id/generate → 提交 ComfyUI → 入库 → 返回更新后对象
GET    /api/workflows          → 扫描 workflows/*.template.json → 名称列表
```

## 六、错误处理矩阵

| 场景 | 处理 |
|---|---|
| story.json / design.json 损坏或不存在 | 视为空进度，正常打开（不 500），写时重建 |
| 素材入库失败（磁盘满等） | complete/generate 返回 `{ code, message }`，前端提示 + 可重试 |
| ComfyUI 未连接时点生成 | 直接提示「请先配置 ComfyUI 地址」，不创建任务 |
| 生成中途失败（超时/节点报错） | 对象 status=failed + error，前端按钮恢复可重试 |
| 模板不存在（用户删了文件） | generate 返回 400「模板不存在」，下拉实时刷新 |
| 生成完成但无输出媒体 | 复用现有 `INVALID_PATCH` 语义 → failed + 明确文案 |
| 切换项目 | 两个视图监听 projectName 变化重新拉取，编辑中草稿保留在旧项目 |

## 七、测试策略

| 层 | 用例 |
|---|---|
| `src/story/store.test.ts` | story.json 读写/合并/损坏兜底/complete 入库 |
| `src/story/api.test.ts` | GET/PUT/complete 路由行为、素材入库断言 |
| `src/design/store.test.ts` | design.json CRUD、kind 校验、损坏兜底 |
| `src/design/generate.test.ts` | 模板不存在/ComfyUI 断开/成功入库/失败回写（mock ComfyUIClient） |
| `src/api/routes.test.ts` | workflows 扫描接口 |
| `web/src/story/StoryTeller.test.tsx` | 步骤渲染/自动保存/必填校验/AI 建议按钮 |
| `web/src/design/ObjectDesigner.test.tsx` | 三类分组/表单保存/生成状态流转 |
| `web/src/App.test.tsx` | hash 路由三视图切换、tab 高亮、默认进画布 |

## 八、验收标准

1. `pnpm test` 全部通过（现有 + 新增）。
2. `pnpm dev` 启动后：顶栏三 tab 切换正常、URL hash 同步、刷新保持路由。
3. story-teller 填完 6 步 → 素材库出现 `story_<项目>.md`。
4. object-designer 自备模板（临时放一个 mock t2i 模板）→ 生成 → 素材库出现参考图。

## 九、范围外（YAGNI）

- 不做 mmh3 YAML 导出联动（storyboard.yaml 协议）——后续单独任务。
- 不做 AI 动态生成步骤/追问。
- 不做 OpenReel 图像生成后端。
- 不做多故事版本管理。
