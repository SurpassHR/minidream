import { create } from 'zustand';
import type { GenTask, Graph, TaskRecord } from '../types';

interface GraphState {
  graph: Graph | null;
  connected: boolean;
  tasks: Map<string, GenTask>;
  taskRecords: Map<string, TaskRecord>;
  // 画布节点引用对话（chips）：显示名列表（@xxx），去重追加
  chips: string[];
  applyGraph: (g: Graph) => void;
  setConnected: (b: boolean) => void;
  upsertTask: (t: GenTask) => void;
  replaceTaskRecords: (tasks: TaskRecord[]) => void;
  upsertTaskRecord: (task: TaskRecord) => void;
  addChip: (name: string) => void;
  removeChip: (name: string) => void;
}

export const useGraphStore = create<GraphState>((set) => ({
  graph: null,
  connected: false,
  tasks: new Map(),
  taskRecords: new Map(),
  chips: [],
  applyGraph: (g) => set({ graph: g }),
  setConnected: (b) => set({ connected: b }),
  upsertTask: (t) => set((s) => {
    const next = new Map(s.tasks);
    next.set(t.id, t);
    return { tasks: next };
  }),
  replaceTaskRecords: (tasks) => set({ taskRecords: new Map(tasks.map((task) => [task.id, task])) }),
  upsertTaskRecord: (task) => set((s) => {
    const next = new Map(s.taskRecords);
    next.set(task.id, task);
    return { taskRecords: next };
  }),
  addChip: (name) => set((s) => s.chips.includes(name) ? s : { chips: [...s.chips, name] }),
  removeChip: (name) => set((s) => ({ chips: s.chips.filter((c) => c !== name) })),
}));
