import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

describe('ComfyUI 客户端', () => {
  let comfyui: typeof import('./comfyui.js');

  beforeAll(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/prompt')) {
          return new Response(
            JSON.stringify({
              prompt_id: 'abc',
              number: 1,
              node_errors: {
                '5': {
                  errors: [
                    {
                      type: 'value_not_in_list',
                      message: 'Value not in list',
                      details: "The value for the input 'unet_name' is not in the list of allowed values: ['a.safetensors']",
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    vi.resetModules();
    comfyui = await import('./comfyui.js');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('submitPrompt 校验失败时抛出包含节点与详情的中文错误', async () => {
    await expect(comfyui.submitPrompt({ '1': { class_type: 'UNETLoader', inputs: { unet_name: 'x.safetensors' } } }, 'client-1')).rejects.toThrow(
      /工作流校验失败：Value not in list.*unet_name.*节点 5/,
    );
  });

  it('submitPrompt 对 missing_node_type 400 给出安装自定义节点的可读错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/prompt')) {
          return new Response(
            JSON.stringify({
              error: {
                type: 'missing_node_type',
                message: "Node 'Set_PRMT-' not found. The custom node may not be installed.",
                details: "Node ID '#465'",
                extra_info: { node_id: '465', class_type: 'SetNode', node_title: 'Set_PRMT-' },
              },
              node_errors: {},
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    await expect(comfyui.submitPrompt({ '465': { class_type: 'SetNode', inputs: {} } }, 'client-1')).rejects.toThrow(
      /未安装的节点「SetNode」（Set_PRMT-）.*自定义节点/,
    );
  });
});
