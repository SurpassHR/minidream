// mock agent：输出环境变量传入的回复，分 3 段流式
// MOCK_ECHO_MODEL=1 时改为输出 argv 中 --model 后的值（模型透传测试用）
if (process.env.MOCK_ECHO_MODEL) {
  const i = process.argv.indexOf('--model');
  process.stdout.write((i >= 0 ? process.argv[i + 1] : 'none') + '\n');
} else {
  const reply = process.env.MOCK_REPLY ?? 'mock reply';
  const parts = [reply.slice(0, 5), reply.slice(5, 10), reply.slice(10)];
  for (const p of parts) {
    if (p) { process.stdout.write(p + '\n'); await new Promise((r) => setTimeout(r, 10)); }
  }
}
