# 实施计划：项目栏显示内容定义修复（剧本项目 vs 工作台目录误判）

## Goal

厘清"剧本项目"的定义与协议，修复项目栏把工作台自身目录（`director-workbench`）当成项目显示的问题：项目栏只显示**剧本项目**（含 `mmh3_prompts/` 或 `prompts/` 的 mmh3 创作目录），不再把 `.director/project.json` 当作项目标记。

---

## 一、调研结论：剧本项目 vs 工作台项目

### 1.1 剧本项目（mmh3 创作项目）的定义 —— 依据协议与惯例

- **判定标记**：目录含 `mmh3_prompts/` 或 `prompts/`（mmh3 项目惯例，`src/projects/projects-store.ts` 注释与测试同源确认）。
- **标准结构**（`mmh3-storyboard-split` skill 产出，见 `/home/hr/.agents/skills/mmh3-storyboard-split/SKILL.md`「输出产物」）：
  ```
  mmh3_prompts/<项目名>/storyboard_split/
  ├── README.md              # 分镜总表
  ├── global_prompt.txt      # 全局提示词
  ├── shot_01.md … shot_0K.md # 分镜卡（含 "- 时长：" 元数据行）
  ├── storyboard.yaml        # MMH3 Prompt YAML 协议 v1
  └── keyframes/README.md
  ```
- **协议层**：`docs/mmh3-prompt-yaml-protocol.md`（协同仓库）定义三方（skill / director-workbench / ComfyUI 节点）统一格式；工作台侧实现为 `src/prompt/protocol.ts`。
- **实际用法佐证**：`scripts/dev.sh` 注释示例 `./scripts/dev.sh /media/hr/Data/mmh3-creation/elf-and-goblin/mmh3_prompts/elf_and_goblin` —— 服务器 projectDir 直接指向 `mmh3_prompts/<场景>` 目录，即"项目 = mmh3 创作目录"。

### 1.2 `.director/` 的语义 —— 工作台运行时数据目录，不是项目标记

- 内容：`project.json`（图数据）+ `snapshots/`（`base.json` + `snapshot-N.json`）。
- 写入链路：`src/api/mutations.ts` 的 `applyMutation()` 是唯一写入口（`saveGraph` + `recordSnapshot`），任何写操作（创建节点、配置 ComfyUI 地址等）都会在**任意被打开过的目录**生成 `.director/`。
- **证据**：`/media/hr/Data/Codes/director-workbench/.director/snapshots/snapshot-1.json` 的 reason 为 `配置 ComfyUI 地址 http://localhost:55554`，共 15 个快照 —— 全部是开发测试遗留，非剧本内容。
- 工作台自己的工作区逻辑（`src/workspace/accessor.ts` EXCLUDES）都把 `.director/` 排除在外，说明它自认为 `.director` 不是项目内容。
- 素材库为全局（`~/.director/assets`，`src/assets/assets-store.ts`），与单项目无关。

### 1.3 误判链路（现状问题根因）

```
用户在工作台目录跑 ./scripts/dev.sh（缺省 pwd）
  → projectDir = /media/hr/Data/Codes/director-workbench   (src/index.ts:51)
  → listProjects() 无条件 push 当前项目 (projects-store.ts:118)
  → looksLikeProject() 把 .director/project.json 当标记 (projects-store.ts:13-20)
  → 项目栏第一项 = "director-workbench"（用户看到的现象）
```

### 1.4 数据流现状

```
GET /api/projects → listProjects(ctx.projectDir)  (routes.ts:49)
  发现根：DIRECTOR_PROJECTS_DIR（可选）+ projectDir 向上 3 层祖先
  无条件 push 当前项目 → 扫描每个根一层子目录 + mmh3_prompts/* 二层子目录（looksLikeProject 判定）
  → ProjectInfo[] {path, name, current, shots, duration, mode}（按名称排序）
POST /api/project/switch → resolveSwitchTarget 校验存在目录 → 整体替换 ctx（projectDir/comfy/queue/ws）→ 返回新图+新列表
前端：App.tsx activePath = projects.find(p => p.current)?.path ?? ''；ProjectList.tsx 渲染 pname/pmeta/pmode/active；空态文案"正在扫描项目…"
```

---

## 二、修复方案对比

| 方案 | 做法 | 优点 | 缺点 / 风险 | 兼容性 |
|---|---|---|---|---|
| **A. 收紧标记** | `looksLikeProject` 去掉 `.director/project.json`，仅 `mmh3_prompts`/`prompts` | 语义干净，直接消灭误判；工作台目录、任意被开过的目录都不再入列 | 无 mmh3 标记的"纯工作台图目录"不再被发现；**当前项目仍无条件入列**，需一并处理（见方案 E） | 无影响（mmh3 项目都有 mmh3_prompts） |
| **B. 排除代码目录** | 排除含 package.json / src 的目录 | 针对性强 | 启发式脆弱（无法覆盖任意被打开的目录）；工作台安装位置不固定 | 低 |
| **C. project.json 加标记字段** | 如 `"kind": "workbench"` 显式区分 | 显式可控 | 需要迁移存量文件；`.director` 语义仍是运行时数据，"字段标记"治标不治本；手工创建的 .director 无字段 | 低 |
| **D. 限定 DIRECTOR_PROJECTS_DIR** | 仅当环境变量设置时才扫描兄弟目录 | 配置明确 | 行为变更大（丢掉"无环境变量发现同根项目"）；当前项目=工作台目录时仍会显示，治标不治本 | 中 |
| **E（推荐）= A + 当前项目判定** | A + 当前项目也走剧本标记判定（无标记不入列）；前端空态与高亮适配 | 完整解决用户诉求：项目栏 = 剧本项目栏；逻辑单一（一个判定函数） | 行为变化：打开非剧本目录时项目栏为空/无高亮，需接受；顶栏项目名仍显示目录名 | 高（协同侧无依赖） |

