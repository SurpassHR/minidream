import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readLastProject, rememberLastProject } from './projects-store.js';

let home: string;
let projectDir: string;

beforeEach(() => {
  home = mkdtempSync(join('/tmp', 'director-last-project-home-'));
  projectDir = mkdtempSync(join('/tmp', 'director-last-project-'));
  vi.stubEnv('HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('最近打开项目', () => {
  it('记住并读取最近项目路径', () => {
    expect(readLastProject()).toBeNull();

    rememberLastProject(projectDir);

    expect(readLastProject()).toBe(projectDir);
  });

  it('最近项目目录不存在时返回 null', () => {
    rememberLastProject(projectDir);
    rmSync(projectDir, { recursive: true, force: true });

    expect(readLastProject()).toBeNull();
  });

  it('记录路径会规范化为绝对路径', () => {
    rememberLastProject(join(projectDir, '.'));

    expect(readLastProject()).toBe(projectDir);
  });
});
