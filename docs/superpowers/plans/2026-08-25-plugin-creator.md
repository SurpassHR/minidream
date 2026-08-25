# Plugin Creator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将插件 Skill 生成器升级为 `plugin-creator`，先生成可审阅的完整插件配置建议，用户确认后安全保存 manifest、SKILL.md 和 response.json。

**Architecture:** 复用现有 workflow normalizer、graph builder、manifest validator 和 response validator。LLM 只负责语义建议，后端将建议转换为结构化配置并在一次保存事务中完成全部校验和原子写入。

**Tech Stack:** Node.js、TypeScript、Express、Vitest、React、i18next、Pi CLI。

**Spec:** `docs/superpowers/specs/2026-08-25-plugin-creator-design.md`

## Global Constraints

- 配置建议生成后必须经过用户确认才可落盘。
- 不允许 LLM 伪造 nodeId、field、type 或 applyTo。
- 复用现有 API/UI workflow 转换逻辑。
- hidden 或 `llm:false` 参数不得进入 LLM Skill 或 response 占位符。
- 自定义 SKILL.md 和 response.json 默认不得被覆盖。
- 新增 UI 文案必须同步 `web/src/i18n/zh.ts` 和 `web/src/i18n/en.ts`。
- 使用原子写入，失败时保持旧配置不变。

---

### Task 1: 重命名 plugin-skill-creator 并保持旧行为

**Files:**
- Rename: `.pi/skills/plugin-skill-creator/SKILL.md` → `.pi/skills/plugin-creator/SKILL.md`
- Modify: `server/src/agent/bridge.ts`
- Modify: `server/src/workflow-plugin-api.ts`
- Modify: `web/src/api.ts`
- Modify: `server/src/agent/bridge.test.ts`
- Modify: `server/src/workflow-plugin-api.test.ts`
- Modify: `server/src/workflow-skill.test.ts`

**Interfaces:**
- Preserve `runPluginSkillCreator()` temporarily as a compatibility export if needed.
- Internal path and user-facing name become `plugin-creator`.

- [ ] Update skill path, prompt text, error messages and comments.
- [ ] Update tests to assert `.pi/skills/plugin-creator/SKILL.md`.
- [ ] Keep generated SKILL.md structure unchanged.
- [ ] Run `pnpm test -- server/src/agent/bridge.test.ts server/src/workflow-plugin-api.test.ts server/src/workflow-skill.test.ts`.

### Task 2: 增加 PluginAnalysis 类型和纯函数构建器

**Files:**
- Create: `server/src/plugin-creator.ts`
- Create: `server/src/plugin-creator.test.ts`
- Modify: `server/src/workflow.ts` only if exporting a narrowly needed normalized graph helper

**Interfaces:**

```ts
export interface PluginAnalysis { ... }
export interface PluginCreatorInput { ... }
export function buildPluginAnalysis(input: PluginCreatorInput): PluginAnalysis
```

- [ ] Define analysis DTO containing workflow metadata, purpose placeholder, input/output candidates, widget exposure candidates and response recommendations.
- [ ] Build candidates from existing `WorkflowSpec` and `WorkflowGraph` without mutating either.
- [ ] Mark connected fields as non-exposable.
- [ ] Mark existing `llm:false` params as fixed and existing hidden params as hidden.
- [ ] Preserve exact nodeId/field/type/default/range/options/applyTo from graph/spec.
- [ ] Add tests for connected fields, fixed combo values, bypass params and output candidates.
- [ ] Run `pnpm test -- server/src/plugin-creator.test.ts`.

### Task 3: 提供 workflow 分析建议接口

**Files:**
- Modify: `server/src/workflow-plugin-api.ts`
- Modify: `web/src/api.ts`
- Modify: `server/src/workflow-plugin-api.test.ts`

**Interfaces:**

```http
POST /api/plugins/:id/analyze
```

- [ ] Resolve source workflow, object_info, current manifest and graph.
- [ ] Return analysis preview only; do not call writeManifest, writePluginSkill or writePluginResponseProtocol.
- [ ] Return 404 for unknown plugin and 400 for invalid source/analysis data.
- [ ] Test filesystem snapshots before and after the request to prove no files change.
- [ ] Run targeted API tests.

