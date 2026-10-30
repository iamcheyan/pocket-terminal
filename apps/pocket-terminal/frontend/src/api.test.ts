import {describe, expect, it} from 'vitest';
import {
  asArray,
  asBool,
  asNumber,
  asRecord,
  asString,
  errorMessage,
  formatBytes,
  formatDuration,
  ApiError,
} from './api';

/**
 * The API boundary is the only place foreign JSON is allowed; these parsers
 * must never throw or produce `undefined` leaking into the UI.
 */
describe('api boundary parsers', () => {
  it('coerces missing and malformed values safely', () => {
    expect(asString(undefined, 'fallback')).toBe('fallback');
    expect(asString(42)).toBe('42');
    expect(asNumber('12.5')).toBe(12.5);
    expect(asNumber('nope', 7)).toBe(7);
    expect(asBool(true)).toBe(true);
    expect(asBool('true')).toBe(true);
    expect(asBool(1)).toBe(false);
    expect(asArray(null)).toEqual([]);
    expect(asArray({})).toEqual([]);
    expect(asRecord([])).toEqual({});
    expect(asRecord({a: 1})).toEqual({a: 1});
  });

  it('renders byte counts with binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(-1)).toBe('—');
  });

  it('renders uptime in human units', () => {
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(90)).toBe('1m');
    expect(formatDuration(3700)).toBe('1h 1m');
    expect(formatDuration(90000)).toBe('1d 1h');
  });

  it('maps error codes to actionable messages', () => {
    expect(errorMessage(new ApiError('host_key_unknown', 'x', 409))).toMatch(/confirm the fingerprint/i);
    expect(errorMessage(new ApiError('host_key_mismatch', 'x', 409))).toMatch(/refused/i);
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });
});