---

## 三、推荐方案 E 的实施步骤

### Task 1: 后端收紧项目判定
- File: `src/projects/projects-store.ts`
- Changes:
  1. `looksLikeProject()`：判定条件改为 `mmh3_prompts || prompts`（删除 `.director/project.json` 一项），注释更新为"剧本项目判定：mmh3 创作目录惯例"。
  2. 当前项目入列逻辑：`listProjects` 中 `pushProject(out, seen, projectDir, projectDir)` 改为先经 `looksLikeProject` 判定，不满足则不入列（同时不把 current 标记强加给任何其他项）。
  3. `statProject` 的 `fromGraph` 分支保留（有 `.director` 用图数据统计，否则扫 `shot_*.md`）——统计逻辑与判定逻辑解耦，不动。
- Acceptance:
  - 单测：新用例「仅含 `.director/project.json` 的目录不出现在项目列表」通过。
  - 现有 `project-switch.test.ts` 全部用例仍通过（proj-a/proj-b 均含 mmh3_prompts）。

### Task 2: 前端空态与高亮适配
- File: `web/src/panels/ProjectList.tsx`、`web/src/App.tsx`
- Changes:
  1. 空态文案区分：加载中（`正在扫描项目…`）与已加载但无剧本项目（如 `未发现剧本项目 · 可在项目根设置 DIRECTOR_PROJECTS_DIR 或使用 ＋导入`）。需要给 ProjectList 增加 `loading` 或 `scanned` prop（或复用现有 props 语义，具体实现时定）。
  2. `activePath` 逻辑不变（`projects.find(p => p.current)?.path ?? ''`，无匹配即无高亮，可接受）；顶栏项目名继续显示 `graph.projectName`（当前工作目录），保持不变。
- Acceptance:
  - `web/src/App.test.tsx` 通过；新增/调整空态文案用例（如 mock 空 projects 时显示新文案）。

### Task 3: 测试补充
- File: `src/api/project-switch.test.ts`
- Changes: 新增用例：构造一个只有 `.director/project.json` 的目录（`dir + '.director/project.json'` 写入），断言其不在 `GET /api/projects` 结果中；当前项目为纯 `.director` 目录时列表不含 current 项。
- Acceptance: `npx vitest run src/api/project-switch.test.ts` 全绿。

### Task 4（可选，需用户确认）: 清理工作台自身 `.director/` 测试遗留
- File: `/media/hr/Data/Codes/director-workbench/.director/`（删除整个目录）
- Changes: 删除 15 个快照 + project.json（全部为"配置 ComfyUI 地址"测试操作）。
- Acceptance: 修复生效后即使不删除也不再出现在项目栏；删除仅是为目录整洁。**属用户数据，需显式确认后执行。**

### Task 5（可选）: 文档化剧本项目定义
- File: `.agents.md`（协同约定文件）追加"项目栏定义"小节，或在仓库新增 `docs/project-definition.md`
- Changes: 写明：项目 = 含 mmh3_prompts/prompts 的创作目录；.director 为工作台运行时数据；DIRECTOR_PROJECTS_DIR 用法；dev.sh 示例用法。

---

## 四、需要用户确认的问题

1. **当前项目不是剧本项目时是否完全不显示**（推荐：是，项目栏只放剧本项目；顶栏项目名仍显示当前目录名）？
2. 是否接受 `shot_*.md` 散落（无 mmh3_prompts 结构）的目录暂不纳入项目栏（保持严格判定）？
3. 是否删除 director-workbench 自身的 `.director/`（开发测试遗留，15 个快照）？
4. 空态是否要加"导入/新建剧本项目"引导按钮（`ImportDialog` 已存在，可复用）？

## 五、风险

- 行为变更：在非剧本目录打开工作台时，项目栏为空（原先显示该目录）——需用户接受。
- 场景目录（`mmh3_prompts/*`）仍作为平铺项目项显示（与"项目"定义略有出入），本计划不改，可作为后续优化（分组/缩进）。
- 依赖项：无新增依赖；改动集中在 `projects-store.ts` + 前端文案 + 测试。

## Files to Modify
- `src/projects/projects-store.ts`
- `src/api/project-switch.test.ts`
- `web/src/panels/ProjectList.tsx`
- `web/src/App.tsx`（仅空态/文案相关，若有）
- `web/src/App.test.tsx`（空态用例）

## New Files
- 无（可选：`docs/project-definition.md`）

## Dependencies
- 无新增依赖。
- 协同仓库（ComfyUI-MiniMax-H3-Long-Video）无改动需求；协议（mmh3-prompt-yaml-protocol v1）不受影响。

## 验证方式
1. `npx vitest run src/api/project-switch.test.ts web/src/App.test.tsx`
2. 手动：在 director-workbench 目录运行 `./scripts/dev.sh` → 项目栏不应出现 director-workbench；用 `./scripts/dev.sh <含 mmh3_prompts 的目录>` → 正常显示并高亮。
