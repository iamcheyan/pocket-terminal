import {render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {findInDirection, navigate, activateFocused} from './input';

/**
 * Spatial navigation is the D-Pad/gamepad contract: given a grid of controls,
 * a direction must move to the geometrically adjacent one, not the next node
 * in DOM order. jsdom has no layout, so bounding boxes are stubbed.
 */
const buildGrid = () => {
  document.body.innerHTML = '';
  const wrap = document.createElement('div');
  document.body.appendChild(wrap);
  const boxes: Record<string, DOMRect> = {
    a: {left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40, x: 0, y: 0, toJSON: () => ({})} as DOMRect,
    b: {left: 120, top: 0, right: 220, bottom: 40, width: 100, height: 40, x: 120, y: 0, toJSON: () => ({})} as DOMRect,
    c: {left: 0, top: 60, right: 100, bottom: 100, width: 100, height: 40, x: 0, y: 60, toJSON: () => ({})} as DOMRect,
    d: {left: 120, top: 60, right: 220, bottom: 100, width: 100, height: 40, x: 120, y: 60, toJSON: () => ({})} as DOMRect,
  };
  const nodes: Record<string, HTMLElement> = {};
  for (const key of Object.keys(boxes)) {
    const button = document.createElement('button');
    button.dataset.kb = 'true';
    button.textContent = key;
    button.setAttribute('aria-label', key);
    button.getBoundingClientRect = () => boxes[key];
    nodes[key] = button;
    wrap.appendChild(button);
  }
  return nodes;
};

describe('spatial navigation', () => {
  it('moves right to the geometric neighbour, not the DOM neighbour', () => {
    const nodes = buildGrid();
    nodes.a.focus();
    expect(navigate('right')).toBe(true);
    expect(document.activeElement).toBe(nodes.b);
  });

  it('moves down from the first column to the one directly below it', () => {
    const nodes = buildGrid();
    nodes.b.focus();
    expect(navigate('down')).toBe(true);
    expect(document.activeElement).toBe(nodes.d);
    nodes.a.focus();
    expect(findInDirection('down')).toBe(nodes.c);
  });

  it('refuses to leave the grid', () => {
    const nodes = buildGrid();
    nodes.a.focus();
    expect(navigate('left')).toBe(false);
    expect(navigate('up')).toBe(false);
    expect(document.activeElement).toBe(nodes.a);
  });

  it('marks the DPad focus ring so a controller user can see the cursor', () => {
    const nodes = buildGrid();
    nodes.a.focus();
    navigate('right');
    expect(nodes.b.getAttribute('data-dpad-active')).toBe('true');
  });

  it('skips disabled controls', () => {
    document.body.innerHTML = '';
    const wrap = document.createElement('div');
    document.body.appendChild(wrap);
    const left = document.createElement('button');
    const right = document.createElement('button');
    left.dataset.kb = 'true';
    right.dataset.kb = 'true';
    left.getBoundingClientRect = () => ({left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40, x: 0, y: 0, toJSON: () => ({})}) as DOMRect;
    right.getBoundingClientRect = () => ({left: 80, top: 0, right: 120, bottom: 40, width: 40, height: 40, x: 80, y: 0, toJSON: () => ({})}) as DOMRect;
    right.disabled = true;
    wrap.append(left, right);
    left.focus();
    expect(navigate('right')).toBe(false);
    right.disabled = false;
    expect(navigate('right')).toBe(true);
  });

  it('activates the focused control through a real click', () => {
    const nodes = buildGrid();
    const spy = vi.fn();
    nodes.a.addEventListener('click', spy);
    nodes.a.focus();
    expect(activateFocused()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not activate when focus sits outside a data-kb control', () => {
    document.body.innerHTML = '<input id="plain" />';
    const input = document.getElementById('plain') as HTMLInputElement;
    input.focus();
    expect(activateFocused()).toBe(false);
  });
});

describe('focus helpers in rendered UI', () => {
  it('walks a rendered toolbar', () => {
    render(
      <div>
        <button data-kb aria-label="one">
          one
        </button>
        <button data-kb aria-label="two">
          two
        </button>
      </div>,
    );
    const [one, two] = [screen.getByLabelText('one'), screen.getByLabelText('two')];
    for (const node of [one, two]) {
      node.getBoundingClientRect = () => ({left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10, x: 0, y: 0, toJSON: () => ({})}) as DOMRect;
    }
    one.focus();
    two.getBoundingClientRect = () => ({left: 40, top: 0, right: 50, bottom: 10, width: 10, height: 10, x: 40, y: 0, toJSON: () => ({})}) as DOMRect;
    expect(navigate('right')).toBe(true);
    expect(document.activeElement).toBe(two);
  });
});
