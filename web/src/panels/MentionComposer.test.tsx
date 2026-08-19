import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MentionComposer } from './MentionComposer';

function textOffset(root: HTMLElement, target: Node, offset: number): number {
  if (target === root) return offset === 0 ? 0 : root.textContent?.length ?? 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === target) return total + offset;
    total += node.textContent?.length ?? 0;
  }
  return total;
}

function renderComposer(onChange = vi.fn()) {
  render(
    <MentionComposer
      value=""
      assets={[]}
      placeholder="输入"
      testId="mention-composer-test"
      mentionOpen={false}
      mentionItems={[]}
      mentionActiveIndex={0}
      mentionTestIdPrefix="chat"
      onChange={onChange}
      onKeyDown={() => {}}
      onSelectMention={() => {}}
    />,
  );
  return screen.getByTestId('mention-composer-test');
}

describe('MentionComposer IME', () => {
  it('组合输入期间不提交中间文本，compositionend 后提交最终文本一次', () => {
    const onChange = vi.fn();
    const editor = renderComposer(onChange);

    fireEvent.compositionStart(editor);
    editor.textContent = 'ni';
    fireEvent.input(editor, { nativeEvent: { isComposing: true } });
    expect(onChange).not.toHaveBeenCalled();

    editor.textContent = '你';
    fireEvent.compositionEnd(editor);
    // 浏览器通常还会在 compositionend 后补发一次 input，不能重复提交。
    fireEvent.input(editor);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('你');
  });

  it('普通输入仍立即提交', () => {
    const onChange = vi.fn();
    const editor = renderComposer(onChange);

    editor.textContent = 'hello';
    fireEvent.input(editor);
    expect(onChange).toHaveBeenCalledWith('hello');
  });

  it('保留 contenteditable 原生 br 换行', () => {
    const onChange = vi.fn();
    const editor = renderComposer(onChange);

    editor.append(document.createTextNode('第一行'));
    editor.append(document.createElement('br'));
    editor.append(document.createTextNode('第二行'));
    fireEvent.input(editor);

    expect(onChange).toHaveBeenCalledWith('第一行\n第二行');
  });
});

describe('MentionComposer selection', () => {
  it('在文本中间插入后保留光标位置，不跳到行末', () => {
    function ControlledComposer() {
      const [value, setValue] = useState('hello');
      return (
        <MentionComposer
          value={value}
          assets={[]}
          placeholder="输入"
          testId="controlled-composer"
          mentionOpen={false}
          mentionItems={[]}
          mentionActiveIndex={0}
          mentionTestIdPrefix="chat"
          onChange={setValue}
          onKeyDown={() => {}}
          onSelectMention={() => {}}
        />
      );
    }

    render(<ControlledComposer />);
    const editor = screen.getByTestId('controlled-composer');
    editor.focus();
    editor.textContent = 'heXllo';
    const textNode = editor.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 3);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.input(editor);

    const restored = window.getSelection()!;
    expect(textOffset(editor, restored.anchorNode!, restored.anchorOffset)).toBe(3);
  });
});
