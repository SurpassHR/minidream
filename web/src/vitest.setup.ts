import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// vitest 未启用 globals 时 testing-library 的自动 cleanup 不生效，
// 需显式注册，避免多次 render 累积导致 getByRole 命中多个元素
afterEach(() => cleanup());

// jsdom 无 ResizeObserver，React Flow（@xyflow/react）测量依赖它，测试需 mock
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

// jsdom 无 DataTransfer（拖放 API），画布素材 drop 测试需要最小实现
if (typeof globalThis.DataTransfer === 'undefined') {
  class DataTransferMock {
    private store = new Map<string, string>();
    setData(kind: string, value: string): void { this.store.set(kind, value); }
    getData(kind: string): string { return this.store.get(kind) ?? ''; }
    clearData(kind?: string): void {
      if (kind) this.store.delete(kind);
      else this.store.clear();
    }
  }
  globalThis.DataTransfer = DataTransferMock as unknown as typeof DataTransfer;
}
