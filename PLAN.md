# TradeArena — Plan

> **Stand: umgesetzt.** Alle Phasen sind gebaut, die App läuft.
> Eine Architektur-Entscheidung hat sich während der Umsetzung geändert:
> statt Vercel + Supabase + separatem Worker läuft jetzt **ein einziger
> Node-Dienst**. Warum, steht in Abschnitt 1. Der Rest des Plans gilt
> unverändert. Zum Loslegen: [README.md](README.md), zum Online-Stellen:
> [DEPLOY.md](DEPLOY.md).

Multiplayer Trading-Simulator mit echten Marktdaten und Spielgeld.
Zwei Ziele gleichzeitig: **echte Broker-Mechanik** (Ordertypen, Spread, Slippage, Gebühren, Margin)
und **Wettkampf mit Freunden** (Ligen, Rangliste, Feed, Chat, Achievements).

Kein echtes Geld, keine Einzahlungen, keine Auszahlungen. Reines Lern- und Wettkampfspiel.

---

## 0. Entscheidungen aus den Rückfragen

| Thema | Entscheidung |
|---|---|
| Name / Ordner | TradeArena, `C:\Users\User\Desktop\TradeArena` |
| Hosting | Komplett kostenlos, aber öffentlich erreichbar (Details unten) |
| Märkte Phase 1 | Nur Krypto über Binance (kein API-Key nötig, 24/7, echtes Bid/Ask) |
| Aktien | Phase 2, mit kostenlosem Finnhub- oder Alpaca-Paper-Key von dir |
| Sprache | UI Deutsch, Trading-Begriffe englisch (Limit, Stop, Long, Short, PnL, Fill) |

---

## 1. Hosting: ein Dienst statt drei

Das Problem: ein Trading-Simulator braucht einen **dauerhaft laufenden Prozess** (WebSocket zur Börse,
Prüfung offener Limit-/Stop-Orders, Liquidationen, Bots). Serverlose Plattformen wie Vercel können das
nicht — dort lebt eine Funktion nur Sekunden.

Der ursprüngliche Plan war deshalb: Next.js auf Vercel + Supabase + ein Worker auf Render. Beim Bauen
hat sich gezeigt, dass das **drei Anmeldungen und drei Konfigurationen** bedeutet — und die Web-App
ohnehin nichts tut, was der Worker nicht auch könnte. Also:

**Ein einziger Node-Prozess macht alles:** HTTP-API, WebSocket-Verteilung, Binance-Feed,
Engine-Schleife und das Ausliefern des gebauten Frontends.

| Ursprünglich geplant | Umgesetzt |
|---|---|
| Vercel (Web) + Supabase (DB/Auth) + Render (Worker) | ein Dienst, z. B. Render |
| drei Konten, drei Konfigurationen | ein Konto |
| CORS, Umgebungsvariablen an drei Stellen | eine URL, keine CORS-Fragen |
| Supabase-Auth mit Magic Link | Benutzername + Passwort (scrypt), kein Mailversand nötig |
| Supabase-Postgres | beliebige Postgres über `DATABASE_URL` — oder lokal SQLite ohne alles |

Der spürbarste Gewinn: `npm install && npm run dev` startet die komplette App **ohne einen einzigen
Account und ohne API-Key**. SQLite ist in Node eingebaut, Binance braucht keinen Schlüssel.

Kosten im Betrieb: **0 €** auf Render (Webdienst + Postgres im Gratis-Tarif). Die zwei ehrlichen Haken
— Einschlafen nach 15 Minuten (dagegen ein kostenloser Cron-Ping) und eine Gratis-Datenbank mit
30 Tagen Laufzeit — stehen mitsamt Gegenmitteln in [DEPLOY.md](DEPLOY.md).

Weil der Server ein normaler Node-Prozess mit Dockerfile ist, ist ein Umzug zu Koyeb, Fly.io, Railway
oder auf einen eigenen Server eine Frage der Konfiguration, nicht des Codes.

---

## 2. Architektur

