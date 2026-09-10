import { describe, expect, it } from 'vitest';

import {
  ammAddLiquidity,
  ammBuy,
  ammQuoteBuyExactTokens,
  ammRemoveLiquidity,
  ammSell,
  createPool,
  marketCapCents,
  poolK,
  poolPrice,
  rugRisk,
  type Pool,
} from './amm.js';
import { parsePrice, parseQty, parseUsd } from './money.js';

/** Ein typischer frisch gestarteter Coin: 10.000 $ Liquiditaet, 1 Mrd. Token. */
function freshPool(feeBps = 100): { pool: Pool; lpShares: bigint } {
  return createPool({
    usdCents: parseUsd('10000'),
    tokens: parseQty('1000000000'),
    feeBps,
  });
}

describe('createPool', () => {
  it('setzt den Startkurs aus dem Verhaeltnis der Reserven', () => {
    const { pool } = freshPool();
    // 10.000 $ / 1.000.000.000 Token = 0,00001 $
    expect(poolPrice(pool)).toBe(parsePrice('0.00001'));
  });

  it('gibt LP-Anteile aus', () => {
    const { lpShares } = freshPool();
    expect(lpShares).toBeGreaterThan(0n);
  });

  it('rechnet die Marktkapitalisierung aus', () => {
    const { pool } = freshPool();
    expect(marketCapCents(pool, parseQty('1000000000'))).toBe(parseUsd('10000'));
  });

  it('verweigert einen Pool ohne Liquiditaet', () => {
    expect(() => createPool({ usdCents: 0n, tokens: parseQty('1'), feeBps: 100 })).toThrow();
  });
});

describe('Handel auf der Bonding Curve', () => {
  it('treibt den Kurs beim Kauf nach oben', () => {
    const { pool } = freshPool();
    const before = poolPrice(pool);
    const result = ammBuy(pool, parseUsd('1000'));

    expect(poolPrice(result.pool)).toBeGreaterThan(before);
    expect(result.tokensOut).toBeGreaterThan(0n);
  });

  it('drueckt den Kurs beim Verkauf nach unten', () => {
    const { pool } = freshPool();
    const before = poolPrice(pool);
    const result = ammSell(pool, parseQty('10000000'));

    expect(poolPrice(result.pool)).toBeLessThan(before);
    expect(result.proceedsCents).toBeGreaterThan(0n);
  });

  it('haelt die Invariante k ein - bei JEDEM Trade', () => {
    // Ohne diese Regel koennte man mit vielen Mikro-Trades Geld aus dem
    // Nichts erzeugen. Das hier ist die wichtigste Zeile der ganzen Datei.
    let { pool } = freshPool();
    let k = poolK(pool);

    for (let i = 0; i < 25; i += 1) {
      pool = ammBuy(pool, parseUsd('250')).pool;
      expect(poolK(pool)).toBeGreaterThanOrEqual(k);
      k = poolK(pool);

      pool = ammSell(pool, parseQty('5000000')).pool;
      expect(poolK(pool)).toBeGreaterThanOrEqual(k);
      k = poolK(pool);
    }
  });

  it('bestraft grosse Kaeufe mit mehr Slippage als kleine', () => {
    const { pool } = freshPool();
    const small = ammBuy(pool, parseUsd('100'));
    const large = ammBuy(pool, parseUsd('5000'));

    expect(large.priceImpactBps).toBeGreaterThan(small.priceImpactBps);
    // Wer die Haelfte des Pools kauft, zahlt im Schnitt deutlich mehr je Token.
    expect(large.avgPrice).toBeGreaterThan(small.avgPrice);
  });

  it('laesst Kaufen und sofortiges Zurueckverkaufen Geld kosten', () => {
    const { pool } = freshPool();
    const buy = ammBuy(pool, parseUsd('1000'));
    const sell = ammSell(buy.pool, buy.tokensOut);

    expect(sell.proceedsCents).toBeLessThan(buy.spentCents);
  });

  it('laesst die Gebuehr im Pool und damit bei den Liquiditaetsgebern', () => {
    const withoutFee = freshPool(0);
    const withFee = freshPool(300);

    const a = ammBuy(withoutFee.pool, parseUsd('1000'));
    const b = ammBuy(withFee.pool, parseUsd('1000'));

    expect(b.tokensOut).toBeLessThan(a.tokensOut);
    expect(b.feeCents).toBeGreaterThan(0n);
    expect(b.pool.reserveUsdCents).toBe(a.pool.reserveUsdCents);
  });

  it('nennt vorab den Preis fuer eine exakte Token-Menge', () => {
    const { pool } = freshPool();
    const wanted = parseQty('50000000');
    const quoted = ammQuoteBuyExactTokens(pool, wanted);
    const executed = ammBuy(pool, quoted);

    expect(executed.tokensOut).toBeGreaterThanOrEqual(wanted);
  });

  it('weist sinnlose Trades ab', () => {
    const { pool } = freshPool();
    expect(() => ammBuy(pool, 0n)).toThrow();
    expect(() => ammSell(pool, 0n)).toThrow();
    expect(() => ammQuoteBuyExactTokens(pool, parseQty('2000000000'))).toThrow();
  });
});

describe('Liquiditaet', () => {
  it('gibt beim Hinzufuegen anteilige LP-Anteile aus', () => {
    const { pool } = freshPool();
    const added = ammAddLiquidity(pool, parseUsd('10000'));

    // Verdoppelte Liquiditaet -> etwa doppelt so viele Anteile im Umlauf.
    expect(added.pool.lpShares).toBeGreaterThan(pool.lpShares);
    expect(added.pool.reserveUsdCents).toBe(parseUsd('20000'));
  });

  it('aendert den Kurs beim Hinzufuegen praktisch nicht', () => {
    const { pool } = freshPool();
    const before = poolPrice(pool);
    const after = poolPrice(ammAddLiquidity(pool, parseUsd('5000')).pool);

    const diff = after > before ? after - before : before - after;
    expect(diff * 10_000n).toBeLessThanOrEqual(before); // unter 1 bp Abweichung
  });
});

