export interface RailItem {
  id: string;
  label: string;
  /** icon key resolved by the frontend */
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

export interface ChatReply {
  reply: string;
  title: string;
}
