export const STORY_KICKOFF_MARKER = '（开始访谈）';
export const STORY_SUMMARIZE_MARKER = '（请总结成稿）';
export const STORY_SYSTEM_MARKERS = [STORY_KICKOFF_MARKER, STORY_SUMMARIZE_MARKER] as const;
export const STORY_KICKOFF_MESSAGE =
  '这是新会话。按系统提示词开始访谈：先问用户希望使用哪种访谈语言，然后在文末给出 choice 代码块。';

export interface ChoiceOption {
  id: string;
  label: string;
}

export interface ParsedChoice {
  question: string;
  options: ChoiceOption[];
  prompt: string;
}

interface ChoicePayload {
  question?: unknown;
  options?: unknown;
}

// 只匹配完整的、按行闭合的 choice 围栏；不消费收尾围栏后面的换行，
// 这样 prompt 的清洗严格等价于“移除围栏本身，再 trimEnd”。
const CHOICE_FENCE = /^```choice[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?=\r?$)/gm;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseChoiceBlock(text: string): ParsedChoice | null {
  let lastMatch: RegExpExecArray | null = null;
  CHOICE_FENCE.lastIndex = 0;
  for (const match of text.matchAll(CHOICE_FENCE)) lastMatch = match;
  CHOICE_FENCE.lastIndex = 0;
  if (!lastMatch || lastMatch.index === undefined) return null;

  let payload: ChoicePayload;
  try {
    payload = JSON.parse(lastMatch[1]!.trim()) as ChoicePayload;
  } catch {
    return null;
  }
  if (!isRecord(payload) || typeof payload.question !== 'string' || !payload.question.trim()) return null;
  if (!Array.isArray(payload.options) || payload.options.length < 2 || payload.options.length > 4) return null;

  const labels = new Set<string>();
  const options: ChoiceOption[] = [];
  for (const [index, option] of payload.options.entries()) {
    if (!isRecord(option) || typeof option.label !== 'string') return null;
    const label = option.label.trim();
    if (!label || labels.has(label)) return null;
    labels.add(label);

    let id = `opt-${index}`;
    if (Object.prototype.hasOwnProperty.call(option, 'id')) {
      if (typeof option.id !== 'string' || !option.id.trim()) return null;
      id = option.id;
    }
    options.push({ id, label });
  }

  const fenceStart = lastMatch.index;
  const fenceEnd = fenceStart + lastMatch[0].length;
  return {
    question: payload.question.trim(),
    options,
    prompt: `${text.slice(0, fenceStart)}${text.slice(fenceEnd)}`.trimEnd(),
  };
}
