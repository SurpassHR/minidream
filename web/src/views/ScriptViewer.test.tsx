import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScriptViewer, tokenizeScriptLine } from './ScriptViewer';

describe('tokenizeScriptLine', () => {
  it('object 关键字：词边界 + 大小写不敏感', () => {
    expect(tokenizeScriptLine('object: 精灵骑士')).toEqual([
      { text: 'object', kind: 'object' },
      { text: ': 精灵骑士', kind: 'plain' },
    ]);
    expect(tokenizeScriptLine('Object 和 OBJECT 和 myobjects')).toEqual([
      { text: 'Object', kind: 'object' },
      { text: ' 和 ', kind: 'plain' },
      { text: 'OBJECT', kind: 'object' },
      { text: ' 和 ', kind: 'plain' },
      { text: 'myobjects', kind: 'plain' }, // 词边界：myobjects 不是 object
    ]);
  });

  it('<> 与 [] 字段：含括号、多组、不跨行', () => {
    expect(tokenizeScriptLine('<相机> 拉近 [特写] 结束')).toEqual([
      { text: '<相机>', kind: 'angle' },
      { text: ' 拉近 ', kind: 'plain' },
      { text: '[特写]', kind: 'square' },
      { text: ' 结束', kind: 'plain' },
    ]);
    expect(tokenizeScriptLine('<Picture 2> 保持场景一致')).toEqual([
      { text: '<Picture 2>', kind: 'angle' },
      { text: ' 保持场景一致', kind: 'plain' },
    ]);
    expect(tokenizeScriptLine('无括号字段')).toEqual([{ text: '无括号字段', kind: 'plain' }]);
  });

  it('优先级：<> 优先于 [] 优先于 object', () => {
    expect(tokenizeScriptLine('<object>')).toEqual([{ text: '<object>', kind: 'angle' }]);
    expect(tokenizeScriptLine('[object]')).toEqual([{ text: '[object]', kind: 'square' }]);
    expect(tokenizeScriptLine('object [x] <y>')).toEqual([
      { text: 'object', kind: 'object' },
      { text: ' ', kind: 'plain' },
      { text: '[x]', kind: 'square' },
      { text: ' ', kind: 'plain' },
      { text: '<y>', kind: 'angle' },
    ]);
  });

  it('空行与空字符串', () => {
    expect(tokenizeScriptLine('')).toEqual([]);
    expect(tokenizeScriptLine('   ')).toEqual([{ text: '   ', kind: 'plain' }]);
  });
});

describe('ScriptViewer', () => {
  it('渲染行号与三类高亮 token', () => {
    render(<ScriptViewer text={'object: 精灵\n<相机> [特写]'} />);
    expect(screen.getByTestId('script-line-1')).toHaveTextContent('object: 精灵');
    expect(screen.getByTestId('script-line-2')).toHaveTextContent('<相机> [特写]');
    expect(screen.getByText('object').className).toContain('tok-object');
    expect(screen.getByText('<相机>').className).toContain('tok-angle');
    expect(screen.getByText('[特写]').className).toContain('tok-square');
  });

  it('特殊字符原样展示（无注入）', () => {
    render(<ScriptViewer text={'<img onerror="x"> [<script>]'} />);
    // 文本节点渲染：<img ...> 作为文本出现，不产生 img 元素
    expect(screen.getByTestId('script-line-1')).toHaveTextContent('<img onerror="x"> [<script>]');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });
});
