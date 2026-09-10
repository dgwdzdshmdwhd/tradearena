import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOT_PARAMS,
  decide,
  errorRateForLevel,
  xpForLevel,
  type BotConfig,
  type BotView,
} from './bots.js';
import type { Candle } from './indicators.js';
import { abs, parsePrice, parseQty, parseUsd } from './money.js';
import { createRng, seedFrom } from './random.js';
import { FLAT_POSITION, type PositionState } from './types.js';

function candles(closesList: number[], start = 0): Candle[] {
  return closesList.map((close, index) => ({
    t: start + index * 60_000,
    o: close,
    h: close * 1.002,
    l: close * 0.998,
    c: close,
    v: 100,
  }));
}

const risingMarket = candles(Array.from({ length: 60 }, (_, i) => 100 + i));
const fallingMarket = candles(Array.from({ length: 60 }, (_, i) => 160 - i));
const flatMarket = candles(Array.from({ length: 60 }, () => 100));

function view(overrides: Partial<BotView> = {}): BotView {
  const last = (overrides.candles ?? flatMarket)[
    (overrides.candles ?? flatMarket).length - 1
  ]!.c;

  return {
    now: 10_000_000,
    candles: flatMarket,
    quote: {
      bid: parsePrice(String(last)),
      ask: parsePrice(String(last)),
      last: parsePrice(String(last)),
      at: 0,
    },
    position: { ...FLAT_POSITION },
    budgetCents: parseUsd('10000'),
    availableCents: parseUsd('10000'),
    lastActionAt: null,
    sinceLastCheckMs: 15 * 60_000,
    ...overrides,
  };
}

function config(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    strategy: 'momentum',
    params: DEFAULT_BOT_PARAMS.momentum,
    errorRateBps: 0, // fehlerfrei, damit die reine Strategie testbar ist
    level: 5,
    seed: 42,
    ...overrides,
  };
}

describe('Strategien', () => {
  it('DCA kauft einfach immer', () => {
    const intent = decide(config({ strategy: 'dca', params: DEFAULT_BOT_PARAMS.dca }), view());
    expect(intent.action).toBe('buy');
  });

  it('Momentum springt auf einen Aufwaertstrend auf', () => {
    const intent = decide(config(), view({ candles: risingMarket }));
    expect(intent.action).toBe('buy');
    expect(intent.reason).toContain('SMA');
  });

  it('Momentum steigt aus, wenn der Trend bricht', () => {
    const holding: PositionState = {
      qty: parseQty('1'),
      avgEntry: parsePrice('150'),
      realizedPnlCents: 0n,
    };
    const intent = decide(config(), view({ candles: fallingMarket, position: holding }));

    expect(intent.action).toBe('sell');
  });

  it('Mean Reversion kauft in den Abverkauf hinein', () => {
    const intent = decide(
      config({ strategy: 'mean_reversion', params: DEFAULT_BOT_PARAMS.mean_reversion }),
      view({ candles: fallingMarket }),
    );

    expect(intent.action).toBe('buy');
    expect(intent.reason).toContain('RSI');
  });

  it('wartet bei zu wenig Kursdaten ab', () => {
    const intent = decide(config(), view({ candles: candles([100, 101, 102]) }));
    expect(intent.action).toBe('hold');
  });

  it('haelt still, solange der Takt nicht abgelaufen ist', () => {
    const intent = decide(
      config(),
      view({ candles: risingMarket, lastActionAt: 10_000_000 - 1_000 }),
    );

    expect(intent.action).toBe('hold');
  });
});

describe('Ordergroesse', () => {
  it('haelt sich an das Budget', () => {
    const intent = decide(config(), view({ candles: risingMarket }));
    // 30 % von 10.000 $ bei Kurs 159 -> knapp 18,9 Stueck
    expect(intent.qty).toBeGreaterThan(0n);
    expect(intent.qty).toBeLessThan(parseQty('20'));
  });

  it('kauft nichts, wenn kein Geld mehr da ist', () => {
    const intent = decide(config(), view({ candles: risingMarket, availableCents: 0n }));

    expect(intent.action).toBe('hold');
    expect(intent.reason).toContain('Budget');
  });

  it('verkauft nie mehr, als der Bot besitzt', () => {
    const holding: PositionState = {
      qty: parseQty('0.5'),
      avgEntry: parsePrice('150'),
      realizedPnlCents: 0n,
    };
    const intent = decide(config(), view({ candles: fallingMarket, position: holding }));

    expect(intent.action).toBe('sell');
    expect(intent.qty).toBeLessThanOrEqual(abs(holding.qty));
  });
});

