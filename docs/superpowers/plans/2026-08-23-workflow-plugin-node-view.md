# 工作流插件节点视图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在现有工作流插件映射编辑器中增加只读节点图，让用户勾选任意普通 widget 参数，并在表单视图配置已勾选参数的 description 和默认值。

**Architecture:** 后端新增独立 graph builder，复用 `workflow.ts` 的 UI→API 转换和 `object_info` 语义，输出节点、字段和连接线 DTO。前端新增节点画布组件，`WorkflowMappingModal` 用同一份 draft 在节点视图和表单视图之间联动；`manifest.params` 是唯一参数选择来源，输入和输出结构继续锁定。

**Tech Stack:** TypeScript, Express, React, CSS, SVG, Vitest, Vite, pnpm

**Spec:** `docs/superpowers/specs/2026-08-23-workflow-plugin-node-view-design.md`

## Global Constraints

- 节点图只读，不修改原始 workflow JSON、节点、连接或保存位置。
- 输入和输出映射数量及节点结构固定；只有 params 可以因勾选新增或删除。
- 连接字段不可勾选，只有普通 widget 字段可以进入 params。
- 取消已配置参数必须确认；重新勾选使用新默认配置，不恢复旧 description 和参数值。
- graph builder 必须支持 API/UI 两种 workflow；UI 转换复用 `convertUiToApi()`。
- `/object_info` 不可用时使用 workflow JSON 的值推断基本类型，不阻止已有清单编辑。
- 不引入新的前端画布库；使用仓库现有 React/CSS/SVG 技术栈。
- MCP `workflow.list` 和生成链路继续读取同一份 `WorkflowSpec` / manifest。

---

### Task 1: 建立 Workflow Graph DTO 与解析器

**Files:**
- Create: `server/src/workflow-graph.ts`
- Test: `server/src/workflow-graph.test.ts`
- Do not modify: `server/src/workflow.ts`; use its existing exported `convertUiToApi()` and `isUiFormat()` functions directly

**Interfaces:**
- Consumes: `convertUiToApi`, `isUiFormat`, `WorkflowSpec`, `WorkflowParam`, `WorkflowInput`, `WorkflowOutput` from `server/src/workflow.ts`; `object_info` shaped as the existing `Record<string, any>`.
- Produces: `buildWorkflowGraph(json, objectInfoData, manifest?)`, `type WorkflowGraph`, `type WorkflowGraphNode`, `type WorkflowGraphField`, `type WorkflowGraphEdge`, and `createParamFromGraphField(field)` for the API and frontend contract.

- [x] **Step 1: Write failing graph parser tests**

Create a minimal API-format fixture with:

```ts
const workflow = {
  '1': { class_type: 'LoadImage', inputs: { image: 'input.png' }, _meta: { title: '参考图' } },
  '2': { class_type: 'KSampler', inputs: { model: ['3', 0], steps: 20, cfg: 7, denoise: 1 }, _meta: { title: '采样' } },
  '3': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  '4': { class_type: 'SaveImage', inputs: { images: ['2', 0] }, _meta: { title: '输出' } },
};
const objectInfo = {
  KSampler: { input: { required: {
    model: ['MODEL'], steps: ['INT', { default: 20, min: 1, max: 150, step: 1 }],
    cfg: ['FLOAT', { default: 7, min: 0, max: 30, step: 0.1 }], denoise: ['FLOAT', { default: 1 }],
  } } },
};
```

Assert that `buildWorkflowGraph()` returns four nodes, an edge from `3` to `2` for `model`, an edge from `2` to `4` for `images`, and marks `steps`, `cfg`, and `denoise` selectable while marking `model` connected and not selectable.

Add a UI-format fixture with `pos` and `links`; assert the returned node coordinates use `pos` and the converted link maps to the correct source/target fields. Add an API fixture without positions; assert repeated calls return the same x/y layout and upstream nodes are placed at an earlier layer.

Add manifest selection assertions using a complete parameter object: `{ id: 'steps-2', label: '步数', nodeId: '2', field: 'steps', type: 'INT', default: 20 }` marks only the `2:steps` field selected and exposes `paramId: 'steps-2'`.

