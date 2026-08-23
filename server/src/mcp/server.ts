import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TaskQueue } from '../tasks/queue.js';
import { buildSpecsCached } from '../workflow.js';
import { summarizeWorkflowsForLlm } from '../workflow-plugin-api.js';
import type { JsonRpcRequest, JsonRpcResponse, McpCallToolResult, McpToolDescriptor } from './types.js';

export type WorkflowRouteIntent = 'text_to_image' | 'image_to_image' | 'image_upscale' | 'text_to_video' | 'image_to_video' | 'unknown';

export interface WorkflowRoute {
  requestedWorkflowId: string;
  finalWorkflowId: string;
  intent: WorkflowRouteIntent;
  referenceImageCount: number;
  referenceVideoCount: number;
  forced: boolean;
  reason: string;
  taskId?: string;
}

export interface McpServerOptions {
  port?: number;
  taskQueue: TaskQueue;
  onActivity?: (text: string) => void;
  /** 插件（工作流）启用判定：返回 false 的插件不会出现在 workflow.list，也无法提交 */
  isWorkflowEnabled?: (id: string) => boolean;
  /** Agent 是否可轮询生成状态：返回 false 时从工具列表移除 generation.status（进度改由 SSE 推送） */
  isStatusPollingEnabled?: () => boolean;
}

export interface McpServerInstance {
  start(): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
  getUrl(): string | undefined;
  handleRpcMessage(reqBody: any): Promise<JsonRpcResponse>;
}

/** 图像放大/超分意图关键词（配合参考图自动路由到 SeedVR2 放大工作流） */
const UPSCALE_INTENT = /放大|超分|upscale|enlarge|提升分辨率|分辨率提升|高清化|变清晰|提高清晰|画质增强|画质提升|增强画质|锐化/i;

const MCP_TOOLS: McpToolDescriptor[] = [
  {
    name: 'workflow.list',
    description: '获取系统支持的工作流列表（紧凑摘要：id、名称、用途描述、输入输出类型与可调参数名及各自用途说明 description）。选择工作流前先调用本工具了解各工作流用途；向用户介绍工作流时用简洁的自然语言总结，不要把工具返回的原始 JSON 贴给用户。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'generation.submit',
    description: '创建并提交生成任务入队（支持图像生成、图像放大与视频生成）',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string',
          description: '工作流模板 ID（如 image_krea2_turbo_t2i、image_seedvr2_upscale 或 video-minimax-h3-t2v，详见 workflow.list）',
        },
        prompt: {
          type: 'string',
          description: '生图或视频的主提示词（已由导演扩写增强）',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '参考图片文件名/本地路径/URL 列表。用户提供的参考图已由系统上传到 ComfyUI input 目录（见对话【参考图片】段中的文件名），图生图/图生视频时必须按序传入',
        },
        videos: {
          type: 'array',
          items: { type: 'string' },
          description: '可选的输入视频本地路径或 URL 列表',
        },
        params: {
          type: 'object',
          description: '可选的参数覆盖项，键为 workflow.list 返回的参数 id。除数值参数（steps/cfg/seed 等）外，文本类参数（如负面提示词、风格 tag）也通过这里传入，键如 text-551，值为字符串。',
        },
        sessionId: {
          type: 'string',
          description: '关联的对话会话 ID，用于向当前对话展示实际工作流路由',
        },
      },
      required: ['workflowId', 'prompt'],
    },
  },
  {
    name: 'generation.status',
    description: '查询生成任务的实时进度、阶段状态与产物输出',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: '任务 ID',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'generation.cancel',
    description: '取消排队中或正在生成的任务，释放显存与系统资源',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: '要取消的任务 ID',
        },
      },
      required: ['taskId'],
    },
  },
];

export function createDirectorMCPServer(
  taskQueue: TaskQueue,
  isWorkflowEnabled?: (id: string) => boolean,
  isStatusPollingEnabled?: () => boolean,
): McpServerInstance {
  return createMcpServer({ taskQueue, isWorkflowEnabled, isStatusPollingEnabled });
}