describe('Rugpull', () => {
  it('laesst den Kurs zusammenbrechen, wenn der Ersteller die Liquiditaet abzieht', () => {
    const { pool, lpShares } = freshPool();

    // Ein paar Opfer kaufen den Coin.
    let live = pool;
    for (let i = 0; i < 4; i += 1) {
      live = ammBuy(live, parseUsd('2500')).pool;
    }
    const priceAtTop = poolPrice(live);

    // Der Ersteller zieht seinen gesamten Anteil ab.
    const rug = ammRemoveLiquidity(live, lpShares);

    expect(rug.usdCents).toBeGreaterThan(0n);
    expect(poolPrice(rug.pool)).toBeLessThan(priceAtTop);
    expect(rug.pool.lpShares).toBe(0n);
  });

  it('erzeugt dabei kein Geld aus dem Nichts', () => {
    // Ein Rugpull ist ein Nullsummenspiel: der Ersteller bekommt hoechstens
    // das zurueck, was er selbst und die Kaeufer eingezahlt haben.
    const startUsd = parseUsd('10000');
    const { pool, lpShares } = freshPool();

    const buyAmount = parseUsd('2500');
    let live = pool;
    let paidIn = 0n;
    for (let i = 0; i < 4; i += 1) {
      live = ammBuy(live, buyAmount).pool;
      paidIn += buyAmount;
    }

    const rug = ammRemoveLiquidity(live, lpShares);

    expect(rug.usdCents).toBeLessThanOrEqual(startUsd + paidIn);
  });

  it('laesst die Bagholder ihre Token behalten - nur wertlos', () => {
    const { pool, lpShares } = freshPool();
    const victim = ammBuy(pool, parseUsd('5000'));
    const rug = ammRemoveLiquidity(victim.pool, lpShares);

    // Die Token sind noch da, aber der Pool ist leer: kaum noch etwas wert.
    expect(victim.tokensOut).toBeGreaterThan(0n);
    expect(rug.pool.reserveUsdCents).toBeLessThan(victim.pool.reserveUsdCents);
  });

  it('warnt vorher: hoher Creator-Anteil ohne Lock ist maximal gefaehrlich', () => {
    const { pool, lpShares } = freshPool();

    const dangerous = rugRisk({ pool, creatorShares: lpShares, lpLockUntil: null, now: 1_000 });
    expect(dangerous.creatorSharePct).toBe(100);
    expect(dangerous.locked).toBe(false);
    expect(dangerous.score).toBe(100);

    const locked = rugRisk({
      pool,
      creatorShares: lpShares,
      lpLockUntil: 100_000,
      now: 1_000,
    });
    expect(locked.locked).toBe(true);
    expect(locked.score).toBeLessThan(dangerous.score);
  });

  it('erkennt einen abgelaufenen Lock als nicht mehr gesperrt', () => {
    const { pool, lpShares } = freshPool();
    const expired = rugRisk({
      pool,
      creatorShares: lpShares,
      lpLockUntil: 500,
      now: 1_000,
    });

    expect(expired.locked).toBe(false);
  });
});

describe('Leerverkauf gegen die Kurve', () => {
  /*
   * Am 11.09. ist der Arena-Markt daran gestorben: Ein Leerverkauf schob
   * beliebig viele Token in die Kurve und drueckte GRAIN in einer Minute von
   * 55 $ auf 0,0000009 $. Danach war der Wert unrettbar - bei einem Kurs von
   * faktisch null kauft niemand mehr genug zurueck.
   *
   * Die Kurve selbst ist dabei nicht kaputt, sie rechnet nur, was man ihr
   * sagt. Diese Tests halten fest, warum die Grenze woanders sitzen muss:
   * beim Bestand des Verkaeufers (`fillOrder` in trading.ts).
   */
  it('zeigt, wie eine grosse Menge den Kurs praktisch auf null zieht', () => {
    const { pool } = freshPool(0);
    const vorher = poolPrice(pool);

    // Das Achttausendfache des Poolbestands - so viel haelt niemand, so viel
    // kann nur ein Leerverkauf hergeben.
    const { pool: danach } = ammSell(pool, pool.reserveTokens * 8_000n);

    expect(Number(poolPrice(danach))).toBeLessThan(Number(vorher) / 1_000_000);
  });

  it('gibt nie mehr aus, als im Pool liegt - der Erloes ist gedeckelt', () => {
    const { pool } = freshPool(0);
    const { proceedsCents, pool: danach } = ammSell(pool, pool.reserveTokens * 8_000n);

    expect(proceedsCents).toBeLessThan(pool.reserveUsdCents);
    expect(danach.reserveUsdCents).toBeGreaterThan(0n);
  });

  it('bleibt beim Verkauf des eigenen Bestands im ertraeglichen Rahmen', () => {
    const { pool } = freshPool(0);
    const vorher = poolPrice(pool);

    // Wer ein Zehntel des Poolbestands haelt und alles abstoesst, drueckt den
    // Kurs deutlich - aber der Markt lebt weiter. Genau diese Grenze macht
    // die Bestandspruefung aus.
    const { pool: danach } = ammSell(pool, pool.reserveTokens / 10n);

    expect(Number(poolPrice(danach))).toBeGreaterThan(Number(vorher) * 0.7);
  });
});