- [x] **Step 2: Run the focused tests to confirm failure**

Run: `pnpm --dir server exec vitest run src/workflow-graph.test.ts`

Expected: FAIL because `server/src/workflow-graph.ts` and `buildWorkflowGraph` do not exist.

- [x] **Step 3: Implement graph types and conversion**

Implement these shapes:

```ts
export interface WorkflowGraphField {
  field: string;
  type: string;
  value?: unknown;
  connected: boolean;
  selectable: boolean;
  selected: boolean;
  paramId?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  connection?: { sourceNode: string; sourceField: string };
}

export interface WorkflowGraphNode {
  nodeId: string;
  classType: string;
  title: string;
  x: number;
  y: number;
  fields: WorkflowGraphField[];
}

export interface WorkflowGraphEdge {
  sourceNode: string;
  sourceField: string;
  targetNode: string;
  targetField: string;
  type?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  manifestError?: string;
}
```

Normalize API input links of the form `[sourceNodeId, sourceSlot]`. Resolve source fields by reading the source node's output definitions/slot metadata when available; otherwise use `slot-${sourceSlot}` while preserving the source node and target field. For UI JSON, call `convertUiToApi()` for field values and parse the original `nodes[].pos` and `links` for coordinates and link endpoints. Do not mutate the input object.

For field discovery, merge node `inputs` values with `objectInfo[classType].input.required` and `.optional`. Mark array link values as connected. Mark widget definitions `INT`, `FLOAT`, `BOOLEAN`, `STRING`, `SEED`, `COMBO`, and legacy combo arrays selectable when they are not connected. Exclude file combo fields that existing introspection intentionally hides (`ckpt_name`, `vae_name`, `lora_name`, `unet_name`, `clip_name`, `vae_name`, `control_net_name`, `audio_name`) unless they already exist in the manifest. Preserve their display as non-selectable fields.

For API graphs without positions, compute deterministic topological layers from incoming links, place sources at x=40, increment x by 300 per layer, and sort nodes within each layer by numeric/string nodeId. For UI graphs, use `pos[0]` and `pos[1]`, falling back to the deterministic layout for missing positions.

Match selected fields by `nodeId + field`. For an existing shared `applyTo` param, mark its primary field and each `applyTo` node's same field selected. `createParamFromGraphField()` must derive `id`, `label`, `type`, `default`, `min`, `max`, `step`, and `options` from the field, with empty `description` and no history from a removed param.

- [x] **Step 4: Run focused tests to verify the parser**

Run: `pnpm --dir server exec vitest run src/workflow-graph.test.ts`

Expected: PASS for API/UI conversion, stable layout, connected-field filtering, and selection restoration.

- [x] **Step 5: Run backend typecheck**

Run: `pnpm --dir server exec tsc --noEmit`

Expected: PASS.

---

### Task 2: Add graph API and allow parameter selection changes safely

**Files:**
- Modify: `server/src/workflow-plugin-api.ts`
- Modify: `server/src/workflow-plugin-api.test.ts`
- Modify: `server/src/workflow-plugin-structure.test.ts`
- Do not modify: `server/src/workflow-catalog.ts`; keep redetection behavior unchanged and let graph validation handle the saved parameter set

**Interfaces:**
- Consumes: `buildWorkflowGraph()` and `createParamFromGraphField()` from Task 1; existing `WorkflowPluginApiOptions`, manifest store, and `validateWorkflowManifest()`.
- Produces: `GET /api/plugins/:id/graph`; updated `validateManifestStructure()` semantics where inputs/outputs stay fixed and params may change; parameter-specific validation for save requests.

- [x] **Step 1: Write failing API and validation tests**

Add tests that call the existing router harness with a valid plugin fixture and assert:

```ts
GET /api/plugins/demo/graph
// 200, body.graph.nodes contains widget fields with selected=false

PUT /api/plugins/demo
// body.params includes { id: 'cfg-2', label: 'CFG', nodeId: '2', field: 'cfg', type: 'FLOAT', default: 7 }
// response 200 and manifest.params contains exactly the submitted cfg-2 structural mapping
```