```
 Binance WebSocket (bookTicker) + REST (historische Kerzen), kein Key noetig
              |
              v
 +---------------------------------------------------------------+
 |  EIN NODE-PROZESS                                              |
 |                                                                |
 |  market.ts    einzige Verbindung zur Boerse, Kurse gecacht;    |
 |               faellt sie aus, springt ein Simulator ein        |
 |  engine.ts    Takt 250 ms: Limit/Stop/Trailing/OCO pruefen,    |
 |               Leihgebuehren, Margin Call, Liquidation, Bots,   |
 |               Wetten, Ligaende, Equity-Snapshots               |
 |  trading.ts   Ausfuehrung und Buchhaltung - die einzige        |
 |               Stelle, an der Geld den Besitzer wechselt        |
 |  replay.ts    Zeitmaschine: gleiche Engine, andere Uhr         |
 |  hub.ts       WebSocket-Verteiler an alle Browser              |
 |  routes/      HTTP-API                                         |
 |  + liefert das gebaute Frontend aus                            |
 +--------------------------+-------------------------------------+
              |                              |
              v                              v
    +--------------------+          Browser (du + Freunde)
    |  SQLite (lokal)    |          React-Terminal, WebSocket
    |  Postgres (Netz)   |
    +--------------------+
```

**Die wichtigste Regel: der Client führt nichts aus.**
Der Browser schickt nur *Absichten* („Market Buy für 1000 $"). Er schickt **nie einen Preis mit**.
Preis, Gebühren, Slippage und Kaufkraft entstehen ausschließlich im Server mit dessen eigenen
Live-Kursen. Damit kann sich niemand Millionen erfinden, auch nicht mit offener DevTools-Konsole.

**Ein Schloss um alle Schreibvorgänge.** Wer zwanzigmal auf „Kaufen" hämmert, bekommt zwanzig sauber
nacheinander geprüfte Orders — und keine doppelte Buchung. Zusammen mit Datenbank-Transaktionen ist
das die Absicherung gegen Race Conditions.

**Zwei Datenbanken, eine SQL-Syntax.** Ein dünner Adapter schreibt `?` in `$1, $2, …` um, sonst ist
das SQL identisch. Alle Geldbeträge stehen als **TEXT** in der Datenbank und werden als `bigint`
gelesen — JSON-Zahlen verlieren oberhalb von 2^53 an Genauigkeit, und eine Coin-Menge wie
1.000.000.000,00000000 liegt darüber.

### Repo-Struktur (npm workspaces)

```
TradeArena/
  packages/core/     DIE Engine: Money, Matching, Fees, Slippage, Margin,
                     PnL, AMM, Bots, Achievements, Statistik.
                     Reines TypeScript, keine Datenbank, kein Netzwerk,
                     kein Zufall -> genau deshalb vollstaendig testbar.
  apps/server/       Node-Server (Fastify + ws + pg/node:sqlite)
  apps/web/          React + Vite + Tailwind + Lightweight Charts
  Dockerfile         laeuft ueberall, wo Docker laeuft
  render.yaml        Ein-Klick-Deployment auf Render
```

`packages/core` wird von Server **und** Web benutzt. Eine Formel existiert genau einmal.

---

## 3. Geld-Arithmetik (niemals Floats)

`0.1 + 0.2 !== 0.3` — in einer Trading-Engine ist das kein Schönheitsfehler, sondern ein Bug-Generator.

| Größe | Typ im Code | Typ in der Datenbank | Skala |
|---|---|---|---|
| Cash, PnL, Gebühren, Equity | `bigint` | `TEXT` | Cent (1 = 0,01 $) |
| Preis | `bigint` | `TEXT` | 1e-8 $ |
| Menge (Stück/Coins) | `bigint` | `TEXT` | 1e-8 Einheiten |

Warum TEXT und nicht `numeric`? Weil der Weg aus der Datenbank durch JSON führt, und JSON-Zahlen
oberhalb von 2^53 an Genauigkeit verlieren. Eine Coin-Menge von 1.000.000.000,00000000 liegt darüber.
Als Zeichenkette gespeichert und mit `BigInt()` gelesen, stimmt jeder Cent — auf beiden Treibern.

Ein Modul `packages/core/money.ts` kapselt das komplett: `mul`, `div`, `toCents`, `fromCents`,
Rundung immer explizit und immer **zu Lasten des Spielers** (wie bei echten Brokern: Gebühren
aufrunden, Erlöse abrunden). In den Geldpfaden kommt kein einziger `number` vor; abgesichert ist das
durch die Typen (`Cents`, `Price`, `Qty` sind alle `bigint`) und durch die Tests in
`money.test.ts`, die auch die unangenehmen Fälle prüfen — negative Beträge, exakte Hälften,
Rundungsrichtung.

---

## 4. Datenmodell (SQLite / Postgres)

```
profiles           id, username, avatar, rank_title, xp, created_at
seasons            id, name, starts_at, ends_at

leagues            id, name, owner_id, invite_code, status(draft|running|finished),
                   mode(classic|timemachine|blitz|survival),
                   starting_cash_cents, starts_at, ends_at,
                   markets(crypto[]|stocks[]), leverage_max, fee_bps, fee_fixed_cents,
                   short_borrow_bps_daily, slippage_factor,
                   feed_visibility(instant|delayed_15m|end_only),
                   portfolio_visibility(open|delayed|hidden),
                   survival_drawdown_pct, scenario_id
league_members     league_id, user_id, joined_at, role(owner|member), eliminated_at

accounts           id, league_id, user_id,           -- ein Konto pro Spieler pro Liga
                   cash_cents, equity_cents, margin_used_cents,
                   realized_pnl_cents, high_water_equity_cents, updated_at

instruments        id, symbol(BTCUSDT), display(BTC/USD), asset_class(crypto|stock),
                   venue, qty_step, price_step, min_notional, active

positions          id, account_id, instrument_id, side(long|short),
                   qty, avg_entry_price, realized_pnl_cents,
                   opened_at, closed_at, borrow_accrued_cents

orders             id, account_id, instrument_id, side(buy|sell),
                   type(market|limit|stop|stop_limit|trailing_stop),
                   qty, limit_price, stop_price, trail_offset, trail_high_water,
                   tif(day|gtc), status(pending|working|partially_filled|filled|
                                        cancelled|rejected|expired),
                   reduce_only, parent_order_id, oco_group_id,
                   filled_qty, avg_fill_price, reject_reason,
                   created_at, activated_at, closed_at
order_events       id, order_id, at, kind, payload   -- lueckenloses Audit-Log

trades             id, account_id, order_id, instrument_id, side, qty, price,
                   fee_cents, slippage_cents, realized_pnl_cents, executed_at
cash_ledger        id, account_id, at, kind(deposit|trade|fee|borrow|dividend|liquidation),
                   amount_cents, balance_after_cents, ref_id
                   -- doppelte Buchfuehrung: die Summe MUSS immer den Cash-Stand ergeben,
                   --  ein Test prueft genau das nach jedem Szenario

equity_snapshots   account_id, at, equity_cents, cash_cents, exposure_cents  -- Equity-Kurve
candles            instrument_id, tf(1m|5m|1h|1d), open_time, o,h,l,c,v
last_ticks         instrument_id, bid, ask, last, at

feed_events        id, league_id, account_id, kind(trade|liquidation|rank_change|
                                                   achievement|bet), payload, visible_at
chat_messages      id, league_id, user_id, body, reply_to, created_at
reactions          id, target_type(feed|chat), target_id, user_id, emoji

achievements       key, name, description, icon, tier, hidden
achievement_unlock user_id, league_id, achievement_key, unlocked_at, context

bets               id, league_id, author_id, text, instrument_id, comparator(above|below),
                   target_price, resolve_at, stake_cents, status, outcome
bet_stakes         bet_id, user_id, side(for|against), amount_cents

scenarios          id, name, description, instrument_ids, from_ts, to_ts,
                   speed_factor, reveal_after   -- Zeitmaschine
scenario_runs      id, league_id, scenario_id, virtual_now, started_at, state

-- Launchpad / eigene Coins
coins              id, league_id, creator_id, instrument_id, name, ticker, emoji, color,
                   total_supply, launched_at, lp_lock_until, status(live|rugged|dead),
                   rugged_at, rugged_amount_cents
amm_pools          coin_id, reserve_usd_cents, reserve_tokens, k, fee_bps,
                   lp_total, updated_at
lp_shares          coin_id, account_id, shares          -- wer wie viel Liquiditaet haelt
coin_holders       coin_id, account_id, qty, avg_entry   -- fuer "4 Bagholder" im Feed

-- KI-Trader
bots               id, account_id, name, avatar, strategy, params, budget_cents,
                   level, xp, error_rate_bps, status(idle|running|stopped|blown_up),
                   created_at
bot_decisions      id, bot_id, at, kind(signal|mistake), mistake_type, reasoning,
                   order_id      -- macht jede Bot-Aktion im Nachhinein erklaerbar

-- Tycoon
prestige_accounts  user_id, points, lifetime_points, tier
upgrades           key, branch, level, cost_points, effect_json
user_upgrades      user_id, upgrade_key, level, unlocked_at
```

**Row Level Security, kurz gefasst:**
- `SELECT` auf Liga-Daten nur, wenn du in `league_members` dieser Liga stehst.
- Dein eigenes Depot: immer sichtbar. Fremde Depots: nur über eine View, die die
  `portfolio_visibility`-Einstellung der Liga durchsetzt (offen / 15 min verzögert / erst am Ende).
- `INSERT/UPDATE/DELETE` auf `orders` nur für das eigene Konto und nur solange die Liga läuft.
- `accounts`, `trades`, `positions`, `cash_ledger`: für Clients **read-only**. Schreiben darf nur
  der Worker mit dem Service-Role-Key. Der Key liegt ausschließlich auf Render, nie im Browser.

---

## 5. Die Engine im Detail

### Ausführung
- **Market Buy → zum Ask. Market Sell → zum Bid.** Nie zum Mittelkurs. Binance `bookTicker` liefert
  beides live und echt, für Krypto muss also gar nichts simuliert werden.
- **Spread-Simulation** nur für Quellen ohne Bid/Ask (später Aktien): halber Spread je Asset-Klasse,
  aufgeweitet außerhalb der Haupthandelszeit.
- **Slippage**: `slippage = spread/2 + k * volFactor * sqrt(notional / refDepth)`
  — große Order in ruhigem Markt: kaum spürbar. Große Order in einem Crash: tut weh.
  `volFactor` = ATR der letzten 20 1m-Candles, `k` pro Liga einstellbar.
- **Gebühren**: `fee_bps` (%) + `fee_fixed_cents`, Maker (ruhende Limit-Order wird getroffen) günstiger
  als Taker. Immer aufgerundet.
- **Partial Fills**: Limit-Orders füllen anteilig, wenn das simulierte Volumen nicht reicht.

### Kurslücken und Handelszeiten (ab Phase 2, für Aktien)
- Aktien nur zu NYSE-Zeiten inkl. Feiertagskalender; Orders davor/danach werden **vorgemerkt**
  und beim Open ausgeführt.
- **Gap-Regel**: Eröffnet die Aktie unter deinem Stop, füllt der Stop zum **Eröffnungskurs** —
  nicht zum Stop-Preis. Genau das kostet in echt Geld und gehört ins Spiel.
- Splits werden auf Positionen und Historie angewendet, Dividenden als Cash-Buchung.

### Positionen und Risiko
- Long und Short. Shorts kosten täglich Leihgebühr (`short_borrow_bps_daily`, stündlich anteilig
  gebucht).
- Optionaler Hebel pro Liga: Initial Margin + Maintenance Margin.
  Fällt die Equity unter Maintenance → **Margin Call** (Warnung im UI + Feed),
  fällt sie unter das Liquidations-Level → **Zwangsliquidation** der größten Position zuerst.
  Der Worker prüft das bei **jedem Tick**, nicht nur bei Aktivität.
- Kaufkraft-Prüfung vor jedem Fill: keine negativen Bestände, keine Order über die Kaufkraft hinaus.

### Statistik
Realisierter + unrealisierter PnL, Rendite, **Max Drawdown**, Win-Rate, Profit Factor,
**Sharpe Ratio** (aus den Equity-Snapshots), bester/schlechtester Trade, durchschnittliche Haltedauer,
Equity-Kurve als Chart, vollständige Trade-Historie mit Filter und CSV-Export.

### Tests (Vitest, `packages/core`)
Das hier ist der Teil, der wirklich stimmen muss:
- Fee-Rundung, Spread-Anwendung, Slippage-Formel
- Jeder Ordertyp einzeln: Trigger-Bedingung, Fill-Preis, TIF-Ablauf, OCO (eine füllt → andere storniert)
- Trailing Stop mit steigendem und fallendem Markt
- Margin: Call-Schwelle, Liquidations-Reihenfolge, Konto darf nie unter null
- PnL-Kette: Long → Teilverkauf → Nachkauf → Short-Flip, mit exaktem Durchschnittseinstand
- Gap-Open-Regel für Stop-Orders
- **Ledger-Invariante**: nach jedem Testszenario muss `SUM(cash_ledger) == accounts.cash_cents` sein
- Goldene Szenarien: kompletter Handelstag als Fixture, erwartetes Endergebnis eingefroren

---

## 6. Spielmodi

| Modus | Beschreibung |
|---|---|
| **Klassisch** | Live-Markt, feste Laufzeit (1 Tag / 1 Woche / 1 Monat / Saison), höchste Equity gewinnt |
| **Zeitmaschine** | Echte historische Kurse im Zeitraffer, z. B. ein Handelstag in 10 Minuten. Gleiche Engine, nur eine andere `Clock`. Der Zeitraum bleibt bis zum Ende **geheim** (Symbole heißen "ASSET A", Achsen ohne Datum), damit niemand nachschlägt. Fertige Szenarien: COVID-Crash März 2020, FTX-Kollaps, Bull Run 2021 |
| **Blitzrunde** | 15 Minuten, nur Krypto, hoher Hebel, Liquidationen erwünscht |
| **Survival** | Wer unter X % Drawdown fällt, fliegt raus. Live-Ausscheiden mit Feed-Eintrag |

Die Zeitmaschine ist der Grund, warum Krypto-zuerst gut passt: Binance liefert die komplette
Minuten-Historie kostenlos per REST. Kein Datenanbieter, kein Key, keine Limits, die uns stören.

---

## 7. Launchpad: eigene Coins und Rugpulls

Jeder Spieler kann in seiner Liga eigene Coins starten. Die laufen **nicht** über Binance, sondern
über einen internen Markt — deshalb funktioniert das mit demselben Order-Code, nur mit einer anderen
Preisquelle.

### Wie der Preis entsteht: Bonding Curve (AMM)

Ein neuer Coin bekommt einen Pool nach der Formel eines Constant-Product-AMM (`x * y = k`),
genau wie Uniswap oder pump.fun:

```
Pool:  reserve_usd_cents  x  reserve_tokens
k = reserve_usd * reserve_tokens  (bleibt beim Handel konstant)
Preis = reserve_usd / reserve_tokens

Kauf für 1.000 $:   reserve_usd steigt -> Preis steigt -> du bekommst weniger Token je Dollar
Verkauf:            umgekehrt
```

Das hat drei schöne Nebenwirkungen, ohne dass ich irgendwas faken muss:
- **Slippage entsteht von selbst.** Ein Wal, der 50 % des Pools kauft, zahlt brutal drauf.
- **Kleine Pools sind irre volatil**, große sind träge. Genau wie in echt.
- **Jeder Trade ist nachrechenbar** — keine Zufallszahlen, kein „der Server hat entschieden".

### Coin starten

| Feld | Beschreibung |
|---|---|
| Name + Ticker | z. B. `$MOONBOY`, frei wählbar, Emoji und Farbe dazu |
| Supply | Gesamtmenge, z. B. 1.000.000.000 |
| Startliquidität | Der Ersteller schießt eigenes Spielgeld in den Pool (Minimum pro Liga einstellbar) |
| Listing-Fee | Kostet Spielgeld, verschwindet aus der Liga → verhindert Coin-Spam |
| LP-Lock | **Der entscheidende Schalter**: 0 min (sofort rugbar), 15 min, 1 h, oder gar nicht abziehbar |

Die Pool-Daten sind für **alle sichtbar**: wie groß die Liquidität ist, wie viel Prozent der Ersteller
hält, ob der LP gelockt ist und wie lange noch. Wer einen Coin mit 0-Minuten-Lock und 90 % Creator-Anteil
kauft, ist selber schuld — und lernt in fünf Minuten, worauf man bei echten Memecoins schaut.

### Der Rugpull

Der Ersteller kann seinen LP-Anteil abziehen, sobald der Lock abgelaufen ist. Dann kollabiert der
Kurs, weil dem Pool die Reserve fehlt. Der Feed macht daraus ein Ereignis:

> 💀 **Max hat $MOONBOY gerugged.** 12.400 $ abgezogen, Kurs −94 %, 4 Bagholder.

Das Geld ist dabei **nicht aus dem Nichts** — es ist exakt das Geld, das die Käufer in den Pool
gesteckt haben. Innerhalb der Liga ist ein Rugpull ein reines Nullsummenspiel, buchhalterisch
sauber im Ledger nachvollziehbar. Niemand kann sich damit Geld erzeugen, nur umverteilen.

Bremsen gegen Dauer-Missbrauch:
- Liga-Einstellung `rugpull_mode`: **an** / **nur mit Lock ≥ 15 min** / **aus** (LP nie abziehbar)
- Max. 2 aktive Coins pro Spieler, Cooldown nach einem Rug
- Ein Spieler, der ruggt, bekommt öffentlich das Abzeichen **„Rugger"** an sein Profil geheftet —
  dauerhaft, sichtbar für alle. Vertrauen ist die eigentliche Währung.
- Achievements auf beiden Seiten: `Rugger`, `Bagholder`, `Exit Liquidity`, `Ausgestiegen bei ATH`

### Technisch

Coins sind normale `instruments` mit `price_source = 'amm'`. Market- und Limit-Orders laufen durch
dieselbe Engine; nur der Fill-Preis kommt aus `packages/core/amm.ts` statt vom Binance-Feed. Der
AMM-Code ist reine Mathematik ohne IO und wird genauso hart getestet wie der Rest (Invariante: `k`
darf sich durch keinen Trade verkleinern, Gebühren gehen an den Pool).

---

## 8. Der KI-Trader (erspielbar, und er baut Mist)

Kein „Cheat-Knopf", sondern ein Mitarbeiter, den man sich verdient und dann trainieren muss.

### Freischalten
Der erste Bot-Slot wird durch Spielen freigeschaltet (z. B. 50 abgeschlossene Trades oder ein
bestimmtes Achievement). Weitere Slots und Strategien kosten **Prestige-Punkte** aus der
Tycoon-Ebene, nicht Spielgeld.

### Wie er arbeitet
Du gibst ihm ein **Budget** (z. B. 20 % deines Kapitals) als Unterkonto, eine **Strategie** und ein
**Risikoprofil**. Danach handelt er selbstständig im Worker weiter — auch wenn du schläfst.
Er bekommt **keinerlei Sonderrechte**: gleiche Gebühren, gleicher Spread, gleiche Slippage,
gleiche Ordertypen wie du. Er sieht auch keine Zukunft, nur dieselben Kursdaten.

Strategien (nacheinander freischaltbar):

| Strategie | Verhalten | Stärke / Schwäche |
|---|---|---|
| **DCA** | Kauft stur alle X Minuten für einen festen Betrag | Langweilig-solide, verliert im Abwärtstrend |
| **Mean Reversion** | Kauft Rücksetzer, verkauft Übertreibungen (RSI + Bänder) | Stark im Seitwärtsmarkt, wird im Trend zerlegt |
| **Momentum** | Springt auf Ausbrüche auf | Fängt große Bewegungen, frisst Fehlausbrüche |
| **Grid** | Legt ein Netz aus Limit-Orders um den Kurs | Melkt Volatilität, bricht bei Trends aus dem Netz |
| **Scalper** | Viele Mini-Trades | Gebühren fressen ihn, wenn die Liga hohe Fees hat |

### Er macht absichtlich Fehler

Das ist das Kernstück, sonst wäre es langweilig oder überlegen. Jeder Bot hat eine **Fehlerquote**,
die mit seinem Level sinkt (Start: ~18 %, voll trainiert: ~4 %, nie 0):

- **FOMO-Kauf**: kauft nach einer Kerze mit +5 % nach, obwohl die Strategie es nicht sagt
- **Panik-Verkauf**: wirft eine Position beim ersten roten Docht raus
- **Stop vergessen**: setzt den Stop-Loss nicht — und dann tut es weh
- **Fat Finger**: Ordergröße um den Faktor 10 daneben (gedeckelt aufs Budget)
- **Overtrading**: handelt eine Stunde lang viel zu viel und verbrennt Gebühren
- **Sturheit**: hält gegen einen klaren Trend, weil „das muss doch drehen"

Jeder Fehler landet sichtbar im Feed — das ist der halbe Spaß:

> 🤖 **BENDER (Bot von Max)** hat FOMO-gekauft: 0,8 BTC bei 71.240 $, direkt nach +5 %. Viel Erfolg.

### Training
Der Bot sammelt XP aus seinen eigenen Trades (mehr für gute, weniger für schlechte). Level rauf =
Fehlerquote runter, größeres Budgetlimit, schnellere Reaktionszeit. Ein Bot, der sich selbst
liquidiert, verliert ein Level. Man kann ihn benennen, ihm ein Avatar geben und ihn in der Liga
gegen die Bots der anderen antreten lassen — inklusive eigener **Bot-Rangliste**.

Liga-Einstellung `bots_allowed`: an / aus / nur in bestimmten Modi (in der Blitzrunde z. B. aus,
sonst gewinnt am Ende der mit dem besten Skript und nicht der beste Trader).

---

## 9. Tycoon-Ebene: dein Trading-Desk

Über allen Ligen hinweg baust du deinen eigenen Handelsplatz aus. Die Währung dafür ist
**Prestige** — verdient durch Volumen, Ligen-Platzierungen, Achievements und Saison-Ergebnisse.
Prestige ist **nicht** in Spielgeld umwandelbar, in keine Richtung.

Ausbaustufen:

| Zweig | Stufen |
|---|---|
| **Broker-Tier** | Retail → Pro → Prime: geringere Gebühren, engere Spreads, höhere Orderlimits |
| **Research-Abteilung** | Mehr Indikatoren, Volatilitäts-Warnungen, Earnings-Kalender, Level-2-Orderbuch |
| **Bot-Abteilung** | Bot-Slots, neue Strategien, schnellere Trainingskurve |
| **Launchpad-Lizenz** | Eigene Coins starten, später LP-Lock-Tools und ein „Verified"-Badge |
| **Treasury** | Zinsen auf ungenutztes Cash, höhere Kreditlinie |
| **Büro & Kosmetik** | Terminal-Themes, Sounds, Profilrahmen, Titel, Trophäenschrank |

### Die Fairness-Frage — hier musst du nichts entscheiden, aber es sollte dir klar sein

Ein Tycoon-Baum und ein fairer Wettkampf beißen sich: wer schon 200 Stunden gespielt hat, hätte
sonst dauerhaft niedrigere Gebühren als der Neuling. Deshalb hat jede Liga den Schalter
`upgrades_allowed`:

- **Wettkampf-Liga (Default: aus)** — alle spielen mit identischen Konditionen. Nur Kosmetik,
  Titel und Trophäen sind sichtbar. Wer gewinnt, hat wirklich besser getradet.
- **Tycoon-Liga (Default: an)** — Upgrades wirken voll, Fortschritt zählt, Langzeit-Spaß.

So kriegst du beides, ohne dass eins das andere kaputtmacht. Wenn du das anders willst, sag Bescheid
— es ist genau eine Zeile in den Liga-Einstellungen.

---

## 10. Social und Progression

- **Live-Feed**: "Max hat 500 NVDA gekauft 🚀" — Sichtbarkeit pro Liga: sofort / 15 min verzögert /
  erst am Ende. Die Verzögerung wird serverseitig über `visible_at` erzwungen, nicht im UI versteckt.
- **Liga-Chat** mit Emoji-Reaktionen direkt auf Trades im Feed.
- **Fremde Portfolios** ansehen, je nach Liga-Einstellung verzögert.
- **Callouts / Wetten**: "TSLA steht Freitag unter 200" — Freunde halten mit Spielgeld dagegen,
  der Worker wertet zum Stichzeitpunkt automatisch aus und bucht den Pot.
- **Achievements**: Diamond Hands (Position trotz −20 % gehalten und im Plus geschlossen),
  Paper Hands, Sniper (Limit exakt am Tagestief gefüllt), Liquidiert (Schande-Abzeichen),
  Round Trip, Comeback. Erkennung läuft im Worker, nicht im Client.
- **Ränge, Titel, Saisons**, Profilseite mit Trophäenschrank.
- **Wochen-Awards**: bester Trade, schlimmster Trade, mutigster Trade (größte Positionsgröße
  relativ zur Equity).

---

## 11. Design

Dunkles Terminal: fast schwarzer Hintergrund, Monospace für **alle** Zahlen (damit Ziffern beim
Aktualisieren nicht springen), klares Grün/Rot, ruhige Flächen — Bloomberg-Ernst mit Gaming-Kanten.

- Zahlen flackern kurz auf, wenn sich der Kurs ändert (grün rauf, rot runter)
- Konfetti + Sound bei großen Gewinnen, dramatischer Effekt bei Liquidation, Sounds abschaltbar
- Watchlist, simuliertes Orderbuch, TradingView Lightweight Charts mit 1m/5m/1h/1D
  und Indikatoren (SMA, EMA, RSI, Volumen)
- Orderticket mit Live-Vorschau: "geschätzter Fill 43.218,50 $, Gebühr 2,16 $, Slippage ~0,04 %"
- Tastenkürzel: `B` kaufen, `S` verkaufen, `Esc` abbrechen, `/` Symbolsuche
- Mobil voll nutzbar: Chart oben, Orderticket als Bottom-Sheet, Rangliste als Tab
- Onboarding-Tutorial mit Spielgeld in einer Sandbox-Liga, das die Ordertypen spielerisch erklärt
  ("Setz eine Limit-Order 2 % unter dem Kurs und schau, was passiert")

---

## 12. Phasen — Stand

| Phase | Inhalt | Stand |
|---|---|---|
| 1 | Grundgerüst: Login, Ligen, Krypto-Livekurse, Market Orders, Portfolio, Rangliste | ✅ fertig |
| 2 | Realismus: alle Ordertypen, OCO, Gebühren, Spread, Slippage, Short, Margin, Liquidation, Tests | ✅ fertig |
| 3 | Social: Feed mit Verzögerungslogik, Chat, Reaktionen, Profile, Trade-Historie, Statistik | ✅ fertig |
| 4 | Spielmodi (Klassisch, Blitz, Survival, Zeitmaschine) und das Launchpad mit Rugpulls | ✅ fertig |
| 5 | KI-Trader mit Strategien, Fehler-Engine, Level und Bot-Rangliste | ✅ fertig |
| 6 | Tycoon: Prestige, Upgrade-Baum, Ränge, Achievements, Wetten, Sounds, Animationen, Mobile, Tutorial | ✅ fertig |
| 7 | Deployment-Anleitung, Dockerfile, Render-Blueprint | ✅ fertig |

### Was bewusst offen geblieben ist

**US-Aktien.** Du hattest „Krypto zuerst" gewählt, und dabei ist es geblieben. Was dafür noch fehlt,
ist keine Kleinigkeit und braucht deinen kostenlosen Finnhub- oder Alpaca-Key:

- Adapter für die Aktien-Datenquelle (die Schnittstelle dafür steht bereits: `priceSource`)
- NYSE-Handelszeiten inklusive Feiertagskalender, Orders außerhalb werden vorgemerkt
- Kurslücken bei Eröffnung — die Regel dafür ist in der Engine schon implementiert und getestet
  (`gapOpenPrice`), sie wird nur noch nicht befüllt
- Aktiensplits und Dividenden

Die Engine ist darauf vorbereitet: Instrumente haben bereits eine Asset-Klasse und eine Preisquelle,
die Gap-Regel und der synthetische Spread für Quellen ohne Bid/Ask sind gebaut und getestet.

**Saisons** sind als Datenmodell angelegt, aber ohne eigene Oberfläche — Ränge und Prestige laufen
derzeit durchgehend statt in Staffeln.

---

## 13. Sicherheit

- Orders **ausschließlich** serverseitig ausgeführt, Preise ausschließlich serverseitig ermittelt.
  Der Client schickt nie einen Preis mit.
- Jede Eingabe durch Zod validiert, an der Route-Handler-Grenze und nochmal in der Engine.
- Postgres-Transaktionen mit `SELECT … FOR UPDATE` auf dem Konto → keine Doppel-Ausführung,
  auch wenn jemand den Kaufen-Button 20-mal drückt oder zwei Tabs offen hat.
- Row Level Security auf jeder Tabelle, Default-Deny.
- Service-Role-Key nur auf Render. `.env.example` mit allen Variablen und Kommentaren,
  echte `.env` steht in `.gitignore`.
- Rate-Limit auf die Order-Endpunkte pro Konto.
- Binance-Limits: **eine** WebSocket-Verbindung für alle Spieler, Kurse werden gecacht und
  gedrosselt verteilt. Egal ob 2 oder 50 Leute online sind, die Last zur Börse bleibt gleich.
- Das Audit-Log (`order_events` + `cash_ledger`) macht jeden Cent nachvollziehbar — falls sich
  jemand über sein Ergebnis beschwert, kann man es Zeile für Zeile nachlesen.

---

## 14. Was ich später von dir brauche

1. Ein Supabase-Konto (gratis) — ich sage dir genau, wo du klickst
2. Ein Vercel-Konto und ein Render-Konto (beide gratis, Login per GitHub)
3. Für Phase 2: einen kostenlosen Finnhub- oder Alpaca-Paper-Key
4. Entscheidung, ob die App öffentlich sein soll oder nur mit Einladungscode zugänglich
   (Vorschlag: nur mit Code — dann verirrt sich niemand Fremdes in eure Ligen)

---

## 15. Offene Punkte, die ich unterwegs entscheide

- Genaue Slippage-Konstanten: erst konservativ, dann anhand echter Trades nachjustieren
- Simuliertes Orderbuch: optisch aus Bid/Ask + Volatilität erzeugt, dient der Atmosphäre,
  beeinflusst die Ausführung aber nicht (sonst müsste ich echte Depth-Daten streamen)
- Sound-Assets: erst Platzhalter, Feinschliff in Phase 5

---

**Status: alle Phasen umgesetzt.** Wie du sie startest, steht in [README.md](README.md);
wie du sie online stellst, in [DEPLOY.md](DEPLOY.md).
