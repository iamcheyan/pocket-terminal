import '@testing-library/jest-dom/vitest';
import {cleanup} from '@testing-library/react';
import {afterEach, vi} from 'vitest';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom lacks these browser APIs the terminal page depends on.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'ResizeObserver', {value: ResizeObserverStub, writable: true});
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16),
  writable: true,
});
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {value: () => undefined, writable: true});

Object.defineProperty(globalThis, 'cancelAnimationFrame', {value: (id: number) => window.clearTimeout(id), writable: true});
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({
    measureText: () => ({width: 8}),
    fillRect: () => undefined,
    clearRect: () => undefined,
    getImageData: () => ({data: new Uint8ClampedArray(4)}),
    putImageData: () => undefined,
    createImageData: () => [],
    setTransform: () => undefined,
    drawImage: () => undefined,
    save: () => undefined,
    fillText: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    closePath: () => undefined,
    stroke: () => undefined,
    translate: () => undefined,
    scale: () => undefined,
    rotate: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
    measureTextWidth: () => 8,
  }),
  writable: true,
});