describe('Fehler-Engine', () => {
  it('macht ohne Fehlerquote keine Fehler', () => {
    for (let i = 0; i < 50; i += 1) {
      const intent = decide(
        config({ errorRateBps: 0, seed: i }),
        view({ candles: risingMarket, now: 10_000_000 + i * 1_000 }),
      );
      expect(intent.mistake).toBeNull();
    }
  });

  it('macht bei hoher Fehlerquote sichtbar Fehler', () => {
    let mistakes = 0;
    for (let i = 0; i < 100; i += 1) {
      const intent = decide(
        config({ errorRateBps: 9_000, seed: i }),
        view({ candles: risingMarket, now: 10_000_000 + i * 1_000 }),
      );
      if (intent.mistake !== null) mistakes += 1;
    }

    expect(mistakes).toBeGreaterThan(50);
  });

  it('macht nicht mehr Fehler, nur weil oefter hingeschaut wird', () => {
    // Die Fehlerquote gilt je Entscheidung. Wer den Bot alle zwei Minuten
    // fragt, muss ueber eine Stunde etwa gleich viele Fehler sehen wie
    // jemand, der alle zehn Sekunden fragt - sonst haengt das Verhalten am
    // Takt des Servers statt am Bot.
    const count = (checkMs: number): number => {
      let mistakes = 0;
      const schritte = Math.round((60 * 60_000) / checkMs);

      for (let i = 0; i < schritte; i += 1) {
        const intent = decide(
          config({ errorRateBps: 3_000, seed: 4_242 }),
          view({
            candles: risingMarket,
            now: 10_000_000 + i * checkMs,
            sinceLastCheckMs: checkMs,
          }),
        );
        if (intent.mistake !== null) mistakes += 1;
      }

      return mistakes;
    };

    const selten = count(DEFAULT_BOT_PARAMS.momentum.intervalMs);
    const oft = count(10_000);

    expect(selten).toBeGreaterThan(0);
    // Grosszuegig gefasst, aber weit weg vom alten Verhalten: ohne die
    // Zeitgewichtung waere "oft" rund das Zwoelffache von "selten".
    expect(oft).toBeLessThan(selten * 2.5);
  });

  it('ist reproduzierbar - gleicher Seed, gleiche Entscheidung', () => {
    const first = decide(config({ errorRateBps: 5_000, seed: 7 }), view({ candles: risingMarket }));
    const second = decide(config({ errorRateBps: 5_000, seed: 7 }), view({ candles: risingMarket }));

    expect(second).toEqual(first);
  });

  it('haengt bei sauberer Arbeit einen Stop-Loss an', () => {
    const intent = decide(config({ errorRateBps: 0 }), view({ candles: risingMarket }));

    expect(intent.action).toBe('buy');
    expect(intent.attachStopBps).toBe(DEFAULT_BOT_PARAMS.momentum.stopLossBps);
  });

  it('erfindet auch beim Vertippen keine Token aus dem Nichts', () => {
    const holding: PositionState = {
      qty: parseQty('0.5'),
      avgEntry: parsePrice('150'),
      realizedPnlCents: 0n,
    };

    for (let i = 0; i < 200; i += 1) {
      const intent = decide(
        config({ errorRateBps: 10_000, seed: i }),
        view({ candles: fallingMarket, position: holding, now: 10_000_000 + i * 1_000 }),
      );
      if (intent.action === 'sell') {
        expect(intent.qty).toBeLessThanOrEqual(abs(holding.qty));
      }
    }
  });
});

describe('Fortschritt', () => {
  it('macht hoehere Level zuverlaessiger, aber nie perfekt', () => {
    expect(errorRateForLevel(1)).toBe(1_800);
    expect(errorRateForLevel(10)).toBeLessThan(errorRateForLevel(1));
    expect(errorRateForLevel(10)).toBeGreaterThan(0);
  });

  it('deckelt das Level nach oben und unten ab', () => {
    expect(errorRateForLevel(-5)).toBe(errorRateForLevel(1));
    expect(errorRateForLevel(99)).toBe(errorRateForLevel(10));
  });

  it('laesst die XP-Kosten je Level steigen', () => {
    expect(xpForLevel(2)).toBeGreaterThan(xpForLevel(1));
    expect(xpForLevel(5)).toBeGreaterThan(xpForLevel(4));
  });
});

describe('Zufallsgenerator', () => {
  it('liefert bei gleichem Seed dieselbe Folge', () => {
    const a = createRng(123);
    const b = createRng(123);

    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it('bleibt im erwarteten Bereich', () => {
    const rng = createRng(5);
    for (let i = 0; i < 500; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      const int = rng.int(3, 7);
      expect(int).toBeGreaterThanOrEqual(3);
      expect(int).toBeLessThanOrEqual(7);
    }
  });

  it('macht aus IDs stabile Seeds', () => {
    expect(seedFrom('bot', 'abc')).toBe(seedFrom('bot', 'abc'));
    expect(seedFrom('bot', 'abc')).not.toBe(seedFrom('bot', 'abd'));
  });
});