export function createMcpServer(options: McpServerOptions): McpServerInstance {
  const { taskQueue, onActivity, isWorkflowEnabled, isStatusPollingEnabled } = options;
  const workflowEnabled = isWorkflowEnabled ?? (() => true);
  const statusPollingEnabled = isStatusPollingEnabled ?? (() => true);
  let server: http.Server | null = null;
  let serverUrl: string | undefined;

  async function handleToolCall(name: string, args: Record<string, any> = {}): Promise<McpCallToolResult> {
    try {
      onActivity?.(`agent → ${name}${args.workflowId ? ` [${args.workflowId}]` : ''}${args.taskId ? ` [${args.taskId}]` : ''}`);
    } catch {
      // 忽略回调异常
    }

    switch (name) {
      case 'workflow.list': {
        const specs = (await buildSpecsCached()).filter(s => workflowEnabled(s.id));
        const summary = summarizeWorkflowsForLlm(specs);
        return {
          content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        };
      }

      case 'generation.submit': {
        if (!args.workflowId || !args.prompt) {
          return {
            content: [{ type: 'text', text: '错误: workflowId 与 prompt 为必填参数' }],
            isError: true,
          };
        }
        const requestedWorkflowId = String(args.workflowId);
        let workflowId = requestedWorkflowId;
        const promptText = String(args.prompt || '');
        const hasImages = Array.isArray(args.images) && args.images.length > 0;
        const hasVideos = Array.isArray(args.videos) && args.videos.length > 0;
        const intent: WorkflowRouteIntent = hasVideos
          ? (hasImages ? 'image_to_video' : 'text_to_video')
          : hasImages
            ? (UPSCALE_INTENT.test(promptText) ? 'image_upscale' : 'image_to_image')
            : 'text_to_image';
        // 用户提供参考图且意图为图像放大/超分时，确定性路由到 SeedVR2 放大工作流，
        // 避免 Agent 误用文生图工作流（其无图像输入，参考图会被丢弃）。
        const routed =
          hasImages &&
          !hasVideos &&
          UPSCALE_INTENT.test(promptText) &&
          workflowId !== 'image_seedvr2_upscale';
        if (routed) workflowId = 'image_seedvr2_upscale';
        const route: WorkflowRoute = {
          requestedWorkflowId,
          finalWorkflowId: workflowId,
          intent,
          referenceImageCount: hasImages ? args.images.length : 0,
          referenceVideoCount: hasVideos ? args.videos.length : 0,
          forced: routed,
          reason: routed
            ? '检测到参考图与图像放大意图，后端强制使用 SeedVR2 图像放大工作流'
            : workflowId === requestedWorkflowId
              ? '沿用 Agent 请求的工作流'
              : '后端路由到兼容输入的工作流',
        };
        if (!workflowEnabled(workflowId)) {
          return {
            content: [{ type: 'text', text: `错误: 插件「${workflowId}」未启用，无法提交生成任务` }],
            isError: true,
          };
        }
        const task = taskQueue.submit({
          workflowId,
          prompt: String(args.prompt),
          images: Array.isArray(args.images) ? args.images.map(String) : undefined,
          videos: Array.isArray(args.videos) ? args.videos.map(String) : undefined,
          params: args.params && typeof args.params === 'object' ? args.params : undefined,
          sessionId: args.sessionId ? String(args.sessionId) : undefined,
        });

        const routedResult = { ...route, taskId: task.id };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                taskId: task.id,
                status: task.status,
                workflowId: task.workflowId,
                route: routedResult,
                message: routed
                  ? '任务已提交（检测到图像放大意图，已自动路由到 SeedVR2 图像放大工作流）'
                  : '任务已成功提交至队列',
              }),
            },
          ],
        };
      }

      case 'generation.status': {
        if (!statusPollingEnabled()) {
          return {
            content: [{ type: 'text', text: '状态轮询已关闭：生成进度与产物会通过事件流自动推送，无需查询任务状态' }],
            isError: true,
          };
        }
        if (!args.taskId) {
          return {
            content: [{ type: 'text', text: '错误: taskId 为必填参数' }],
            isError: true,
          };
        }
        const task = taskQueue.get(String(args.taskId));
        if (!task) {
          return {
            content: [{ type: 'text', text: `未找到任务: ${args.taskId}` }],
            isError: true,
          };
        }
        // 脱敏返回：产物会自动展示在界面上，不向 Agent 暴露内部文件名/路径/URL
        const safeTask = {
          id: task.id,
          type: task.type,
          status: task.status,
          workflowId: task.workflowId,
          prompt: task.prompt,
          error: task.error,
          stages: task.stages,
          ratio: task.ratio,
          size: task.size,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          outputCount: task.outputs?.length ?? 0,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(safeTask, null, 2) }],
        };
      }

      case 'generation.cancel': {
        if (!args.taskId) {
          return {
            content: [{ type: 'text', text: '错误: taskId 为必填参数' }],
            isError: true,
          };
        }
        const canceled = taskQueue.cancel(String(args.taskId));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                taskId: args.taskId,
                canceled,
                message: canceled ? '任务已成功取消' : '任务不存在或已在终止状态',
              }),
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `未知工具: ${name}` }],
          isError: true,
        };
    }
  }

  async function handleRpcMessage(reqBody: any): Promise<JsonRpcResponse> {
    const id = reqBody?.id ?? null;
    const method = reqBody?.method;
    const params = reqBody?.params || {};

    if (!method || typeof method !== 'string') {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid Request: missing method' },
      };
    }

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: 'director-workbench-mcp',
            version: '1.0.0',
          },
        },
      };
    }

    if (method === 'tools/list') {
      const tools = statusPollingEnabled()
        ? MCP_TOOLS
        : MCP_TOOLS
            .filter(tool => tool.name !== 'generation.status')
            .map(tool =>
              tool.name === 'generation.submit'
                ? { ...tool, description: tool.description + '（提交后任务自动执行，进度与产物会通过事件流自动推送，无需轮询状态）' }
                : tool,
            );
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools,
        },
      };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      if (!toolName || typeof toolName !== 'string') {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Invalid params: missing tool name' },
        };
      }

      const callRes = await handleToolCall(toolName, toolArgs);
      return {
        jsonrpc: '2.0',
        id,
        result: callRes,
      };
    }

    if (method === 'ping') {
      return {
        jsonrpc: '2.0',
        id,
        result: {},
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  return {
    start(): Promise<{ port: number; url: string }> {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          // 允许跨域与基础 options 请求
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

          if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
          }

          if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', server: 'director-workbench-mcp' }));
            return;
          }

          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }

          let bodyText = '';
          req.on('data', chunk => (bodyText += chunk));
          req.on('end', async () => {
            try {
              const jsonBody = JSON.parse(bodyText);
              const rpcResponse = await handleRpcMessage(jsonBody);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(rpcResponse));
            } catch (err: any) {
              const errResponse: JsonRpcResponse = {
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: `Parse error: ${err?.message || String(err)}` },
              };
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(errResponse));
            }
          });
        });

        server.listen(options.port ?? 0, '127.0.0.1', () => {
          const addr = server?.address() as AddressInfo;
          serverUrl = `http://127.0.0.1:${addr.port}`;
          resolve({ port: addr.port, url: serverUrl });
        });

        server.on('error', reject);
      });
    },

    close(): Promise<void> {
      return new Promise(resolve => {
        if (server) {
          server.close(() => {
            server = null;
            serverUrl = undefined;
            resolve();
          });
        } else {
          resolve();
        }
      });
    },

    getUrl(): string | undefined {
      return serverUrl;
    },

    handleRpcMessage(reqBody: any): Promise<JsonRpcResponse> {
      return handleRpcMessage(reqBody);
    },
  };
}