Add rejection tests for a param targeting `model` (connected), an unknown field, a mismatched type, duplicate `nodeId + field`, and a client-supplied `applyTo` that does not match the graph-generated value. Add a test that changing input/output count or structure still returns 400, while removing a param is accepted. Add a graph test with `objectInfo` throwing and assert the route still returns graph fields inferred from JSON values.

- [x] **Step 2: Run focused tests to confirm failure**

Run: `pnpm --dir server exec vitest run src/workflow-plugin-api.test.ts src/workflow-plugin-structure.test.ts`

Expected: FAIL because `/graph` is missing, params are still count-locked, and graph-based parameter validation is absent.

- [x] **Step 3: Implement graph route and validation**

Import the graph builder into `workflow-plugin-api.ts`. Add the route before the generic plugin route branch:

```ts
if (req.method === 'GET' && action === 'graph') {
  const manifestRead = readManifest(options.catalog.manifestDir, id);
  const manifest = manifestRead.status === 'valid'
    ? manifestRead.manifest
    : await introspectWorkflow(source.json, await objectInfoOf(options));
  const graph = buildWorkflowGraph(source.json, await objectInfoOf(options), manifest);
  if (manifestRead.status === 'invalid') graph.manifestError = manifestRead.error;
  res.json({ graph });
  return;
}
```

Extend the route matcher from `(nodes|redetect)` to `(nodes|graph|redetect)` while retaining `/nodes` compatibility.

Change `validateManifestStructure()` so it checks fixed count and structure only for `inputs` and `outputs`. For `params`, validate every submitted item against `buildWorkflowGraph()`:

- Find exactly one graph field with matching `nodeId + field`.
- Require `selectable === true` and reject connected fields.
- Require the submitted `type` to equal the graph-generated type.
- Require the submitted `id` to equal the generated id, except for existing dedupe ids already produced by the graph builder.
- Compute the expected `applyTo`; reject a client value that differs.
- Reject duplicate `nodeId + field` pairs.
- Preserve only editable metadata and value fields from the request; structural fields are normalized from the graph before `writeManifest()`.

Because an imported workflow with a corrupt manifest must remain viewable, graph route fallback should return a graph with no selected params and `manifestError`, while the normal catalog behavior continues to mark that plugin unavailable.

- [x] **Step 4: Run focused backend tests**

Run: `pnpm --dir server exec vitest run src/workflow-graph.test.ts src/workflow-plugin-api.test.ts src/workflow-plugin-structure.test.ts`

Expected: PASS.

- [x] **Step 5: Run backend typecheck and regression suite**

Run: `pnpm --dir server exec tsc --noEmit && pnpm --dir server exec vitest run`

Expected: PASS; existing plugin import, catalog, output extraction, and prompt injection tests remain green.

---

### Task 3: Add frontend graph API types and read-only node canvas

**Files:**
- Modify: `web/src/api.ts`
- Create: `web/src/components/WorkflowNodeGraph.tsx`
- Modify: `web/src/App.css`

**Interfaces:**
- Consumes: `WorkflowGraph` JSON from `GET /api/plugins/:id/graph`.
- Produces: `fetchWorkflowGraph(id)` and a `WorkflowNodeGraph` component with `selectedParams`, `onToggleParam`, and `onRetry` props.

- [x] **Step 1: Add frontend type and request contract**

Add matching interfaces to `web/src/api.ts`:

```ts
export interface WorkflowGraphField {
  field: string;
  type: string;
  value?: unknown;
  connected: boolean;
  selectable: boolean;
  selected: boolean;
  paramId?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  connection?: { sourceNode: string; sourceField: string };
}
export interface WorkflowGraphNode { nodeId: string; classType: string; title: string; x: number; y: number; fields: WorkflowGraphField[] }
export interface WorkflowGraphEdge { sourceNode: string; sourceField: string; targetNode: string; targetField: string; type?: string }
export interface WorkflowGraph { nodes: WorkflowGraphNode[]; edges: WorkflowGraphEdge[]; manifestError?: string }
export async function fetchWorkflowGraph(id: string): Promise<{ graph: WorkflowGraph }> {
  return http(`/api/plugins/${encodeURIComponent(id)}/graph`);
}
```

