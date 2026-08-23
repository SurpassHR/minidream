# Workflow Plugin Schema Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户通过上传和表单配置把任意 ComfyUI 工作流变成可供后端和 LLM 使用的工作流插件，而不再为每个新工作流编写专用代码。

**Architecture:** 保留原始工作流 JSON 与最终映射清单分离。新增 manifest store 负责 `server/data/workflow-plugins/` 下的原子读写，workflow catalog 统一发现内置/导入工作流并优先读取完整 manifest；现有 `buildPrompt()` 继续消费 `WorkflowSpec` 的 `nodeId + field` 映射。新增插件管理 API 和独立 `WorkflowMappingModal`，MCP `workflow.list` 只暴露经过 hidden 过滤的面向 LLM 契约。

**Tech Stack:** Node.js 22+, TypeScript/Express, Vitest, React 18, Vite；不新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-08-23-workflow-plugin-schema-mapping-design.md`

## Global Constraints

- 采用表单式映射编辑器，不实现完整节点图编辑器。
- 导入入口为前端上传 JSON 文件。
- 自动 introspection 只负责生成初始映射；映射数量和节点结构固定，用户只能编辑描述元数据与参数配置值。
- 内置工作流和导入工作流统一纳入可编辑清单体系。
- 采用每个插件一个完整清单文件的方案，清单是最终 spec 的事实来源。
- 原始工作流图和映射清单分离；编辑器只修改清单，不修改原始工作流 JSON。
- 启用/停用继续使用现有 `settings.plugins.disabled`，不移动到清单文件。
- `hidden: true` 的映射参与运行时注入，但不显示在普通参数面板，也不暴露给 MCP。
- 不向 LLM 暴露底层 `nodeId`、`field`、本地文件路径或内部存储信息。
- 导入和清单保存使用临时文件加 rename 的原子写入方式。
- ComfyUI 不可用时仍允许读取和编辑已保存清单，节点候选从工作流 JSON 兜底。
- 现有任务队列、ComfyUI 提交/监听和产物处理链路保持复用。

---

### Task 1: 建立 manifest 数据模型与原子存储

**Files:**
- Create: `server/src/workflow-plugin-store.ts`
- Create: `server/src/workflow-plugin-store.test.ts`
- Modify: `server/src/workflow.ts: WorkflowInput/WorkflowParam/WorkflowOutput/WorkflowSpec interfaces`

**Interfaces:**
- Produces `WorkflowManifestSource`, `WorkflowManifestRecord`、manifest 目录常量，以及 `readManifest`, `writeManifest`, `listManifests`, `deleteManifest` 等函数。
- `writeManifest` 必须接受可注入的根目录或路径，测试使用临时目录，生产使用 `server/data/workflow-plugins`。
- 清单记录的输入、参数、输出类型必须复用或扩展现有 `WorkflowSpec`，不要复制第二套运行时类型。

- [ ] **Step 1: 写失败测试，覆盖清单文件读写和损坏回退信号**

在 `workflow-plugin-store.test.ts` 使用 `mkdtemp` 创建临时根目录，验证：

```ts
it('以原子方式写入并读取完整 manifest', () => {
  const record = makeManifest({ id: 'demo', source: { type: 'imported', workflowFile: 'workflows/demo.json' } });
  writeManifest(root, record);
  expect(readManifest(root, 'demo')).toEqual(record);
  expect(fs.existsSync(path.join(root, 'demo.json.tmp'))).toBe(false);
});

