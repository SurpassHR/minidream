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
    loginLabel: string;
    pointsLabel: string;
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
    modes: string[];
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function fetchGenerateData(): Promise<GenerateData> {
  const res = await fetch('/api/generate');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function sendChat(message: string): Promise<{ reply: string; title: string }> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