Use the existing `http()` helper and URL-encode the plugin id.

- [x] **Step 2: Implement the read-only canvas**

Create `WorkflowNodeGraph.tsx` with local `scale` (`0.5..1.5`) and `pan` state. Render a viewport with a transformed world, an SVG edge layer, and absolutely positioned node cards. Use the DTO x/y values as stable positions; do not write them back to the server.

Implement pointer drag on blank canvas for panning and wheel zoom around the cursor. Prevent node field checkbox clicks from starting pan. Draw each edge as a cubic SVG path between the source and target node-side anchors; if a source field cannot resolve an output port, draw from the source node center and retain the edge label. The canvas must remain usable on narrow modal widths with horizontal overflow.

Each node card displays nodeId, title, classType, and fields. For `connected` or `selectable === false`, render a read-only connection row with type and target. For selectable fields, render a checkbox controlled by `field.selected`; call `onToggleParam(field)` only after the parent accepts the event. Show the current value with a compact JSON/string formatter and show the existing `paramId` if selected.

- [x] **Step 3: Add focused styles**

Add scoped classes in `web/src/App.css` for the graph overlay, viewport, world, node cards, field rows, connected port markers, SVG edges, zoom controls, and empty/error states. Keep the modal’s existing visual language and use stable node dimensions so fields do not shift the graph while the user interacts.

- [x] **Step 4: Run frontend typecheck**

Run: `pnpm --dir web exec tsc --noEmit`

Expected: PASS.

---

### Task 4: Integrate dual-view draft behavior into WorkflowMappingModal

**Files:**
- Modify: `web/src/components/WorkflowMappingModal.tsx`
- Create: `web/src/components/workflowMappingDraft.ts`
- Modify: `web/src/components/SettingsModal.tsx`
- Modify: `web/src/App.css`

**Interfaces:**
- Consumes: `fetchWorkflowGraph()` and `WorkflowNodeGraph`; existing `WorkflowManifest` draft and save/redetect callbacks.
- Produces: modal tabs for `node`/`form`, confirmation-driven parameter toggling, and form rendering limited to `draft.params`.

- [x] **Step 1: Add pure draft transition helpers**

The web package has no component-test runner, so extract pure functions into `web/src/components/workflowMappingDraft.ts` and keep the functions free of DOM and React state. Verify their signatures and all call sites through the web TypeScript build. The required transitions are:

```ts
addParamFromField(draft, field) // appends a fresh generated param
removeParamAfterConfirmation(draft, nodeId, field) // removes matching param
isParamSelected(draft, nodeId, field) // true for primary/applyTo matches
```

The remove transition must discard `description`, `default`, `min`, `max`, `step`, and `options`; adding the same field later must create a new default object.

- [x] **Step 2: Add view state and graph loading**

Import the pure draft helpers from `workflowMappingDraft.ts`; do not duplicate parameter matching or removal logic inside JSX.

Add `view: 'node' | 'form'`, `graph`, `graphLoading`, and `graphError` state. On modal open or manifest id change, call `fetchWorkflowGraph(manifest.id)`. Keep the existing `nodes` prop only for compatibility until all node selector UI is removed; the graph route is the source for the node view.

Add tabs in the modal header. The graph view must render even when `draft.params` is empty so the user can discover and select fields. The form view keeps the existing input/output sections and renders only `draft.params`.

- [x] **Step 3: Implement checkbox selection and confirmation**

For a selectable graph field:

```ts
const existing = draft.params.find(p => p.nodeId === field.nodeId && p.field === field.field);
if (existing && (existing.description || existing.default !== undefined)) {
  const detail = existing.description ? `\n说明：${existing.description}` : '';
  const confirmed = window.confirm(`取消参数「${existing.label}」？${detail}\n取消后将丢失已填写配置。`);
  if (!confirmed) return;
}
setDraft(current => {
  const params = existing
    ? current.params.filter(p => !(p.nodeId === field.nodeId && p.field === field.field))
    : [...current.params, paramFromGraphField(field)];
  return { ...current, params };
});
```

