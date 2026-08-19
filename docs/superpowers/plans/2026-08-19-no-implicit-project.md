# No Implicit Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start the workbench with no opened project instead of treating the server cwd (`director-workbench`) as a writable project, while preserving explicit project switching and global features.

**Architecture:** `buildApp({ projectDir })` remains backward-compatible for tests and explicit callers, but the CLI passes no project path when none was supplied. The mutable project context tracks `projectOpen`; a pre-handler rejects project-scoped API requests with `PROJECT_NOT_OPEN` before any storage function runs. The frontend receives `projectOpen`, shows `未打开项目`, renders a read-only empty workspace, and leaves project management, settings, and the global asset library available.

**Tech Stack:** TypeScript, Fastify, Vitest, React, Vite, Testing Library.

**Spec:** The user-confirmed behavior in conversation: no virtual project without an opened project; no project writes; show a read-only workspace until a project is opened.

## Global Constraints

- Do not use `process.cwd()` as the active project unless the caller explicitly passes that directory as `projectDir`.
- Project-scoped reads/writes must not touch `.director` in the workbench repository when no project is open.
- Project-scoped requests without an open project return code `PROJECT_NOT_OPEN`.
- Global project registration, global settings, Ollama, and global assets remain available without an opened project.
- Existing tests that explicitly call `buildApp({ projectDir })` continue to operate on that directory.

---

### Task 1: Establish the no-project backend contract

**Files:**
- Modify: `src/types.ts` (add `PROJECT_NOT_OPEN` error code)
- Modify: `src/index.ts` (make the CLI project argument optional and expose open state)
- Modify: `src/api/routes.ts` (track `projectOpen`, reject project-scoped routes, return project state)
- Modify: `src/api/project-switch.test.ts` (test startup without a project and switching into one)
- Modify: `src/api/api.test.ts` (test a representative write rejection and no cwd data mutation)

**Interfaces:**
- `ProjectContext` gains `projectOpen: boolean` while retaining a non-project placeholder `projectDir` for existing storage APIs and watcher construction.
- `GET /api/projects` returns `{ projects, projectOpen }`.
- No-project project-scoped requests return HTTP `409` with `{ code: 'PROJECT_NOT_OPEN', message: '请先打开一个项目' }`.

- [ ] **Step 1: Write failing tests**

Add a `buildApp({ comfyBaseUrl })` test that calls `GET /api/graph` and `POST /api/nodes` without `projectDir`, asserts `409/PROJECT_NOT_OPEN`, and asserts the repository cwd does not gain `.director/project.json`. Add a switch test asserting `POST /api/project/switch` changes `projectOpen` to true and subsequent graph access succeeds.

- [ ] **Step 2: Run the backend tests and verify the expected failure**

Run:

```bash
pnpm test -- src/api/project-switch.test.ts src/api/api.test.ts
```

Expected: the new no-project test fails because `buildApp` currently requires `projectDir` and routes use the cwd fallback.

- [ ] **Step 3: Implement the minimal backend state and guard**

Use an internal placeholder path derived from the launch directory only for watcher/context construction; never expose it as a current project. Set `projectOpen` from whether `opts.projectDir` was explicitly provided. Change the CLI from `process.argv[2] ?? process.cwd()` to `process.argv[2]`.

Add a Fastify `preHandler` that checks `projectOpen` for project-scoped paths (`/api/graph`, `/api/nodes`, `/api/edges`, `/api/import`, `/api/snapshots`, `/api/workspace`, `/api/generation`, `/api/comfy/config`, `/api/agent`, `/api/story`, `/api/designs`, and `/api/yaml/export`) and returns `PROJECT_NOT_OPEN`. Exempt `/api/projects`, `/api/project/switch`, `/api/assets`, `/api/settings`, `/api/ollama`, `/api/agent/models`, `/api/workflows`, and `/health`.

Return `projectOpen` from `GET /api/projects`; set it true in `/api/project/switch`. In settings persistence, only write the project ComfyUI node when `projectOpen` is true.

- [ ] **Step 4: Run the focused backend tests**

Run:

```bash
pnpm test -- src/api/project-switch.test.ts src/api/api.test.ts
```

Expected: all existing tests and the new no-project tests pass.

---

### Task 2: Expose project state to the frontend and remove the virtual name

**Files:**
- Modify: `web/src/api/client.ts` (`listProjects` response type)
- Modify: `web/src/App.tsx` (track `projectOpen` and render empty read-only workspace)
- Modify: `web/src/panels/ProjectSwitcher.tsx` (show `未打开项目`)
- Modify: `web/src/App.test.tsx` (test no-project display and open transition)
- Modify: `web/src/panels/panels.test.tsx` or a focused project-switcher test if needed

**Interfaces:**
- `client.listProjects()` returns `{ projects: ProjectInfo[]; projectOpen: boolean }`.
- `ProjectSwitcher` accepts `projectOpen: boolean` and displays `未打开项目` when false, ignoring graph fallback text.

- [ ] **Step 1: Write failing frontend tests**

Add an App test whose `/api/projects` mock returns `{ projects: [], projectOpen: false }`; assert the top-bar project button says `未打开项目`, the normal canvas is absent, and a `project-empty-state` asks the user to open/add a project. Assert the global asset drawer toggle remains available. Add a ProjectSwitcher test that passes `projectOpen={false}` with a non-empty fallback name and asserts the fallback is not rendered.

- [ ] **Step 2: Run the focused frontend tests and verify failure**

Run:

```bash
pnpm --dir web test -- App.test.tsx panels.test.tsx
```

Expected: the new assertions fail because the client has no `projectOpen` field and the UI currently falls back to the graph project name.

- [ ] **Step 3: Implement the frontend state and read-only empty view**

Update `listProjects` and `refreshProjects` to preserve both fields. On project switch set `projectOpen: true` and apply the returned graph. When `projectOpen` is false, render a read-only empty-state in place of CanvasView/StoryTellerView/ObjectDesignerView and the project-specific footer; continue rendering the top bar and `AssetDrawer` so users can add/open a project and use global assets.

Pass `projectOpen` into `ProjectSwitcher`; display `未打开项目` when false. Keep the existing graph fallback only for the open state so an API response cannot resurrect `director-workbench` as a visible project.

- [ ] **Step 4: Run the focused frontend tests**

Run:

```bash
pnpm --dir web test -- App.test.tsx panels.test.tsx
```

Expected: all focused frontend tests pass.

---

### Task 3: Verify all project guards and build artifacts

**Files:**
- Modify: `src/api/project-switch.test.ts` (cover read/write route matrix as needed)
- Modify: `web/src/App.test.tsx` (cover explicit project switch restoring workspace)

- [ ] **Step 1: Add route-matrix regression coverage**

Verify no-project access rejects a graph mutation and a story/design/session mutation, while `/api/projects`, `/api/assets`, `/api/settings`, and `/api/project/switch` remain available. Verify switching to a real project changes the response to `projectOpen: true` and restores normal project APIs.

- [ ] **Step 2: Run backend and frontend test suites**

Run:

```bash
pnpm test
pnpm --dir web test
```

Expected: all backend and frontend tests pass.

- [ ] **Step 3: Run typecheck, build, and diff checks**

Run:

```bash
pnpm exec tsc --noEmit
pnpm --dir web build
git diff --check
```

Expected: web build and diff checks pass. Any pre-existing root TypeScript snapshot errors must be reported separately if they remain.
