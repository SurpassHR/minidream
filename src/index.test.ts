import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './index.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Director 启动顺序', () => {
  it('HTTP 监听前不启动 MCP，HTTP 监听后才启动 MCP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'director-startup-'));
    dirs.push(dir);
    const app = buildApp({ projectDir: dir, mcpPort: 0 });
    apps.push(app);
    const internal = app as unknown as {
      mcpStarted: boolean;
      startMcp: () => Promise<unknown>;
    };

    expect(internal.mcpStarted).toBe(false);
    await app.listen({ port: 0, host: '127.0.0.1' });
    expect(internal.mcpStarted).toBe(false);

    await internal.startMcp();
    expect(internal.mcpStarted).toBe(true);
  });
});
