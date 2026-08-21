import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateData, mockReply } from './mock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4777);

const app = express();

app.use(express.json());

// Static assets (downloaded images)
app.use('/assets', express.static(path.resolve(__dirname, '../assets')));

// Generate page data
app.get('/api/generate', (_req, res) => {
  res.json(generateData);
});

// Mock chat: echoes a canned reply based on the user message
app.post('/api/chat', (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  if (!message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  res.json(mockReply(message));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'director-workbench', version: '2.0.0' });
});

app.listen(PORT, () => {
  console.log(`[server] Director Workbench v2 API listening on http://127.0.0.1:${PORT}`);
});