For shared `applyTo` params, toggle all corresponding selected fields together and remove/add one params entry. Re-render graph selection from draft rather than mutating server-returned graph. When the user confirms removal, do not retain deleted values in a hidden cache.

- [x] **Step 4: Keep form view aligned**

Remove any parameter add/delete controls from the form. Keep structural values read-only. Render description and parameter configuration fields only for current `draft.params`; a field that is not selected must have no form row. Keep input/output fixed rows and existing metadata editing behavior.

When redetect returns a manifest, update the draft and reload graph selection without adding newly detected ordinary widgets. Preserve existing selected parameter editable metadata as specified; if a selected target no longer exists, show the graph error and let the backend reject an unsafe save with a specific message.

- [x] **Step 5: Run frontend typecheck and build**

Run: `pnpm --dir web exec tsc --noEmit && pnpm --dir web run build`

Expected: PASS.

---

### Task 5: Wire graph loading through SettingsModal and complete regression verification

**Files:**
- Modify: `web/src/components/SettingsModal.tsx`
- Modify: `server/src/workflow-plugin-contract.test.ts` to assert that selected visible params are exposed and hidden params are omitted
- Modify: `docs/superpowers/plans/2026-08-23-workflow-plugin-node-view.md` to track completed steps

**Interfaces:**
- Consumes: `WorkflowMappingModal` graph loading and existing plugin record lifecycle.
- Produces: opening “映射” loads the dual-view editor without requiring `/nodes`; plugin refresh remains compatible with imports, deletes, and redetection.

- [x] **Step 1: Replace node-candidate loading in the editor entry point**

Update `openMappingEditor()` so it opens with the plugin manifest immediately, lets the modal fetch `/graph`, and does not block opening when graph loading fails. Preserve the existing plugin list error display for import/delete failures. The `nodes` prop can be removed after the component no longer consumes it; if removed, update imports and call sites together.

- [x] **Step 2: Add integration assertions**

Verify that saving a manifest after selecting `cfg` causes `fetchWorkflows()` data to include `cfg` in `params`, and that `serializeWorkflowForLlm()` exposes it only when `hidden` is false. Verify cancelling a selected parameter in the UI draft does not change the persisted manifest until Save is clicked.

- [x] **Step 3: Run all backend checks**

Run:

```bash
pnpm --dir server exec tsc --noEmit
pnpm --dir server exec vitest run
```

Expected: backend typecheck passes and all tests pass, including the existing workflow, queue, MCP, catalog, import, output, and structure tests.

- [x] **Step 4: Run all frontend checks**

Run:

```bash
pnpm --dir web exec tsc --noEmit
pnpm --dir web run build
```

Expected: frontend typecheck and Vite build pass.

- [x] **Step 5: Run repository diff validation**

Run: `git diff --check`

Expected: no whitespace errors. Review `git status --short` to ensure only the graph feature files and the already-existing prior implementation changes are present; do not revert or stage unrelated prior changes.

- [x] **Step 6: Commit the feature as one logical unit**

After reviewing the diff, stage only the graph feature files and commit:

```bash
git add server/src/workflow-graph.ts server/src/workflow-graph.test.ts server/src/workflow-plugin-api.ts server/src/workflow-plugin-api.test.ts server/src/workflow-plugin-structure.test.ts web/src/api.ts web/src/components/WorkflowNodeGraph.tsx web/src/components/WorkflowMappingModal.tsx web/src/components/SettingsModal.tsx web/src/App.css docs/superpowers/plans/2026-08-23-workflow-plugin-node-view.md
git commit -m "feat: 为工作流插件增加节点视图与参数勾选"
```

Do not stage the earlier uncommitted workflow plugin implementation files unless they are part of the same reviewed feature change and explicitly intended for the same commit.
