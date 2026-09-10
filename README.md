# TradeArena

Multiplayer-Trading-Simulator mit echten Marktdaten und Spielgeld.
Echte Kurse, echte Ordermechanik, echte Gebuehren - und Freunde, denen man
den Abend versauen kann.

**Kein echtes Geld. Keine Einzahlung. Keine Auszahlung. Nur ein Spiel.**

---

## In 30 Sekunden starten

```bash
npm install
npm run dev
```

Dann `http://localhost:5173` im Browser oeffnen, Konto anlegen, Liga
erstellen, fertig. Keine Datenbank installieren, keine API-Keys, kein Konto
bei irgendeinem Dienst. Die Kurse kommen live von Binance, die Daten landen
in einer SQLite-Datei neben dem Projekt.

Damit deine Freunde mitspielen koennen, muss die App im Netz erreichbar sein
- das steht Schritt fuer Schritt in **[DEPLOY.md](DEPLOY.md)**.

---

## Was drin ist

**Handel, wie er wirklich funktioniert**

- Market, Limit, Stop, Stop-Limit und Trailing Stop
- Gueltigkeit Day und GTC, Orders aendern und stornieren
- Stop-Loss und Take-Profit als OCO-Paar direkt an der Position
- Kauf zum Ask, Verkauf zum Bid - nie zum Mittelkurs
- Slippage nach Ordergroesse und Volatilitaet, Gebuehren pro Liga einstellbar
- Long und Short, Leihgebuehren fuer Shorts
- Hebel mit Margin Call und Zwangsliquidation
- Bei einer Kursluecke fuellt der Stop zum Eroeffnungskurs, nicht zum Stop-Preis
- Alle Betraege als Ganzzahlen in Cent - nirgendwo Fliesskomma

**Wettkampf**

- Ligen mit Einladungscode, Live-Rangliste, Feed, Chat, Emoji-Reaktionen
- Spielmodi: Klassisch, Blitzrunde, Survival, Zeitmaschine
- Wetten gegeneinander ("BTC steht Freitag unter 60.000")
- Achievements, Raenge, Prestige, Trophaeenschrank - inklusive Schande-Abzeichen

**Eigene Coins und Rugpulls**

Jeder kann einen Coin starten. Der Kurs entsteht aus einem Liquiditaetspool
nach `x * y = k`, genau wie bei echten dezentralen Boersen. Wer kauft, treibt
den Kurs selbst nach oben. Der Ersteller kann die Liquiditaet wieder abziehen
- dann ist der Coin wertlos, und das Abzeichen "Rugger" klebt dauerhaft am
Profil. Vor jedem Kauf sieht man, wie hoch das Risiko ist.

**Der KI-Trader**

Nach 25 eigenen Trades schaltet sich der erste Bot frei. Er bekommt ein
Budget, eine Strategie (DCA, Mean Reversion, Momentum, Grid, Scalper) - und
macht Fehler: FOMO-Kaeufe, Panikverkaeufe, vergessene Stops, vertippte
Ordergroessen. Mit jedem Level werden es weniger, aber nie null. Jede
Entscheidung steht mit Begruendung im Protokoll.

**Tycoon-Ebene**

Prestige aus Platzierungen und Achievements baut deinen Trading-Desk aus:
niedrigere Gebuehren, mehr Bot-Plaetze, Research-Werkzeuge, Kosmetik. In
Wettkampf-Ligen sind Upgrades standardmaessig abgeschaltet, damit ein
Neuling gegen einen Vielspieler dieselben Konditionen hat.

---

## Wie es aufgebaut ist

```
TradeArena/
  packages/core/     Die Engine. Reines TypeScript, keine Datenbank, kein
                     Netzwerk, kein Zufall. 170+ Unit-Tests.
  apps/server/       Node-Server: HTTP-API, WebSocket, Binance-Feed,
                     Engine-Schleife. Ein einziger Prozess.
  apps/web/          React + Vite + Tailwind. Das Terminal.
```

**Ein Prozess macht alles.** Kein Vercel, kein Supabase, kein extra Worker.
Das war eine bewusste Entscheidung: ein Trading-Simulator braucht einen
dauerhaft laufenden Prozess (WebSocket zur Boerse, Pruefung liegender Orders,
Liquidationen), und serverlose Plattformen koennen das nicht. Ein Dienst
bedeutet ein Deployment, eine URL, kein CORS - und du musst dich bei genau
einem Anbieter anmelden statt bei dreien.

**Datenbank:** SQLite lokal, Postgres im Betrieb - dieselbe SQL-Syntax, ein
Adapter. Umschalten heisst `DATABASE_URL` setzen, sonst nichts.

**Der Client rechnet nichts.** Der Browser schickt nur Absichten ("kaufe fuer
1000 $"), nie einen Preis. Preis, Gebuehren, Slippage und Kaufkraft entstehen
ausschliesslich auf dem Server mit dessen eigenen Kursen. Ein manipulierter
Client kann hoechstens eine Order stellen, die abgelehnt wird.

**Kein Geld aus dem Nichts.** Jede Bewegung landet im Kassenbuch; die Summe
aller Eintraege muss immer den Kontostand ergeben. Ein Test prueft genau das
nach jedem Szenario.

---

## Befehle

| Befehl | Was passiert |
|---|---|
| `npm run dev` | Server (8080) und Frontend (5173) mit automatischem Neuladen |
| `npm test` | Die komplette Engine-Testsuite |
| `npm run test:watch` | Tests laufen bei jeder Aenderung mit |
| `npm run build` | Frontend bauen (landet in `apps/web/dist`) |
| `npm start` | Betriebsmodus: ein Prozess, liefert auch das Frontend aus |
| `npm run typecheck` | TypeScript pruefen |

Ohne Internet entwickeln: `OFFLINE=true npm run dev`. Dann erzeugt ein
Simulator die Kurse und die App laeuft vollstaendig - nur eben mit erfundenen
Zahlen. Auch wenn Binance mitten im Spiel ausfaellt, springt der Simulator
automatisch ein, statt die App sterben zu lassen.

---

## Tests

Das Herz der App ist die Engine, und die ist vollstaendig testbar, weil sie
nichts kennt ausser Zahlen:

```bash
npm test
```

Geprueft werden unter anderem: Rundung bei negativen Betraegen, Gebuehren,
jeder Ordertyp einzeln, Trailing Stops in beide Richtungen, die Gap-Regel,
Margin und Liquidation, PnL ueber Teilverkaeufe und Positionsumkehr, die
Invariante des AMM (`k` darf nie schrumpfen), Rugpull als Nullsummenspiel -
und ein goldenes Szenario, das nachrechnet, dass ein kompletter Handelstag
auf den Cent aufgeht.

---

## Sicherheit

- Orders werden ausschliesslich serverseitig ausgefuehrt
- Ein Schloss um alle Schreibvorgaenge: 20-mal auf "Kaufen" haemmern erzeugt
  20 sauber nacheinander gepruefte Orders, keine Doppelbuchung
- Passwoerter mit scrypt gehasht, Sitzung im httpOnly-Cookie
- Eine einzige WebSocket-Verbindung zur Boerse fuer alle Spieler zusammen
- Vollstaendiges Audit-Log: jeder Cent ist nachvollziehbar

---

## Weiterlesen

- **[PLAN.md](PLAN.md)** - der Entwurf: Architektur, Datenmodell, Engine im Detail
- **[DEPLOY.md](DEPLOY.md)** - Schritt fuer Schritt online stellen
