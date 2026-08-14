// 协议一致性检查（parity）：读取 Python 侧 dump 的样本 JSON，用本工作台校验器复核。
// 用法：npx tsx src/prompt/parity-check.ts /tmp/protocol_samples.json
import { readFileSync } from 'node:fs';
import { validatePromptProtocol } from './protocol.js';

interface Sample {
  source: string;
  index: number;
  ok: boolean;
  syntax_ok: boolean;
  obj: unknown;
  error?: string;
}

const file = process.argv[2];
if (!file) {
  console.error('用法: npx tsx src/prompt/parity-check.ts <samples.json>');
  process.exit(2);
}
const samples = JSON.parse(readFileSync(file, 'utf8')) as Sample[];

let failed = 0;
let skipped = 0;
for (const s of samples) {
  if (s.syntax_ok === false) {
    skipped += 1;
    console.log(`[SKIP] ${s.source} block ${s.index + 1}: YAML 语法层失败（无对象可校验）`);
    continue;
  }
  const v = validatePromptProtocol(s.obj);
  const match = v.ok === s.ok;
  if (!match) failed += 1;
  console.log(
    `[${match ? 'OK' : 'MISMATCH'}] ${s.source} block ${s.index + 1}: ` +
    `python_ok=${s.ok} ts_ok=${v.ok}` +
    (v.errors.length ? ` ts_errors=${v.errors.join('|')}` : ''),
  );
}
console.log(`${samples.length - failed - skipped}/${samples.length} parity (${skipped} skipped)`);
process.exit(failed === 0 ? 0 : 1);