### Task 4: 让 plugin-creator 生成结构化建议

**Files:**
- Modify: `.pi/skills/plugin-creator/SKILL.md`
- Modify: `server/src/agent/bridge.ts`
- Create/modify: `server/src/plugin-creator.test.ts`

**Interfaces:**

```ts
export interface PluginCreatorLlmOptions { timeoutMs?: number }
export async function runPluginCreator(input: PluginCreatorInput, opts?: PluginCreatorLlmOptions): Promise<PluginAnalysis>
```

- [ ] Define strict JSON output schema for purpose, input/output recommendations, widget exposure and response blocks.
- [ ] Serialize normalized graph facts and current spec, excluding unnecessary raw data.
- [ ] Parse fenced and unfenced JSON safely.
- [ ] Reject unknown node targets, connected widgets and invalid response sources before returning.
- [ ] Keep legacy Skill markdown generation available until the new flow is verified.
- [ ] Test valid output, malformed output, unknown field and timeout behavior.

### Task 5: 增加用户确认保存接口和事务校验

**Files:**
- Modify: `server/src/workflow-plugin-api.ts`
- Modify: `server/src/workflow-plugin-store.ts` if a transaction helper is needed
- Create/modify: `server/src/workflow-plugin-api.test.ts`

**Interfaces:**

```http
POST /api/plugins/:id/configure
```

Request includes confirmed manifest draft and explicit overwrite flags:

```ts
{
  manifest: WorkflowManifestRecord;
  overwriteSkill?: boolean;
  overwriteResponse?: boolean;
}
```

- [ ] Re-resolve the current workflow and graph at save time.
- [ ] Validate manifest structure, parameter mappings, node targets, types, applyTo and outputs.
- [ ] Validate generated/default response protocol against the confirmed manifest.
- [ ] Write manifest only after all validation passes.
- [ ] Generate Skill and response only according to overwrite flags and existing custom markers.
- [ ] Ensure failed validation leaves manifest, Skill and response byte-for-byte unchanged.
- [ ] Test successful confirmation, invalid field, invalid response reference and rollback behavior.

### Task 6: 前端显示分析建议并要求确认

**Files:**
- Modify: `web/src/components/WorkflowMappingModal.tsx`
- Modify: `web/src/components/WorkflowMappingModal.css`
- Modify: `web/src/api.ts`
- Modify: `web/src/i18n/zh.ts`
- Modify: `web/src/i18n/en.ts`
- Add/modify relevant web tests if configured

- [ ] Add an explicit “生成配置建议” action.
- [ ] Show recommended input/output mappings and widget exposure changes separately from current draft.
- [ ] Show confidence/reason for non-obvious recommendations.
- [ ] Require explicit confirmation before applying suggestions to the draft.
- [ ] Keep cancel behavior side-effect free.
- [ ] Save only through the confirmed backend endpoint.
- [ ] Run web typecheck/build and relevant tests.

### Task 7: 完成 Skill 和 response 生成联动

**Files:**
- Modify: `server/src/workflow-skill.ts`
- Modify: `server/src/workflow-response.ts`
- Modify: `server/src/workflow-plugin-api.ts`
- Modify: `server/src/workflow-response.test.ts`
- Modify: `server/src/workflow-skill.test.ts`

- [ ] Generate Skill from the confirmed manifest only.
- [ ] Generate response protocol from confirmed visible inputs/params/outputs only.
- [ ] Preserve custom files unless explicit overwrite is true.
- [ ] Reject response blocks referencing removed or `llm:false` params.
- [ ] Keep artifact display outside the bubble.
- [ ] Test custom preservation and explicit overwrite.

### Task 8: 全量验证和文档同步

**Files:**
- Modify: `.pi/skills/director-copilot/SKILL.md` if MCP/API contract changes
- Modify: relevant README/docs only if user-facing behavior changes

- [ ] Search repository for stale `plugin-skill-creator` references.
- [ ] Update director skill when new MCP/API behavior is exposed.
- [ ] Run server typecheck.
- [ ] Run server targeted tests and full test suite.
- [ ] Run web typecheck/build.
- [ ] Verify existing README changes remain untouched and `.freebuff/` is not included.
