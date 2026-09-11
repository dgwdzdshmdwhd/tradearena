import type { Db } from './db.js';
import { big, int } from './util.js';

/**
 * Die Auswertung am Rundenende.
 *
 * Ohne sie hoert eine Liga einfach auf - der Kurs bleibt stehen, die Rangliste
 * friert ein, fertig. Das ist der Unterschied zwischen einem Werkzeug und
 * einem Spiel: Ein Spiel wertet aus.
 *
 * Die Auszeichnungen sind dabei wichtiger als das Podest. Wer gewonnen hat,
 * weiss man schon; dass jemand vierzig Sekunden vor dem Hoechststand verkauft
 * hat, weiss nur der Server. Genau solche Zeilen schickt man danach in die
 * Gruppe.
 *
 * Alles hier wird aus Daten gerechnet, die ohnehin mitlaufen: den einzelnen
 * Trades und den Kapitalstaenden. Nichts davon muss waehrend des Spiels
 * zusaetzlich erfasst werden.
 */

export interface Auszeichnung {
  key: string;
  title: string;
  /** Wer sie bekommen hat. */
  name: string;
  /** Die Zahl dahinter, schon fertig formuliert. */
  detail: string;
}

export interface Platz {
  userId: string;
  name: string;
  equityCents: string;
  startCents: string;
  returnBps: number;
  trades: number;
  feesCents: string;
  eliminatedAt: number | null;
}

export interface Kurve {
  name: string;
  /** [Zeitstempel, Kapital in Cent] - schon ausgeduennt. */
  punkte: Array<[number, number]>;
}

interface Konto {
  accountId: string;
  userId: string;
  name: string;
  equity: bigint;
  start: bigint;
  peak: bigint;
  trough: bigint;
  trades: number;
  fees: bigint;
  eliminatedAt: number | null;
}

interface TradeZeile {
  account_id: string;
  instrument_id: string;
  side: string;
  qty: string;
  price: string;
  fee: string;
  realized: string;
  executed_at: number;
  display: string;
}

const fmtUsd = (cents: bigint): string => {
  const negativ = cents < 0n;
  const ganz = (negativ ? -cents : cents) / 100n;
  const rest = ((negativ ? -cents : cents) % 100n).toString().padStart(2, '0');
  return `${negativ ? '-' : ''}${ganz.toLocaleString('de-DE')},${rest} $`;
};

const fmtDauer = (ms: number): string => {
  const minuten = Math.round(ms / 60_000);
  if (minuten < 60) return `${minuten} Minuten`;
  const stunden = Math.floor(minuten / 60);
  return `${stunden} Std. ${minuten % 60} Min.`;
};

export async function buildResults(
  db: Db,
  leagueId: string,
): Promise<{ podium: Platz[]; kurven: Kurve[]; auszeichnungen: Auszeichnung[] }> {
  const kontoZeilen = await db.all<{
    id: string;
    user_id: string;
    username: string;
    equity: string;
    start_cash: string;
    peak_equity: string;
    trough_equity: string;
    trades_count: number;
    fees_paid: string;
    eliminated_at: number | null;
  }>(
    `SELECT a.id, a.user_id, u.username, a.equity, a.start_cash, a.peak_equity,
            a.trough_equity, a.trades_count, a.fees_paid, m.eliminated_at
     FROM accounts a
     JOIN users u ON u.id = a.user_id
     LEFT JOIN league_members m ON m.league_id = a.league_id AND m.user_id = a.user_id
     WHERE a.league_id = ? AND a.is_bot = 0`,
    [leagueId],
  );

  const konten: Konto[] = kontoZeilen.map((row) => ({
    accountId: row.id,
    userId: row.user_id,
    name: row.username,
    equity: big(row.equity),
    start: big(row.start_cash),
    peak: big(row.peak_equity),
    trough: big(row.trough_equity),
    trades: int(row.trades_count),
    fees: big(row.fees_paid),
    eliminatedAt: row.eliminated_at === null ? null : int(row.eliminated_at),
  }));

  const podium: Platz[] = [...konten]
    .sort((a, b) => (b.equity > a.equity ? 1 : b.equity < a.equity ? -1 : 0))
    .map((konto) => ({
      userId: konto.userId,
      name: konto.name,
      equityCents: konto.equity.toString(),
      startCents: konto.start.toString(),
      returnBps:
        konto.start > 0n
          ? Number(((konto.equity - konto.start) * 10_000n) / konto.start)
          : 0,
      trades: konto.trades,
      feesCents: konto.fees.toString(),
      eliminatedAt: konto.eliminatedAt,
    }));

  const trades = await db.all<TradeZeile>(
    `SELECT t.account_id, t.instrument_id, t.side, t.qty, t.price, t.fee, t.realized,
            t.executed_at, i.display
     FROM trades t
     JOIN instruments i ON i.id = t.instrument_id
     WHERE t.league_id = ? AND t.source = 'human'
     ORDER BY t.executed_at ASC`,
    [leagueId],
  );

  return {
    podium,
    kurven: await buildKurven(db, konten),
    auszeichnungen: buildAuszeichnungen(konten, trades),
  };
}

