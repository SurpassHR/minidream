import { useEffect, useMemo, useState } from 'react';
import { client } from '../api/client';
import { Icon } from '../icons';

export type MentionAsset = {
  id: string;
  kind: 'txt' | 'img' | 'vid';
  name: string;
  meta?: string;
  caption?: string;
};

export function findAssetMention(value: string): { start: number; end: number; query: string } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(value);
  if (!match || match.index === undefined) return null;
  return {
    start: match.index + match[1]!.length,
    end: match.index + match[0].length,
    query: match[2] ?? '',
  };
}

export function replaceAssetMention(value: string): string {
  const mention = findAssetMention(value);
  if (!mention) return value;
  return `${value.slice(0, mention.start)}${value.slice(mention.end)}`;
}

export function insertAssetMention(value: string, item: MentionAsset): string {
  return `${replaceAssetMention(value)}@${item.name} `;
}

// 素材库变更全局信号：App 在 refreshAssets 成功后广播，@ 引用菜单监听后重拉素材。
// 素材库是项目级的（<projectDir>/.director/assets），变更点汇聚在 App.refreshAssets（AssetLibrary 的
// 导入/编辑/删除/caption 都经 onAssetsChanged 触发它），在此广播可让所有 @ 引用输入框
// （StoryChat / AgentPanel）即时拿到新素材，无需改动组件 props 契约。
const ASSETS_CHANGED_EVENT = 'director:assets-changed';

export function broadcastAssetsChanged(): void {
  window.dispatchEvent(new CustomEvent(ASSETS_CHANGED_EVENT));
}

export function useAssetMentions(input: string) {
  const [assets, setAssets] = useState<MentionAsset[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const mention = findAssetMention(input);

  // 挂载时加载一次；此后监听素材库变更事件（broadcastAssetsChanged）重新拉取，
  // 保证素材库新增/删除素材后 @ 引用菜单与素材库面板保持一致。
  useEffect(() => {
    let disposed = false;
    const load = () => {
      void client.listAssets().then((items) => {
        if (!disposed) setAssets(items.filter((item): item is MentionAsset => typeof item.id === 'string'));
      }).catch(() => {
        if (!disposed) setAssets([]);
      });
    };
    load();
    window.addEventListener(ASSETS_CHANGED_EVENT, load);
    return () => {
      disposed = true;
      window.removeEventListener(ASSETS_CHANGED_EVENT, load);
    };
  }, []);

  useEffect(() => {
    setActiveIndex(0);
    setDismissedQuery(null);
  }, [mention?.query]);

  const candidates = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLocaleLowerCase();
    return assets.filter((item) => item.name.toLocaleLowerCase().includes(query));
  }, [assets, mention]);

  const open = mention !== null && dismissedQuery !== mention.query && candidates.length > 0;

  const dismiss = () => setDismissedQuery(mention?.query ?? '');

  const handleKeyDown = (event: React.KeyboardEvent, onSelect: (item: MentionAsset) => void): boolean => {
    if (!open) return false;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % candidates.length);
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const item = candidates[activeIndex];
      if (item) onSelect(item);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return true;
    }
    return false;
  };

  return { assets, mention, candidates, activeIndex, open, dismiss, handleKeyDown };
}

export function AssetMentionMenu(props: {
  items: MentionAsset[];
  activeIndex: number;
  onSelect: (item: MentionAsset) => void;
  testIdPrefix: 'chat' | 'agent';
}) {
  if (props.items.length === 0) return null;
  return (
    <div
      className="asset-mention-menu"
      data-testid={`${props.testIdPrefix}-asset-mention-menu`}
      data-placement="above"
      data-width-bound="container"
      role="listbox"
    >
      <div className="asset-mention-title"><span aria-hidden="true">@</span>引用素材</div>
      {props.items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={index === props.activeIndex}
          className={`asset-mention-option${index === props.activeIndex ? ' active' : ''}`}
          data-testid={`${props.testIdPrefix}-asset-mention-${item.id}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onSelect(item)}
        >
          <Icon name={item.kind === 'txt' ? 'file-text' : item.kind === 'img' ? 'image' : 'video'} />
          <span>{item.name}</span>
          <small>{item.kind.toUpperCase()}</small>
        </button>
      ))}
    </div>
  );
}