it('区分不存在清单与损坏清单', () => {
  expect(readManifest(root, 'missing')).toEqual({ status: 'missing' });
  fs.writeFileSync(path.join(root, 'broken.json'), '{');
  expect(readManifest(root, 'broken')).toMatchObject({ status: 'invalid' });
});
```

同时测试 `listManifests()` 只返回合法文件名、`deleteManifest()` 不影响其他插件清单。

- [ ] **Step 2: 运行定向测试确认失败**

Run: `cd server && pnpm exec vitest run src/workflow-plugin-store.test.ts`

Expected: FAIL because the store module and manifest result types do not exist.

- [ ] **Step 3: 增加清单字段类型和存储实现**

在 `workflow.ts` 的三个映射接口增加：

```ts
description?: string;
hidden?: boolean;
```

`WorkflowSpec` 增加：

```ts
source?: { type: 'bundled' | 'imported'; workflowFile: string };
hasManifest?: boolean;
editable?: boolean;
manifestError?: string;
```

在 `workflow-plugin-store.ts` 实现：

- `WORKFLOW_PLUGIN_DATA_DIR`、`IMPORTED_WORKFLOWS_DIR`、`MANIFESTS_DIR` 默认指向 `server/data/workflow-plugins` 及其 `workflows` 子目录；
- `readManifest()` 返回 `missing | valid | invalid` 三态结果，不在读取阶段静默删除损坏文件；
- `writeManifest()` 创建目录，写 `${id}.json.tmp` 后 rename 到 `${id}.json`；
- `writeWorkflowJson()` 使用同样的临时文件 + rename；
- `deleteManifest()` 和 `deleteImportedWorkflow()` 只删除明确指定的文件；
- 所有 ID 只能匹配 `[a-z0-9][a-z0-9_-]{0,63}`，避免路径穿越。

- [ ] **Step 4: 运行定向测试确认通过**

Run: `cd server && pnpm exec vitest run src/workflow-plugin-store.test.ts`

Expected: PASS.

- [ ] **Step 5: 提交独立存储单元**

```bash
git add server/src/workflow-plugin-store.ts server/src/workflow-plugin-store.test.ts server/src/workflow.ts
git commit -m "feat: add workflow plugin manifest store"
```

---

### Task 2: 统一内置/导入工作流 catalog 与 manifest 合并

**Files:**
- Create: `server/src/workflow-catalog.ts`
- Create: `server/src/workflow-catalog.test.ts`
- Modify: `server/src/workflow.ts: loadWorkflowFiles/buildSpecs/buildSpecsCached/getWorkflowJson/invalidateComfyCaches`
- Modify: `server/src/workflow.test.ts`

**Interfaces:**
- Consumes `introspectWorkflow`, `buildPrompt` 所需的现有 API，以及 Task 1 的 manifest store。
- Produces `listWorkflowCatalog()`, `getWorkflowCatalogItem(id)`, `readWorkflowSpec(id)` 和 `redetectWorkflowManifest(id)`；这些函数供 HTTP API 与执行队列使用。
- `loadWorkflowFiles()` 和 `getWorkflowJson()` 必须继续保留现有导出，改为同时支持内置和导入来源，保证 `TaskQueue` 不需要针对导入插件增加分支。

- [ ] **Step 1: 写失败测试，覆盖三种 spec 来源和导入工作流执行源**

使用临时 bundled/imported 目录与 mock object_info，测试：

```ts
it('无 manifest 的内置工作流使用自动识别', async () => {
  const spec = await readWorkflowSpec('bundled_demo');
  expect(spec.hasManifest).toBe(false);
  expect(spec.editable).toBe(true);
  expect(spec.inputs[0]?.description).toBeUndefined();
});

it('有 manifest 的内置工作流使用完整清单而非自动结果', async () => {
  writeManifest(root, manifestWith({ id: 'bundled_demo', description: '手工用途', inputs: [] }));
  const spec = await readWorkflowSpec('bundled_demo');
  expect(spec.description).toBe('手工用途');
  expect(spec.hasManifest).toBe(true);
});

