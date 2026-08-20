import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { addProject, listProjects, readLastProject, rememberLastProject, renameProject } from './projects-store.js';

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

describe('项目重命名', () => {
  it('重命名项目会同步修改磁盘目录名与注册表', () => {
    const sub = join(projectDir, 'project-a');
    mkdirSync(sub);
    mkdirSync(join(sub, 'prompts'));

    addProject(projectDir, sub);
    rememberLastProject(sub);

    const res = renameProject(projectDir, sub, 'project-b');
    const newDir = join(projectDir, 'project-b');

    expect(existsSync(sub)).toBe(false);
    expect(existsSync(newDir)).toBe(true);
    expect(res.newPath).toBe(newDir);
    expect(readLastProject()).toBe(newDir);
    expect(listProjects(projectDir).some((p) => p.name === 'project-b' && p.path === newDir)).toBe(true);
  });
});
