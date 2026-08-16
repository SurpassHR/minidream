// 测试用 mock：输出带 errorMessage 的 pi 事件（模拟 403 等模型错误）
console.log(JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [], errorMessage: '403 Your request was blocked.' } }));
console.log(JSON.stringify({ type: 'agent_end' }));
