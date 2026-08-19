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

export function useAssetMentions(input: string) {
  const [assets, setAssets] = useState<MentionAsset[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const mention = findAssetMention(input);

  useEffect(() => {
    let disposed = false;
    void client.listAssets().then((items) => {
      if (!disposed) setAssets(items.filter((item): item is MentionAsset => typeof item.id === 'string'));
    }).catch(() => {
      if (!disposed) setAssets([]);
    });
    return () => { disposed = true; };
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
