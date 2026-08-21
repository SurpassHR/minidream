export interface RailItem {
  id: string;
  label: string;
  icon: string;
  active?: boolean;
}

export interface SkillCard {
  id: string;
  tag: string;
  title: string;
  desc: string;
  image: string;
}

export interface GenerateData {
  rail: {
    items: RailItem[];
  };
  sidebar: {
    createLabel: string;
    newChatLabel: string;
  };
  hero: {
    title: string;
  };
  skills: SkillCard[];
  composer: {
    placeholder: string;
    agentOptions: string[];
    preferences: {
      types: string[];
      ratios: string[];
      models: string[];
    };
    skills: { id: string; name: string; tag?: string; desc: string }[];
    skillFooter: string[];
  };
}

export interface ChatStage {
  type: 'thinking' | 'task' | 'done';
  logs?: string[];
  progress?: { completed: number; total: number };
  taskLabel?: string;
  queued?: boolean;
  queueLabel?: string;
  credits?: number;
  suggestion?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  stages?: ChatStage[];
}

export interface ChatReply {
  title: string;
  reply?: string;
  stages?: ChatStage[];
}

export async function fetchGenerateData(): Promise<GenerateData> {
  const res = await fetch('/api/generate');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function sendChat(message: string): Promise<ChatReply> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
