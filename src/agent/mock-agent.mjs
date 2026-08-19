// mock agent：输出环境变量传入的回复，分 3 段流式
// MOCK_ECHO_MODEL=1 时改为输出 argv 中 --model / --thinking 后的值（参数透传测试用，格式 model|thinking）
// MOCK_ECHO_ARGS=1 时输出完整 argv（图片附件 @file 透传测试用）
// MOCK_HANG=1 时输出一行后不退出（模拟 pi --print 挂起，测空闲超时兜底）
// MOCK_ECHO_ENV=1 时输出 DIRECTOR_PROJECT_NAME 环境变量（项目上下文注入测试用）
// MOCK_JSON_EVENTS=1 时输出 pi --mode json 风格事件行（message_update/text_delta 流式解析测试用）
// MOCK_VISION_ERROR_ONCE=<file> 时首次调用模拟视觉不支持，后续调用继续正常输出（降级重试测试用）
import { existsSync, writeFileSync } from 'node:fs';
if (process.env.MOCK_JSON_EVENTS) {
  for (const delta of ['第一', '段流', '式输出']) {
    process.stdout.write(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
    }) + '\n');
  }
  process.stdout.write(JSON.stringify({ type: 'message_end' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\n');
  // 模拟 json 模式 + MCP 时输出完不自然退出：agent_end 应触发调用方提前终止
  await new Promise(() => {});
}
if (process.env.MOCK_VISION_ERROR_ONCE && !existsSync(process.env.MOCK_VISION_ERROR_ONCE)) {
  writeFileSync(process.env.MOCK_VISION_ERROR_ONCE, '1');
  process.stdout.write(JSON.stringify({ type: 'message_start', message: { errorMessage: 'model does not support image inputs' } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\n');
  process.exit(0);
}
if (process.env.MOCK_ECHO_ENV) {
  process.stdout.write((process.env.DIRECTOR_PROJECT_NAME ?? 'no-env') + '\n');
  process.exit(0);
}
if (process.env.MOCK_ECHO_STDIN) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(input + '\n');
  process.exit(0);
}
if (process.env.MOCK_ECHO_ARGS) {
  process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\n');
  process.exit(0);
}
if (process.env.MOCK_HANG) {
  process.stdout.write('partial reply\n');
  await new Promise(() => {}); // 永不退出
}
if (process.env.MOCK_ECHO_MODEL) {
  const mi = process.argv.indexOf('--model');
  const ti = process.argv.indexOf('--thinking');
  const model = mi >= 0 ? process.argv[mi + 1] : 'none';
  const thinking = ti >= 0 ? process.argv[ti + 1] : 'none';
  process.stdout.write(model + '|' + thinking + '\n');
} else {
  const reply = process.env.MOCK_REPLY ?? 'mock reply';
  const parts = [reply.slice(0, 5), reply.slice(5, 10), reply.slice(10)];
  for (const p of parts) {
    if (p) { process.stdout.write(p + '\n'); await new Promise((r) => setTimeout(r, 10)); }
  }
}