/**
 * Kapitalverlaeufe aller Spieler, uebereinandergelegt.
 *
 * Ausgeduennt auf hoechstens 120 Punkte je Spieler: Eine Woche Liga ergibt
 * sonst Zehntausende Werte, die im Chart ohnehin uebereinanderliegen.
 */
async function buildKurven(db: Db, konten: Konto[]): Promise<Kurve[]> {
  const kurven: Kurve[] = [];

  for (const konto of konten) {
    const zeilen = await db.all<{ at: number; equity: string }>(
      'SELECT at, equity FROM equity_snapshots WHERE account_id = ? ORDER BY at ASC',
      [konto.accountId],
    );
    if (zeilen.length === 0) continue;

    const schritt = Math.max(1, Math.ceil(zeilen.length / 120));
    const punkte: Array<[number, number]> = [];

    for (let i = 0; i < zeilen.length; i += schritt) {
      punkte.push([int(zeilen[i]!.at), Number(big(zeilen[i]!.equity))]);
    }

    // Der letzte Stand gehoert immer dazu, sonst endet die Kurve irgendwo.
    const letzte = zeilen[zeilen.length - 1]!;
    const letzterPunkt: [number, number] = [int(letzte.at), Number(big(letzte.equity))];
    if (punkte[punkte.length - 1]?.[0] !== letzterPunkt[0]) punkte.push(letzterPunkt);

    kurven.push({ name: konto.name, punkte });
  }

  return kurven;
}

/** Wie lange eine Position gehalten wurde, und was sie am Ende brachte. */
interface Haltezeit {
  accountId: string;
  display: string;
  von: number;
  bis: number;
  realized: bigint;
}

