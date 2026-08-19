import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Icon } from './icons';

describe('Icon', () => {
  it('uses a stable class, semantic name and relaxed editor stroke', () => {
    const { container } = render(<Icon name="image" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('dw-icon');
    expect(svg).toHaveAttribute('data-icon', 'image');
    expect(svg).toHaveAttribute('stroke-width', '1.5');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
  });
});
