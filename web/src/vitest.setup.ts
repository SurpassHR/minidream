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
