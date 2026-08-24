import type { ReactNode } from 'react';
import type { SessionAsset } from './sessionAssets';

export function MentionText({
  value,
  assets,
  onOpen,
  tokenClassName = 'mention-inline-token',
}: {
  value: string;
  assets: SessionAsset[];
  onOpen: (asset: SessionAsset) => void;
  tokenClassName?: string;
}) {
  const byName = new Map(assets.map(asset => [asset.name.toLowerCase(), asset]));
  const pattern = /@(image\d+|video\d+)(?![\w])/gi;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value))) {
    const token = match[0];
    const asset = byName.get((match[1] ?? '').toLowerCase());
    if (!asset) continue;
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
    nodes.push(
      <code
        key={`${match.index}-${token}`}
        className={`${tokenClassName} ${asset.kind}`}
        title={asset.name}
        onMouseDown={event => event.preventDefault()}
        onClick={event => {
          event.stopPropagation();
          onOpen(asset);
        }}
      >
        {token}
      </code>,
    );
    cursor = match.index + token.length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return <>{nodes}</>;
}