function buildAuszeichnungen(konten: Konto[], trades: TradeZeile[]): Auszeichnung[] {
  const nameVon = new Map(konten.map((konto) => [konto.accountId, konto.name]));
  const auszeichnungen: Auszeichnung[] = [];

  /*
   * Hoechstens zwei Auszeichnungen je Person.
   *
   * Ohne die Grenze raeumt der Rundensieger regelmaessig alles ab - er hat ja
   * meist auch den besten Trade gemacht und die groesste Achterbahn hinter
   * sich. Eine Ehrentafel, auf der dreimal derselbe Name steht, liest sich wie
   * ein Fehler und nimmt allen anderen ihren Moment.
   */
  const vergeben = new Map<string, number>();
  const MAX_JE_PERSON = 2;

  const nimm = (
    key: string,
    title: string,
    accountId: string | undefined,
    detail: string,
  ): void => {
    const name = accountId ? nameVon.get(accountId) : undefined;
    if (!name) return;
    if ((vergeben.get(name) ?? 0) >= MAX_JE_PERSON) return;

    vergeben.set(name, (vergeben.get(name) ?? 0) + 1);
    auszeichnungen.push({ key, title, name, detail });
  };

  // --- Einzelne Trades -------------------------------------------------

  let bester: TradeZeile | null = null;
  let schlimmster: TradeZeile | null = null;

  for (const trade of trades) {
    const realized = big(trade.realized);
    if (realized === 0n) continue;
    if (!bester || realized > big(bester.realized)) bester = trade;
    if (!schlimmster || realized < big(schlimmster.realized)) schlimmster = trade;
  }

  if (bester && big(bester.realized) > 0n) {
    nimm(
      'bester_griff',
      'Bester Griff',
      bester.account_id,
      `${fmtUsd(big(bester.realized))} mit einem einzigen Trade in ${bester.display}`,
    );
  }

  if (schlimmster && big(schlimmster.realized) < 0n) {
    nimm(
      'griff_ins_klo',
      'Griff ins Klo',
      schlimmster.account_id,
      `${fmtUsd(big(schlimmster.realized))} in ${schlimmster.display} versenkt`,
    );
  }

  // --- Haltezeiten -----------------------------------------------------

  /*
   * Gehalten heisst: vom ersten Kauf bis zu dem Verkauf, der die Position
   * wieder auf null bringt. Die Menge wird dafuer mitgezaehlt - ohne das
   * waere jeder Teilverkauf ein Ende, und "Diamanthand" bekaeme der, der am
   * schnellsten die Haelfte abstoesst.
   */
  const offen = new Map<string, { qty: bigint; von: number }>();
  const haltezeiten: Haltezeit[] = [];
  const erloese = new Map<string, bigint>();

  for (const trade of trades) {
    const schluessel = `${trade.account_id}:${trade.instrument_id}`;
    const menge = big(trade.qty);
    const stand = offen.get(schluessel);

    if (trade.side === 'buy') {
      offen.set(schluessel, {
        qty: (stand?.qty ?? 0n) + menge,
        von: stand?.von ?? int(trade.executed_at),
      });
      continue;
    }

    erloese.set(schluessel, (erloese.get(schluessel) ?? 0n) + big(trade.realized));
    if (!stand) continue;

    const rest = stand.qty - menge;
    if (rest > 0n) {
      offen.set(schluessel, { qty: rest, von: stand.von });
      continue;
    }

    haltezeiten.push({
      accountId: trade.account_id,
      display: trade.display,
      von: stand.von,
      bis: int(trade.executed_at),
      realized: erloese.get(schluessel) ?? 0n,
    });
    offen.delete(schluessel);
    erloese.delete(schluessel);
  }

  const gewinner = haltezeiten
    .filter((eintrag) => eintrag.realized > 0n)
    .sort((a, b) => b.bis - b.von - (a.bis - a.von))[0];

  if (gewinner) {
    nimm(
      'diamanthand',
      'Diamanthand',
      gewinner.accountId,
      `${fmtDauer(gewinner.bis - gewinner.von)} in ${gewinner.display} durchgehalten, am Ende ${fmtUsd(gewinner.realized)}`,
    );
  }

  const hektisch = haltezeiten
    .filter((eintrag) => eintrag.bis - eintrag.von < 90_000 && eintrag.realized < 0n)
    .sort((a, b) => Number(a.realized - b.realized))[0];

  if (hektisch) {
    nimm(
      'papierhand',
      'Papierhand',
      hektisch.accountId,
      `nach ${Math.max(1, Math.round((hektisch.bis - hektisch.von) / 1000))} Sekunden wieder raus aus ${hektisch.display} - ${fmtUsd(hektisch.realized)}`,
    );
  }

  // --- Ueber die ganze Runde -------------------------------------------

  const vielflieger = [...konten].sort((a, b) => b.trades - a.trades)[0];
  if (vielflieger && vielflieger.trades >= 5) {
    nimm(
      'vielflieger',
      'Vielflieger',
      vielflieger.accountId,
      `${vielflieger.trades} Trades, ${fmtUsd(vielflieger.fees)} allein an Gebuehren`,
    );
  }

  const achterbahn = [...konten].sort((a, b) =>
    Number(b.peak - b.trough - (a.peak - a.trough)),
  )[0];
  if (achterbahn && achterbahn.peak - achterbahn.trough > 0n) {
    nimm(
      'achterbahn',
      'Achterbahn',
      achterbahn.accountId,
      `zwischen ${fmtUsd(achterbahn.trough)} und ${fmtUsd(achterbahn.peak)} unterwegs gewesen`,
    );
  }

  const comeback = [...konten]
    .filter((konto) => konto.equity > konto.trough)
    .sort((a, b) => Number(b.equity - b.trough - (a.equity - a.trough)))[0];
  if (comeback && comeback.equity - comeback.trough > comeback.start / 10n) {
    nimm(
      'comeback',
      'Comeback',
      comeback.accountId,
      `vom Tief bei ${fmtUsd(comeback.trough)} wieder hoch auf ${fmtUsd(comeback.equity)}`,
    );
  }

  const ruhig = [...konten]
    .filter((konto) => konto.equity > konto.start && konto.trades > 0)
    .sort((a, b) => a.trades - b.trades)[0];
  if (ruhig && ruhig.trades <= 3) {
    nimm(
      'eisern',
      'Eisern',
      ruhig.accountId,
      `${ruhig.trades} Trades in der ganzen Runde - und trotzdem im Plus`,
    );
  }

  // Wer sonst leer ausgeht, bekommt wenigstens eine ehrliche Zeile. Eine
  // Ehrentafel, auf der die Haelfte der Runde gar nicht vorkommt, ist keine.
  for (const konto of konten) {
    if (vergeben.has(konto.name) || konto.trades === 0) continue;
    const bps =
      konto.start > 0n ? Number(((konto.equity - konto.start) * 10_000n) / konto.start) : 0;

    nimm(
      'dabeigewesen',
      bps >= 0 ? 'Solide' : 'Lehrgeld',
      konto.accountId,
      bps >= 0
        ? `${konto.trades} Trades, am Ende ${fmtUsd(konto.equity - konto.start)} mehr`
        : `${konto.trades} Trades, am Ende ${fmtUsd(konto.equity - konto.start)}`,
    );
  }

  return auszeichnungen;
}
