# Plugin Response Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个工作流插件增加独立可编辑的回复协议，让用户用白名单占位符和块级显示配置组织最终助手回复。

**Architecture:** 新增 `response.json` 作为插件级机器协议，`workflow-response.ts` 负责协议类型、兼容转换、校验和模板渲染。生成请求确认实际插件后，后端构造安全 response context，按 submit/complete 时机发送 `agent:response_block`；前端只渲染这些结构化块。Skill/response API 与现有 Skill 编辑器保持独立保存和预览。

**Tech Stack:** TypeScript, Express, React, Vitest, SSE, existing Markdown renderer and CSS.

**Spec:** `docs/superpowers/specs/2026-08-24-plugin-response-template-design.md`

## Global Constraints

- `SKILL.md` remains the Agent-readable plugin behavior contract; `response.json` is the frontend/backend machine contract.
- Only visible inputs and `llm !== false` params can be exposed as widget placeholders.
- Response blocks use independent `container` (`text|collapsible`) and `format` (`plain|markdown|code`) dimensions.
- `result.display` is fixed to `outside-bubble`.
- Invalid protocol content falls back to legacy frontmatter response policy and then current defaults.
- The frontend must not infer display data from raw `toolCalls`, MCP results, task IDs, paths, or URLs.
- Generation media remains outside the chat bubble.

---

### Task 1: Protocol model and renderer

**Files:**
- Create: `server/src/workflow-response.ts`
- Test: `server/src/workflow-response.test.ts`
- Modify: `server/src/workflow-skill.ts`

**Interfaces:**
- `PluginResponseProtocol`, `PluginResponseBlock`, `ResponseSource`, `ResponseContext`.
- `defaultPluginResponseProtocol()`.
- `legacyPolicyToResponseProtocol(policy)`.
- `validatePluginResponseProtocol(protocol, spec)`.
- `renderResponseTemplate(template, context)`.
- `renderResponseBlocks(protocol, context, timing)`.

- [x] **Step 1: Write failing tests** for independent container/format combinations, visible input/param validation, rejected internal sources, placeholder substitution/default values, timing filtering, and legacy conversion.
- [x] **Step 2: Run `pnpm --filter server exec vitest run src/workflow-response.test.ts`** and verify the new module/tests fail before implementation.
- [x] **Step 3: Implement strict source parsing and protocol validation** with length/block limits and `!hidden && llm !== false` manifest filtering.
- [x] **Step 4: Implement template rendering** for `{{source}}` and `{{source | default:"..."}}`; unresolved values render empty and never expose arbitrary paths.
- [x] **Step 5: Implement legacy conversion** so existing frontmatter policy yields equivalent thinking/prompt/route behavior.
- [x] **Step 6: Run the focused tests and existing workflow-skill tests.**

### Task 2: Persist response protocol and expose plugin API

**Files:**
- Modify: `server/src/workflow-plugin-api.ts`
- Modify: `server/src/workflow-skill.ts`
- Modify: `server/src/workflow-plugin-api.test.ts`
- Create or modify: response protocol API tests in `server/src/workflow-response.test.ts`

**Interfaces:**
- `GET /api/plugins/:id/response` returns `{ protocol }`.
- `PUT /api/plugins/:id/response` accepts `{ protocol }`, validates against the current manifest, and atomically writes `.pi/skills/<id>/response.json`.
- `POST /api/plugins/:id/response/regenerate` writes a generated compatibility protocol from current manifest.
- `readPluginResponseProtocol` and `writePluginResponseProtocol` use the configured skills directory.

- [x] **Step 1: Add failing route tests** for read fallback, valid save, invalid source rejection, and manifest updates preserving valid custom response protocol where sources remain valid.
- [x] **Step 2: Implement atomic JSON read/write and route matching** beside existing Skill routes.
- [x] **Step 3: Make `syncPluginSkill`/manifest save create or refresh only missing/legacy response protocol without overwriting custom response JSON.
- [x] **Step 4: Run plugin API and workflow response tests.**

