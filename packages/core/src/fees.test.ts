import { describe, expect, it } from 'vitest';

import { computeFeeCents } from './fees.js';
import { parseUsd } from './money.js';
import type { FeeConfig } from './types.js';

const CONFIG: FeeConfig = { takerBps: 10, makerBps: 4, fixedCents: 0n };

describe('computeFeeCents', () => {
  it('rechnet Basispunkte auf das Volumen', () => {
    expect(computeFeeCents(parseUsd('10000'), CONFIG)).toBe(parseUsd('10'));
  });

  it('macht Maker guenstiger als Taker', () => {
    expect(computeFeeCents(parseUsd('10000'), CONFIG, 'maker')).toBe(parseUsd('4'));
  });

  it('rundet immer auf - zu Lasten des Spielers', () => {
    // 1 Cent Volumen bei 10 bps waere rechnerisch 0,001 Cent.
    // Wuerden wir abrunden, waeren Mikro-Orders gebuehrenfrei und jemand
    // wuerde genau das ausnutzen.
    expect(computeFeeCents(1n, CONFIG)).toBe(1n);
  });

  it('addiert die Fixgebuehr', () => {
    const withFixed: FeeConfig = { ...CONFIG, fixedCents: 99n };
    expect(computeFeeCents(parseUsd('10000'), withFixed)).toBe(parseUsd('10') + 99n);
  });

  it('behandelt negatives Volumen wie positives', () => {
    expect(computeFeeCents(-parseUsd('10000'), CONFIG)).toBe(parseUsd('10'));
  });

  it('kann komplett gebuehrenfrei sein', () => {
    const free: FeeConfig = { takerBps: 0, makerBps: 0, fixedCents: 0n };
    expect(computeFeeCents(parseUsd('10000'), free)).toBe(0n);
  });
});
