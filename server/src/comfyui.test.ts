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
});