### Task 3: Collect generation context and emit response blocks

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/mcp/server.ts` only if final route metadata needs a typed helper
- Modify: `server/src/activity.ts` if replay requires response block events
- Modify: `web/src/api.ts` for SSE types
- Tests: `server/src/index.test.ts` or a focused response event test harness

**Interfaces:**
- `agent:response_block` event includes `{ blockId, container, format, defaultOpen, language, label, content, timing }`.
- `ResponseContext` is built from actual final task params and route, with prompt/negative prompt values filtered through manifest visibility.
- Submit blocks are emitted after `generation.submit` result and route resolution; complete blocks are emitted from task completion/failure/cancel events; always blocks use final Agent reply.

- [x] **Step 1: Add failing tests** proving final widget values are used, hidden/non-LLM params are absent, submit blocks arrive after route, and complete blocks arrive only on terminal task events.
- [x] **Step 2: Capture final task generation params and visible input/param values in a context builder.**
- [x] **Step 3: Load the selected plugin response protocol after final route resolution and render blocks through the new module.
- [x] **Step 4: Replace fixed prompt/route/thinking event production with response block events while retaining legacy events only for sessions without a custom response JSON.
- [x] **Step 5: Persist response blocks in session messages and replay them through session SSE.
- [x] **Step 6: Run backend typecheck and focused event tests.

### Task 4: Render structured blocks in the frontend

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/ChatView.tsx`
- Modify: `web/src/components/ChatView.css` if needed
- Tests: existing frontend checks plus focused component tests if available

**Interfaces:**
- Extend `StreamChatEvent` with `agent:response_block`.
- `ChatMessage.responseBlocks` stores validated blocks.
- Render `container: collapsible` with the existing thinking-chain disclosure UI and `format: code` with `<pre><code>`; Markdown only goes through the existing Markdown renderer.
- Do not recover prompt/route from `toolCalls` when a custom response protocol is active.

- [x] **Step 1: Add the API event and message model types.
- [x] **Step 2: Add a pure block renderer or focused rendering branches for text, collapsible, Markdown, and code combinations.
- [x] **Step 3: Update stream merge and session restore to preserve response blocks.
- [x] **Step 4: Remove custom-protocol display duplication from fixed prompt/route branches while keeping legacy fallback rendering.
- [x] **Step 5: Run frontend typecheck/build and inspect mobile layout constraints.

### Task 5: Add the response protocol editor beside Skill

**Files:**
- Modify: `web/src/components/WorkflowMappingModal.tsx`
- Modify: `web/src/components/WorkflowMappingModal.css`
- Modify: `web/src/api.ts`
- Tests: frontend build and API route tests

**Interfaces:**
- Add a `回复协议` tab beside `Skill`.
- Load/save/regenerate protocol independently from Skill content.
- Editor manages ordered blocks with add/delete/reorder, source picker grouped by plugin fields and system sources, template text, container, format, timing, default-open, language, and visible-when controls.
- Preview-only save behavior matches Skill: edits remain local until explicit save.

- [x] **Step 1: Add client API functions and local protocol state.
- [x] **Step 2: Render protocol block list and editor controls, including combined collapsible/code mode.
- [x] **Step 3: Add source insertion helpers that generate valid `{{...}}` placeholders and display labels.
- [x] **Step 4: Add validation/error states and explicit save/regenerate actions.
- [x] **Step 5: Run frontend build and verify the panel remains usable at narrow widths.

### Task 6: Documentation and verification

**Files:**
- Modify: `.pi/skills/plugin-skill-creator/SKILL.md`
- Modify: `.pi/skills/director-copilot/SKILL.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-08-24-plugin-response-template-design.md` if implementation decisions change

- [x] **Step 1: Update creator input/output rules** to describe response protocol as a separate machine file and keep Skill prose focused on MCP execution and user-facing guidance.
- [x] **Step 2: Update director-copilot** to state that MCP selection/call rules come from Skill while display layout comes from response protocol.
- [x] **Step 3: Update AGENTS.md** with response JSON persistence, validation, and synchronization rules.
- [x] **Step 4: Run `pnpm --filter server exec vitest run`, `pnpm --filter server exec tsc --noEmit`, `pnpm --filter web run build`, and `git diff --check`.
- [x] **Step 5: Review generated default protocol and confirm old custom Skills remain readable.