it('导入工作流从 imported JSON 和 manifest 读取', async () => {
  writeWorkflowJson(root, 'imported_demo', apiFixture);
  writeManifest(root, manifestWith({ id: 'imported_demo', source: { type: 'imported', workflowFile: 'workflows/imported_demo.json' } }));
  expect(getWorkflowJson('imported_demo')).toEqual(apiFixture);
  expect((await readWorkflowSpec('imported_demo')).source?.type).toBe('imported');
});
```

再测试损坏的 bundled manifest 回退并设置 `manifestError`，损坏的 imported manifest 不进入可执行 spec 结果但仍能被管理 API 标记为不可用。

- [ ] **Step 2: 运行定向测试确认失败**

Run: `cd server && pnpm exec vitest run src/workflow-catalog.test.ts src/workflow.test.ts`

Expected: FAIL because no catalog module discovers imported workflows or applies manifests.

- [ ] **Step 3: 实现 catalog 发现、清单读取和自动结果合并**

实现以下规则：

1. 扫描 `server/workflows/*.json` 生成 bundled 项，扫描 `server/data/workflow-plugins/workflows/*.json` 生成 imported 项；ID 冲突时 bundled 项优先，导入接口提前拒绝冲突。
2. 对 bundled 项先运行现有 `introspectWorkflow()`，没有 manifest 时返回自动 spec。
3. 对有 manifest 的项读取完整清单，补充 `source`, `hasManifest: true`, `editable: true`，不重新合并自动识别结果。
4. bundled manifest JSON 损坏时返回自动 spec 并设置 `manifestError`；imported manifest 损坏时从普通执行 spec 中排除，但 catalog 管理结果包含 `available: false` 和错误信息。
5. 首次编辑 bundled 插件时由 catalog 提供当前自动 spec，API 层负责将其写成 manifest。
6. `redetectWorkflowManifest()` 基于当前原始 JSON 重新 introspect，按 `nodeId + field` 匹配 inputs/params，按 `nodeId` 匹配 outputs，保留用户的 `description`, `label`, `required`, `hidden`, `id` 和参数配置；失效映射不自动保留，新映射追加。
7. `buildSpecsCached()` 使用统一 catalog 结果并在写/删除 manifest 或导入 JSON 后调用 `invalidateComfyCaches()`。
8. `getWorkflowJson()` 能返回 imported 原始 JSON，`buildPrompt()` 的调用方式和注入逻辑不变。

- [ ] **Step 4: 补充回归测试并运行**

Run: `cd server && pnpm exec vitest run src/workflow-catalog.test.ts src/workflow.test.ts`

Expected: PASS，原有工作流转换、注入、模型校验和新增 catalog 场景全部通过。

- [ ] **Step 5: 提交 catalog 单元**

```bash
git add server/src/workflow-catalog.ts server/src/workflow-catalog.test.ts server/src/workflow.ts server/src/workflow.test.ts
git commit -m "feat: unify bundled and imported workflow catalog"
```

---

### Task 3: 实现插件管理 HTTP API 与 LLM workflow contract

**Files:**
- Create: `server/src/workflow-plugin-api.ts`
- Create: `server/src/workflow-plugin-api.test.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/mcp/server.ts`
- Modify: `server/src/mcp/server.test.ts`

**Interfaces:**
- `registerWorkflowPluginRoutes(app, options)` 注册 `/api/plugins` 和扩展后的 `/api/workflows`；options 注入 catalog、manifest store、settings file 和 ComfyUI object_info 获取函数，测试不启动真实监听端口。
- `serializeWorkflowForLlm(spec)` 只返回 LLM 允许的字段，并过滤 `hidden`。
- MCP `workflow.list` 使用同一 serializer，避免 HTTP 和 LLM 契约分叉。

- [ ] **Step 1: 写失败测试，覆盖导入、冲突、保存校验、重识别和删除**

在 `workflow-plugin-api.test.ts` 使用 Express 测试 app 或直接调用导出的 handler，覆盖以下请求结果：

```ts
it('导入 API 格式工作流并创建初始 manifest', async () => {
  const response = await callImport({ filename: 'demo.json', workflow: apiFixture });
  expect(response.status).toBe(200);
  expect(readManifest(root, 'demo').status).toBe('valid');
  expect(getWorkflowJson('demo')).toEqual(apiFixture);
});

it('导入 UI 格式工作流并在 ID 冲突时返回 409', async () => {
  await callImport({ filename: 'demo.json', workflow: uiFixture });
  const conflict = await callImport({ filename: 'demo.json', workflow: uiFixture });
  expect(conflict.status).toBe(409);
});

it('拒绝引用不存在节点或字段的 manifest', async () => {
  const response = await callPut('demo', { ...validManifest, inputs: [{ ...validInput, nodeId: 'missing' }] });
  expect(response.status).toBe(400);
  expect(response.body.error).toMatch(/inputs.*missing/);
});

it('重识别只返回合并结果，不自动写入 manifest', async () => {
  const result = await callRedetect('demo');
  expect(result.status).toBe(200);
  expect(result.body.inputs[0].description).toBe('手工描述');
  expect(readManifest(root, 'demo')).toEqual(previousManifest);
});
```

再覆盖 PUT 的类型、分组内 ID 唯一、至少一个 output、`applyTo` 节点存在性校验，以及 imported/bundled 删除差异。

- [ ] **Step 2: 运行定向测试确认失败**

Run: `cd server && pnpm exec vitest run src/workflow-plugin-api.test.ts`

Expected: FAIL because routes, serializer and manifest validation are not implemented.

- [ ] **Step 3: 实现 API 路由与 manifest 校验**

实现：

- `POST /api/plugins/import` 接收 `{ name?, filename?, workflow, overwrite? }`；确认 JSON 是 API 或 UI 格式；UI 格式通过现有 `convertUiToApi()` 校验/转换但保存原始 JSON；从安全 slug 生成 ID；与 bundled 或 imported ID 冲突时未显式覆盖返回 409，`overwrite` 只允许替换现有 imported 原始 JSON 和 manifest，不能破坏 `server/workflows` 内置源文件；保存 workflow 后保存初始 manifest。
- `GET /api/plugins` 返回 bundled/imported 全部管理项，包括 `source`, `hasManifest`, `enabled`, `available`, `manifestError`, spec。
- `GET /api/plugins/:id/nodes` 返回可达节点的 `nodeId`, `classType`, title 和字段候选；优先 object_info 合并字段类型，object_info 失败时从 API inputs 值推断；输出类节点也包含在候选中。
- `PUT /api/plugins/:id` 接收完整 manifest，强制 ID 与 URL 一致，校验 node/field/kind/type、分组 ID 唯一、`applyTo` 节点存在、至少一个非空 output；允许 description 为空；原子写入并清缓存。
- `POST /api/plugins/:id/redetect` 返回 catalog 的合并清单，不写文件。
- `DELETE /api/plugins/:id` 删除 imported workflow + manifest；bundled 只删除 manifest；清缓存。
- 现有 `GET /api/workflows` 改为从 catalog 读取，返回 spec 元信息与各映射 description/hidden，供普通前端和编辑器复用。

- [ ] **Step 4: 修改 MCP workflow.list 并写失败/通过测试**

将 `mcp/server.ts` 中的 simplified 逻辑替换为共享 serializer。输出结构保持工作流 `id/name/description`，输入包含 `kind/label/description/required`，参数包含 `id/label/type/description/default/min/max/有限 options`，输出包含 `kind/label/description`；不输出 `nodeId`, `field`, `hidden`, 本地路径。新增测试：

```ts
it('workflow.list 暴露映射 description、params 并过滤 hidden', async () => {
  const result = await callTool('workflow.list', {});
  const workflow = JSON.parse(result.content[0].text)[0];
  expect(workflow.inputs[0]).toMatchObject({ description: '画面主体描述' });
  expect(workflow.inputs.some((input: any) => input.label === '内部提示')).toBe(false);
  expect(workflow.params[0]).toMatchObject({ description: '采样步数' });
  expect(workflow.params[0]).not.toHaveProperty('nodeId');
});
```

Run: `cd server && pnpm exec vitest run src/workflow-plugin-api.test.ts src/mcp/server.test.ts`

Expected: PASS.

- [ ] **Step 5: 注册路由、更新现有接口并提交后端 API 单元**

在 `index.ts` 连接真实 `SETTINGS_FILE`、catalog 和 `getObjectInfo()`，保留现有 settings/plugins 启停和参数配置接口；确保 `/api/workflows` 的调用不再直接依赖 bundled 目录。运行：

```bash
cd server && pnpm exec tsc --noEmit
cd server && pnpm exec vitest run src/workflow-plugin-api.test.ts src/mcp/server.test.ts
```

然后提交：

```bash
git add server/src/workflow-plugin-api.ts server/src/workflow-plugin-api.test.ts server/src/index.ts server/src/mcp/server.ts server/src/mcp/server.test.ts
git commit -m "feat: expose workflow plugin mapping APIs"
```

---

### Task 4: 增加前端类型、请求封装和映射编辑器

**Files:**
- Create: `web/src/components/WorkflowMappingModal.tsx`
- Modify: `web/src/api.ts`
- Modify: `web/src/components/SettingsModal.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.css`

**Interfaces:**
- `WorkflowMappingModal` props：`plugin: WorkflowPluginRecord`, `nodes: WorkflowNodeCandidate[]`, `onSave(manifest)`, `onRedetect()`, `onClose()`；组件只管理编辑草稿，不直接读取或写浏览器文件系统以外的数据。
- `api.ts` 新增 `WorkflowPluginRecord`, `WorkflowManifest`, `WorkflowNodeCandidate` 和 `fetchPlugins`, `importWorkflowPlugin`, `fetchWorkflowNodes`, `saveWorkflowManifest`, `redetectWorkflowManifest`, `deleteWorkflowPlugin`。
- `WorkflowSpec` 的输入/参数/输出类型补上 `description`, `hidden`, `applyTo` 等服务端返回字段，并增加 `source/hasManifest/editable/manifestError` 元数据。

- [ ] **Step 1: 先定义前端数据类型和纯请求函数**

在 `api.ts` 中使用与后端 JSON 一致的结构：

```ts
export interface WorkflowNodeCandidate {
  nodeId: string;
  classType: string;
  title: string;
  fields: Array<{ field: string; type: string; connected: boolean }>;
}

export interface WorkflowPluginRecord extends WorkflowSpec {
  source: { type: 'bundled' | 'imported'; workflowFile: string };
  hasManifest: boolean;
  editable: boolean;
  enabled: boolean;
  available: boolean;
  manifestError?: string;
}

export async function fetchPlugins(): Promise<WorkflowPluginRecord[]> { return http('/api/plugins'); }
export async function fetchWorkflowNodes(id: string): Promise<{ nodes: WorkflowNodeCandidate[] }> { return http(`/api/plugins/${encodeURIComponent(id)}/nodes`); }
export async function saveWorkflowManifest(id: string, manifest: WorkflowManifest): Promise<{ ok: boolean; plugin: WorkflowPluginRecord }> {
  return http(`/api/plugins/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
}
```

实现 import/redetect/delete 的同样错误传播；导入请求 body 使用 `{ filename, name, workflow, overwrite }`。

- [ ] **Step 2: 创建编辑器并完成草稿状态转换**

`WorkflowMappingModal` 打开时展示三组固定映射行：

- 输入行锁定 kind、外部 `id`、nodeId、field、classType；允许编辑 label、description、required、hidden；
- 参数行锁定 type、id、nodeId、field、applyTo；允许编辑 label、description、default/min/max/step/options、hidden；
- 输出行锁定 kind、id、nodeId、classType；允许编辑 label、description、hidden；
- 映射行数固定，不提供添加或删除操作；
- 节点 ID、classType、字段和连接关系以只读形式展示；不提供可改变节点结构的下拉操作；
- “重新识别”调用后端并只刷新已有映射的自动识别值，不改变映射数量或结构，显示“结果尚未保存”的提示；
- “取消”直接关闭且不触发保存；
- 保存前检查固定 ID/结构、参数范围格式和至少一个可用输出，后端错误显示在 modal 内。

把表单行拆成局部渲染函数或小组件，避免把所有输入控件集中成不可维护的单一 JSX 分支；不要修改原始 workflow JSON。

- [ ] **Step 3: 集成 SettingsModal 的导入和编辑入口**

在插件设置区增加：

- 隐藏的 `input type="file" accept=".json,application/json"` 和“导入工作流”按钮；读取 `File.text()` 后 `JSON.parse`，调用 `importWorkflowPlugin()`；
- 409 时显示覆盖确认，确认后带 `overwrite: true` 重试；成功后刷新工作流列表和插件列表并打开对应编辑器；
- 每个插件显示编辑映射按钮、来源、清单损坏提示、不可用状态、删除按钮；内置删除只删除 manifest，导入删除 workflow + manifest；
- 编辑按钮加载 `/nodes` 候选和当前 plugin record，打开 `WorkflowMappingModal`；保存后刷新 `workflows` 并保留当前 Settings 分类；
- 保留现有插件启停与 combo 参数配置草稿/保存行为，不让编辑 manifest 的保存绕过 `savePluginsSettings`。

在 `App.tsx` 让 `onRefreshWorkflows` 作为编辑成功后的刷新回调；必要时将 `fetchPlugins()` 结果与现有 `/api/workflows` 列表按 `id` 合并，而不是复制另一份插件状态。

- [ ] **Step 4: 添加编辑器样式并完成前端编译验证**

在 `App.css` 增加 modal 遮罩、头部/底部操作栏、分组卡片、映射行、节点/字段下拉、错误提示、移动端横向滚动/窄屏布局样式；复用现有 CSS 变量和 settings 控件视觉，不引入新的 UI 库。

Run: `cd web && pnpm exec tsc --noEmit && pnpm run build`

Expected: PASS.

- [ ] **Step 5: 提交前端单元**

```bash
git add web/src/api.ts web/src/components/WorkflowMappingModal.tsx web/src/components/SettingsModal.tsx web/src/App.tsx web/src/App.css
 git commit -m "feat: add workflow mapping editor"
```

---

### Task 5: 端到端回归、清单恢复和交付验证

**Files:**
- Modify: `server/src/workflow-plugin-store.test.ts`
- Modify: `server/src/workflow-catalog.test.ts`
- Modify: `server/src/workflow-plugin-api.test.ts`
- Modify: `server/src/workflow.test.ts`
- Modify: `server/src/mcp/server.test.ts`
- Modify: `docs/superpowers/specs/2026-08-23-workflow-plugin-schema-mapping-design.md` only if implementation reveals a confirmed contract correction

**Interfaces:**
- Verifies the final contracts from Tasks 1–4 without introducing a second plugin path.
- Uses the existing fixtures in `server/src/workflow.test.ts` (`uiFixtureJson`, Krea2, SeedVR2, H3) as import and redetect fixtures.

- [ ] **Step 1: 增加清单恢复和运行时注入回归测试**

验证导入的 UI 工作流经过 manifest 编辑后仍能走现有 `buildPrompt()`：

```ts
it('导入工作流的手动输入映射仍驱动现有 buildPrompt 注入', async () => {
  const spec = await readWorkflowSpec('demo');
  const prompt = await buildPrompt(spec, getWorkflowJson('demo')!, {
    prompt: '手动映射提示词',
    uploaded: { 'reference-image': 'uploaded.png' },
    params: { 'sampling-steps': 28 },
  });
  expect(prompt['6'].inputs.text).toBe('手动映射提示词');
  expect(prompt['17'].inputs.image).toBe('uploaded.png');
  expect(prompt['3'].inputs.steps).toBe(28);
});
```

同时验证 hidden 映射仍参与注入、manifest 删除后 bundled 工作流恢复自动 introspection、导入清单损坏不会删除原始 JSON。

- [ ] **Step 2: 运行完整后端类型检查和测试**

Run:

```bash
cd server && pnpm exec tsc --noEmit
cd server && pnpm exec vitest run
```

Expected: PASS with all existing workflow, settings, MCP and queue regression tests.

- [ ] **Step 3: 运行完整前端构建**

Run:

```bash
cd web && pnpm exec tsc --noEmit && pnpm run build
```

Expected: PASS with no TypeScript or Vite errors.

- [ ] **Step 4: 做手工验收矩阵**

启动开发服务后验证：

1. 插件设置中上传现有 `server/workflows` 的 UI JSON，成功创建 imported 插件并自动打开编辑器。
2. 修改工作流用途 description、一个输入 node/field、一个参数范围和一个输出 description，保存后刷新页面仍存在。
3. hidden 输入/参数不出现在生成普通设置和 MCP `workflow.list`，但任务提交仍能使用它们。
4. 点击重新识别，确认手写 description/label 保留；取消不落盘。
5. 删除 imported 插件后原始工作流和清单都消失；删除 bundled 插件后仓库 JSON 仍存在且自动 spec 恢复。
6. ComfyUI 断开时仍能读取/编辑 manifest，节点候选接口能返回 JSON 推断字段。
7. 使用导入插件提交一次真实任务，确认 `buildPrompt`、TaskQueue、ComfyUI 产物回传链路无需专用代码。

- [ ] **Step 5: 提交最终回归修改并检查工作区**

```bash
git add server/src web/src
 git commit -m "test: verify workflow plugin mapping end to end"
git status --short
```

Expected: `git status --short` 只显示用户此前已有的无关修改（如果存在），不显示本功能未提交文件。
