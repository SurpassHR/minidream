import { create } from 'zustand';
import type { GenTask, Graph } from '../types';

interface GraphState {
  graph: Graph | null;
  connected: boolean;
  tasks: Map<string, GenTask>;
  // 画布节点引用对话（chips）：显示名列表（@xxx），去重追加
  chips: string[];
  applyGraph: (g: Graph) => void;
  setConnected: (b: boolean) => void;
  upsertTask: (t: GenTask) => void;
  addChip: (name: string) => void;
  removeChip: (name: string) => void;
}

export const useGraphStore = create<GraphState>((set) => ({
  graph: null,
  connected: false,
  tasks: new Map(),
  chips: [],
  applyGraph: (g) => set({ graph: g }),
  setConnected: (b) => set({ connected: b }),
  upsertTask: (t) => set((s) => {
    const next = new Map(s.tasks);
    next.set(t.id, t);
    return { tasks: next };
  }),
  addChip: (name) => set((s) => s.chips.includes(name) ? s : { chips: [...s.chips, name] }),
  removeChip: (name) => set((s) => ({ chips: s.chips.filter((c) => c !== name) })),
}));
