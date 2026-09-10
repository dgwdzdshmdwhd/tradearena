# TradeArena online stellen

Damit deine Freunde von ihren eigenen Rechnern mitspielen koennen, muss die
App irgendwo im Netz laufen. Diese Anleitung ist fuer jemanden geschrieben,
der das zum ersten Mal macht. Rechne mit **20 Minuten**.

**Kosten: 0 €.** Alles, was hier benutzt wird, ist im kostenlosen Tarif.

Am Ende hast du eine Adresse wie `https://tradearena.onrender.com`, die du
deinen Freunden schickst.

---

## Vorher: was ich fuer dich NICHT machen kann

Konten anlegen und Passwoerter eingeben musst du selbst - das sind genau die
Schritte unten. Alles andere ist schon fertig: Code, Konfiguration,
Datenbank-Schema, Build-Anweisungen.

Du brauchst zwei kostenlose Konten:

1. **GitHub** - dort liegt der Code
2. **Render** - dort laeuft die App

---

## Schritt 1 - Code zu GitHub

### 1.1 GitHub-Konto

Falls du noch keins hast: [github.com/signup](https://github.com/signup).
E-Mail, Passwort, Benutzername, fertig.

### 1.2 Neues Repository anlegen

Auf [github.com/new](https://github.com/new):

- **Repository name:** `tradearena`
- **Private** auswaehlen (dein Projekt geht niemanden etwas an)
- **Nichts** ankreuzen bei "Add a README file" o. Ae.
- **Create repository** klicken

GitHub zeigt dir jetzt eine Seite mit Befehlen. Die brauchst du gleich.

### 1.3 Code hochladen

Terminal im Projektordner oeffnen (`C:\Users\User\Desktop\TradeArena`) und
diese Befehle nacheinander ausfuehren. Die Adresse im vorletzten Befehl
ersetzt du durch die, die GitHub dir anzeigt:

```bash
git init
git add .
git commit -m "TradeArena"
git branch -M main
git remote add origin https://github.com/DEIN-NAME/tradearena.git
git push -u origin main
```

Falls `git` nicht gefunden wird: [git-scm.com/downloads](https://git-scm.com/downloads)
installieren, Terminal neu oeffnen, nochmal versuchen.

Beim `git push` fragt GitHub nach Anmeldedaten. Ein Fenster oeffnet sich, in
dem du dich bei GitHub anmeldest.

> **Wichtig:** Die Datei `.gitignore` sorgt dafuer, dass `node_modules`, die
> SQLite-Datei und alle `.env`-Dateien **nicht** hochgeladen werden. Falls du
> spaeter Passwoerter oder Schluessel im Projekt speicherst: immer in `.env`,
> nie direkt im Code.

---

## Schritt 2 - Bei Render deployen

### 2.1 Render-Konto

Auf [render.com](https://render.com) → **Get Started** → **GitHub**. Damit
meldest du dich mit deinem GitHub-Konto an, und Render darf deine
Repositories sehen. Eine Kreditkarte wird nicht verlangt.

### 2.2 Blueprint starten

Im Render-Dashboard:

1. **New +** (oben rechts) → **Blueprint**
2. Dein Repository `tradearena` auswaehlen
   (falls es nicht auftaucht: **Configure account** → Zugriff auf das
   Repository erlauben)
3. Render liest die Datei `render.yaml` aus dem Projekt und zeigt dir an, was
   es anlegen wird: einen Webdienst **tradearena** und eine Postgres-Datenbank
   **tradearena-db**
4. **Apply** klicken

Jetzt baut Render die App. Das dauert beim ersten Mal **3 bis 6 Minuten**.
Du kannst unter **Logs** zusehen. Fertig ist es, wenn dort steht:

```
[http] laeuft auf http://localhost:10000
[markt] Binance verbunden, 10 Symbole
[engine] laeuft, Takt 250 ms
```

### 2.3 Deine Adresse

Oben auf der Seite des Webdienstes steht die URL, etwa
`https://tradearena.onrender.com`. Oeffne sie. Wenn die Anmeldemaske
erscheint: geschafft.

**Diese Adresse schickst du deinen Freunden.** Jeder legt sich ein Konto an,
du erstellst eine Liga und gibst den Einladungscode weiter.

---

## Schritt 3 - Den Dienst wach halten (wichtig)

Render legt kostenlose Dienste nach **15 Minuten ohne Aufrufe** schlafen.
Waehrend er schlaeft, laufen keine Stop-Orders und keine Bots, und der erste
Aufruf danach dauert 30 bis 50 Sekunden.

Dagegen hilft ein kostenloser Cron-Dienst, der alle paar Minuten anklopft:

1. [cron-job.org](https://cron-job.org) → **Registrieren** (kostenlos)
2. **Create cronjob**
3. **Title:** `TradeArena wach halten`
4. **URL:** `https://DEINE-ADRESSE.onrender.com/healthz`
5. **Schedule:** "Every 5 minutes" (oder "Every minute")
6. **Create** klicken

Fertig. Die Adresse `/healthz` ist genau dafuer gedacht und antwortet mit
einer winzigen Statusmeldung.

> Der Dienst hat 750 Gratis-Stunden pro Monat. Ein durchgehend laufender
> Dienst braucht rund 720 - passt also, solange es bei dieser einen App
> bleibt.

---

## Schritt 4 - Nach jeder Aenderung

Wenn du am Code etwas aenderst:

```bash
git add .
git commit -m "was ich geaendert habe"
git push
```

Render merkt das automatisch und deployt neu. Waehrenddessen ist die App
etwa eine Minute lang nicht erreichbar. Das ist unkritisch: Nach dem
Neustart liest die Engine alle offenen Orders wieder aus der Datenbank und
arbeitet nach, was in der Zwischenzeit ausgeloest haette werden muessen. Es
geht nichts verloren, es wird nur kurz spaeter ausgefuehrt.

---

## Die Haken der Gratis-Variante, ehrlich

**Die kostenlose Datenbank laeuft nach 30 Tagen ab.** Render schickt vorher
eine Mail. Dann legst du eine neue an (New + → Postgres → Free), kopierst die
"Internal Database URL" und traegst sie beim Webdienst unter **Environment**
als `DATABASE_URL` ein. Die alten Ligen sind damit weg - fuer laufende
Saisons also vorher exportieren oder rechtzeitig auf den bezahlten Tarif
(7 $/Monat) wechseln.

**Kaltstart nach dem Schlafen** dauert 30 bis 50 Sekunden. Mit dem Cron-Ping
aus Schritt 3 passiert das praktisch nie.

**Der kostenlose Dienst hat 512 MB RAM.** Fuer eine Handvoll Freunde ist das
reichlich; die App braucht im Leerlauf etwa 90 MB.

---

## Alternativen zu Render

Der Server ist ein ganz normaler Node-Prozess mit Dockerfile. Er laeuft
ueberall, wo Docker laeuft:

| Anbieter | Kostenlos? | Anmerkung |
|---|---|---|
| **Render** | ja | in dieser Anleitung, einfachster Weg |
| **Koyeb** | ja | ein Gratis-Dienst, schlaeft nicht ein |
| **Fly.io** | nein, aber billig | ~2 $/Monat, mit dauerhafter Festplatte |
| **Railway** | Startguthaben | sehr bequem, danach ~5 $/Monat |
| **Eigener Server** | - | `docker build -t tradearena . && docker run -p 8080:8080 tradearena` |

Umziehen heisst: neues Konto, Repository verbinden, `SESSION_SECRET` und
`DATABASE_URL` setzen. Am Code aendert sich nichts.

---

## Nur mal schnell mit Freunden testen, ohne Deployment

Wenn ihr heute Abend spielen wollt und der Deploy warten kann: Starte die App
lokal und mach sie mit einem Tunnel erreichbar.

```bash
npm run build
npm start
```

In einem zweiten Terminal:

```bash
npx localtunnel --port 8080
```

Das gibt dir eine oeffentliche Adresse. Sie funktioniert, solange dein
Rechner an ist und beide Fenster offen sind. Fuer einen Abend reicht das -
fuer eine Saison ueber zwei Wochen nicht.

---

## Wenn etwas nicht geht

**Build schlaegt fehl, "npm: command not found"**
In `render.yaml` steht `NODE_VERSION: 24.9.0`. Falls Render die Version nicht
akzeptiert, unter **Environment** eine andere setzen, mindestens `22`.

**App laedt, aber keine Kurse**
Unter **Logs** nachsehen. Steht dort `[markt] Simulator aktiv`, kommt der
Server nicht an Binance heran. Die App funktioniert trotzdem - nur mit
erfundenen Kursen. Meist hilft ein Neustart (**Manual Deploy** → **Restart**).

**"Nicht angemeldet", obwohl gerade angemeldet**
`SESSION_SECRET` ist nicht gesetzt oder aendert sich bei jedem Start. Bei der
Blueprint-Variante erzeugt Render ihn automatisch; falls du von Hand
deployst, unter **Environment** einen festen Wert eintragen.

**Alle Ligen sind ploetzlich weg**
Dann lief die App auf SQLite statt Postgres, und ein Deploy hat die
Festplatte zurueckgesetzt. Pruefen: ist `DATABASE_URL` beim Webdienst
gesetzt? In den Logs muss beim Start `[db] Postgres` stehen, nicht
`[db] SQLite`.
