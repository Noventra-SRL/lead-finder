import { describe, expect, it } from 'vitest';
import { describeUserAgent, formatDate, formatDateTime, formatDuration, formatRelative, roleLabel } from './format.ts';

describe('formattazione', () => {
  it('date nel fuso di Roma e trattino per valori assenti', () => {
    expect(formatDateTime('2026-07-01T10:30:00Z')).toMatch(/01 lug 2026.*12:30/);
    expect(formatDateTime(null)).toBe('—');
    expect(formatDate('2026-07-24T11:04:51Z')).toBe('24 luglio 2026');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDateTime('non-una-data')).toBe('—');
  });

  it('tempi relativi e durate', () => {
    const now = Date.parse('2026-01-10T12:00:00Z');
    expect(formatRelative('2026-01-10T11:59:40Z', now)).toBe('adesso');
    expect(formatRelative('2026-01-10T11:15:00Z', now)).toBe('45 min fa');
    expect(formatRelative('2026-01-08T12:00:00Z', now)).toBe('2 g fa');
    expect(formatDuration(59)).toBe('0 min');
    expect(formatDuration(3_700)).toBe('1 h 1 min');
    expect(formatDuration(90_000)).toBe('1 g 1 h');
  });

  it('dispositivi e ruoli', () => {
    expect(
      describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'),
    ).toBe('Chrome su Windows');
    expect(describeUserAgent('')).toBe('Dispositivo sconosciuto');
    expect(roleLabel('admin')).toBe('Amministratore');
  });
});
