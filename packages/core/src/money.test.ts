import { describe, expect, it } from 'vitest';

import {
  divRound,
  formatPrice,
  formatUsd,
  isqrt,
  notionalCents,
  parsePrice,
  parseQty,
  parseUsd,
  priceFromNotional,
  qtyFromNotional,
  roundToStep,
} from './money.js';

describe('divRound', () => {
  it('rundet positive Zahlen nach Modus', () => {
    expect(divRound(7n, 2n, 'trunc')).toBe(3n);
    expect(divRound(7n, 2n, 'floor')).toBe(3n);
    expect(divRound(7n, 2n, 'ceil')).toBe(4n);
    expect(divRound(7n, 2n, 'half_up')).toBe(4n);
  });

  // Genau hier gehen naive Implementierungen kaputt - und Short-Positionen
  // rechnen staendig mit negativen Zwischenwerten.
  it('rundet negative Zahlen korrekt', () => {
    expect(divRound(-7n, 2n, 'trunc')).toBe(-3n);
    expect(divRound(-7n, 2n, 'floor')).toBe(-4n);
    expect(divRound(-7n, 2n, 'ceil')).toBe(-3n);
    expect(divRound(-7n, 2n, 'half_up')).toBe(-4n);
  });

  it('behandelt genau die Haelfte als "weg von der Null"', () => {
    expect(divRound(5n, 10n, 'half_up')).toBe(1n);
    expect(divRound(-5n, 10n, 'half_up')).toBe(-1n);
    expect(divRound(4n, 10n, 'half_up')).toBe(0n);
  });

  it('laesst glatte Divisionen unveraendert', () => {
    for (const mode of ['trunc', 'floor', 'ceil', 'half_up'] as const) {
      expect(divRound(100n, 4n, mode)).toBe(25n);
      expect(divRound(-100n, 4n, mode)).toBe(-25n);
    }
  });

  it('verweigert eine Division durch null', () => {
    expect(() => divRound(1n, 0n, 'half_up')).toThrow();
  });
});

describe('Dezimal-Ein- und Ausgabe', () => {
  it('liest Preise mit acht Nachkommastellen', () => {
    expect(parsePrice('43218.50')).toBe(4_321_850_000_000n);
    expect(parsePrice('0.00000123')).toBe(123n);
    expect(parsePrice('1')).toBe(100_000_000n);
  });

  it('akzeptiert das deutsche Komma', () => {
    expect(parsePrice('1,5')).toBe(parsePrice('1.5'));
  });

  it('schneidet ueberzaehlige Stellen ab statt zu runden', () => {
    // Eine Eingabe darf nie heimlich groesser werden, als der Nutzer getippt hat.
    expect(parsePrice('1.123456789')).toBe(112_345_678n);
  });

  it('formatiert zurueck', () => {
    expect(formatPrice(4_321_850_000_000n, 2)).toBe('43218.50');
    expect(formatUsd(-12_345n)).toBe('-123.45');
    expect(formatUsd(0n)).toBe('0.00');
  });

  it('kommt mit wissenschaftlicher Notation aus JavaScript klar', () => {
    expect(parsePrice(1e-7)).toBe(10n);
  });

  it('lehnt Unsinn ab', () => {
    expect(() => parsePrice('abc')).toThrow();
    expect(() => parsePrice('')).toThrow();
  });
});

describe('notionalCents', () => {
  it('rechnet Preis mal Menge in Cent um', () => {
    expect(notionalCents(parsePrice('100'), parseQty('1'))).toBe(10_000n);
    expect(notionalCents(parsePrice('43218.50'), parseQty('0.5'))).toBe(2_160_925n);
  });

  it('kommt mit winzigen Coin-Preisen zurecht', () => {
    // 1 Milliarde Token zu 0,00000123 $ = 1230 $
    expect(notionalCents(parsePrice('0.00000123'), parseQty('1000000000'))).toBe(123_000n);
  });

  it('ist mit qtyFromNotional und priceFromNotional konsistent', () => {
    const price = parsePrice('250.25');
    const qty = parseQty('4');
    const cents = notionalCents(price, qty);

    expect(qtyFromNotional(cents, price)).toBe(qty);
    expect(priceFromNotional(cents, qty)).toBe(price);
  });
});

describe('Hilfsfunktionen', () => {
  it('isqrt liefert die ganzzahlige Wurzel', () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(1_000_000n)).toBe(1_000n);
    expect(isqrt(99n)).toBe(9n);
    expect(isqrt(10n ** 30n)).toBe(10n ** 15n);
  });

  it('roundToStep rundet auf die Lot-Groesse', () => {
    const step = parseQty('0.001');
    expect(roundToStep(parseQty('1.2345'), step)).toBe(parseQty('1.234'));
    expect(roundToStep(parseQty('1.2345'), step, 'ceil')).toBe(parseQty('1.235'));
  });

  it('parseUsd liest Dollarbetraege als Cent', () => {
    expect(parseUsd('100000')).toBe(10_000_000n);
    expect(parseUsd('0.01')).toBe(1n);
  });
});
