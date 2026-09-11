import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, api, quiet, type Instrument } from '../lib/api.js';
import { fmtUsd, toCents } from '../lib/format.js';
import { pushToast } from '../lib/toast.js';
import { Icon } from './Icon.js';
import { Field, Modal } from './Ui.js';

/**
 * Spielleiter-Pult.
 *
 * Sichtbar nur fuer den, der die Liga aufgemacht hat. Ein Abend unter
 * Freunden lebt davon, dass jemand eingreifen darf - Geld nachwerfen, den
 * Markt anschubsen, jemandem etwas auf den Bildschirm werfen.
 *
 * Alles, was hier passiert, landet im Feed. Das ist Absicht: Ein Gastgeber,
 * der sichtbar schummelt, ist der Spass. Einer, der es heimlich tut, ist
 * keiner.
 */

interface Spieler {
  userId: string;
  username: string;
  cashCents: string;
  equityCents: string;
}

type Reiter = 'geld' | 'markt' | 'streich';

const EFFEKTE: Array<{ key: string; label: string }> = [
  { key: 'keiner', label: 'ohne' },
  { key: 'beben', label: 'Beben' },
  { key: 'kopfstand', label: 'Kopfstand' },
  { key: 'regen', label: 'Geldregen' },
  { key: 'stroboskop', label: 'Stroboskop' },
];

export function HostPanel({
  leagueId,
  instruments,
  onClose,
}: {
  leagueId: string;
  instruments: Instrument[];
  onClose: () => void;
}): JSX.Element {
  const [reiter, setReiter] = useState<Reiter>('geld');
  const [spieler, setSpieler] = useState<Spieler[]>([]);
  const [busy, setBusy] = useState(false);

  const laden = useCallback(async () => {
    const data = await api.get<{ players: Spieler[] }>(`/api/leagues/${leagueId}/host/players`);
    setSpieler(data.players);
  }, [leagueId]);

  useEffect(() => {
    quiet(laden());
    const handle = setInterval(() => quiet(laden()), 6_000);
    return () => clearInterval(handle);
  }, [laden]);

  const melden = (error: unknown): void => {
    pushToast({
      kind: 'error',
      title: 'Ging nicht',
      body: error instanceof ApiError ? error.message : 'Unbekannter Fehler.',
    });
  };

  return (
    <Modal title="Spielleiter" onClose={onClose} width="34rem">
      <div className="flex gap-1 border-b border-[var(--color-hairline)] px-3 py-2">
        {(
          [
            ['geld', 'Geld', 'wallet'],
            ['markt', 'Markt', 'candles'],
            ['streich', 'Streich', 'zap'],
          ] as const
        ).map(([key, label, icon]) => (
          <button
            key={key}
            onClick={() => setReiter(key)}
            className={`btn btn-sm ${reiter === key ? 'btn-primary' : ''}`}
          >
            <Icon name={icon} size={12} />
            {label}
          </button>
        ))}
      </div>

      {reiter === 'geld' ? (
        <GeldReiter
          leagueId={leagueId}
          spieler={spieler}
          busy={busy}
          setBusy={setBusy}
          melden={melden}
          nachher={laden}
        />
      ) : null}

      {reiter === 'markt' ? (
        <MarktReiter
          leagueId={leagueId}
          instruments={instruments}
          busy={busy}
          setBusy={setBusy}
          melden={melden}
        />
      ) : null}

      {reiter === 'streich' ? (
        <StreichReiter
          leagueId={leagueId}
          spieler={spieler}
          busy={busy}
          setBusy={setBusy}
          melden={melden}
        />
      ) : null}
    </Modal>
  );
}

// ------------------------------------------------------------------- Geld

function GeldReiter({
  leagueId,
  spieler,
  busy,
  setBusy,
  melden,
  nachher,
}: {
  leagueId: string;
  spieler: Spieler[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  melden: (error: unknown) => void;
  nachher: () => Promise<void>;
}): JSX.Element {
  const [betrag, setBetrag] = useState('10000');
  const [grund, setGrund] = useState('');

  const buchen = async (userId: string, vorzeichen: 1 | -1): Promise<void> => {
    const cents = BigInt(toCents(betrag) || '0');
    if (cents <= 0n) return;

    setBusy(true);
    try {
      await api.post(`/api/leagues/${leagueId}/host/cash`, {
        userId,
        amountCents: (cents * BigInt(vorzeichen)).toString(),
        reason: grund,
      });
      await nachher();
    } catch (error) {
      melden(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Betrag ($)">
          <input className="input" value={betrag} onChange={(e) => setBetrag(e.target.value)} />
        </Field>
        <Field label="Grund (steht im Feed)">
          <input
            className="input"
            placeholder="Trostpflaster"
            value={grund}
            onChange={(e) => setGrund(e.target.value)}
          />
        </Field>
      </div>

      <div className="flex gap-1">
        {['1000', '10000', '50000'].map((value) => (
          <button key={value} className="btn btn-sm" onClick={() => setBetrag(value)}>
            {Number(value).toLocaleString('de-DE')} $
          </button>
        ))}
      </div>

      <div className="max-h-64 space-y-1 overflow-y-auto">
        {spieler.map((eintrag) => (
          <div
            key={eintrag.userId}
            className="flex items-center justify-between gap-2 rounded-[var(--radius)] bg-[var(--color-bg)] px-2.5 py-1.5"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px]">{eintrag.username}</span>
              <span className="dimmer num block text-[11.5px]">
                {fmtUsd(eintrag.equityCents)} gesamt
              </span>
            </span>

            <button
              className="btn btn-buy btn-sm"
              disabled={busy}
              onClick={() => void buchen(eintrag.userId, 1)}
            >
              geben
            </button>
            <button
              className="btn btn-sell btn-sm"
              disabled={busy}
              onClick={() => void buchen(eintrag.userId, -1)}
            >
              nehmen
            </button>
          </div>
        ))}

        {spieler.length === 0 ? (
          <p className="dimmer p-3 text-center text-[13px]">Noch niemand in der Liga.</p>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Markt

function MarktReiter({
  leagueId,
  instruments,
  busy,
  setBusy,
  melden,
}: {
  leagueId: string;
  instruments: Instrument[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  melden: (error: unknown) => void;
}): JSX.Element {
  const werte = instruments.filter((instrument) => instrument.kind === 'sim');
  const [instrumentId, setInstrumentId] = useState(werte[0]?.id ?? '');
  const [staerke, setStaerke] = useState(2);
  const [minuten, setMinuten] = useState(3);
  const [headline, setHeadline] = useState('');

  const schubsen = async (direction: 'up' | 'down'): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.post<{ headline: string }>(`/api/leagues/${leagueId}/host/market`, {
        instrumentId,
        direction,
        strength: staerke,
        minutes: minuten,
        headline,
      });
      pushToast({ kind: 'success', title: 'Laeuft', body: r.headline, icon: 'candles' });
    } catch (error) {
      melden(error);
    } finally {
      setBusy(false);
    }
  };

  const memeStarten = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.post<{ symbol: string }>(`/api/leagues/${leagueId}/host/meme`, {});
      pushToast({ kind: 'success', title: 'Neuer Memecoin', body: r.symbol, icon: 'zap' });
    } catch (error) {
      melden(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 p-3">
      <Field label="Wert">
        <select
          className="input"
          value={instrumentId}
          onChange={(e) => setInstrumentId(e.target.value)}
        >
          {werte.map((instrument) => (
            <option key={instrument.id} value={instrument.id}>
              {instrument.display}
              {instrument.name ? ` - ${instrument.name}` : ''}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Wucht">
          <select
            className="input"
            value={staerke}
            onChange={(e) => setStaerke(Number(e.target.value))}
          >
            <option value={1}>spuerbar</option>
            <option value={2}>deutlich</option>
            <option value={3}>brutal</option>
          </select>
        </Field>
        <Field label="Dauer (Min.)">
          <input
            className="input"
            inputMode="numeric"
            value={minuten}
            onChange={(e) => setMinuten(Number(e.target.value) || 1)}
          />
        </Field>
      </div>

      <Field label="Schlagzeile (leer = passende)">
        <input
          className="input"
          placeholder="Grossauftrag fuer ..."
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
        />
      </Field>

      <div className="flex gap-2">
        <button
          className="btn btn-buy flex-1 justify-center"
          disabled={busy || !instrumentId}
          onClick={() => void schubsen('up')}
        >
          <Icon name="trend-up" size={13} />
          hoch
        </button>
        <button
          className="btn btn-sell flex-1 justify-center"
          disabled={busy || !instrumentId}
          onClick={() => void schubsen('down')}
        >
          <Icon name="trend-down" size={13} />
          runter
        </button>
      </div>

      <div className="border-t border-[var(--color-hairline)] pt-3">
        <button className="btn w-full justify-center" disabled={busy} onClick={() => void memeStarten()}>
          <Icon name="zap" size={13} />
          Memecoin jetzt starten
        </button>
        <p className="dimmer mt-1.5 text-[12px] leading-snug">
          Bringt sofort einen neuen an den Markt, statt auf den naechsten Takt zu warten. Alle
          bekommen die Meldung.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Streich

function StreichReiter({
  leagueId,
  spieler,
  busy,
  setBusy,
  melden,
}: {
  leagueId: string;
  spieler: Spieler[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  melden: (error: unknown) => void;
}): JSX.Element {
  const [ziel, setZiel] = useState('');
  const [titel, setTitel] = useState('');
  const [text, setText] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [effect, setEffect] = useState('keiner');
  const [sekunden, setSekunden] = useState(6);
  const [laedt, setLaedt] = useState(false);
  const datei = useRef<HTMLInputElement | null>(null);

  const hochladen = async (file: File): Promise<void> => {
    if (file.size > 6 * 1024 * 1024) {
      pushToast({
        kind: 'error',
        title: 'Zu gross',
        body: `${(file.size / 1024 / 1024).toFixed(1)} MB - erlaubt sind 6 MB.`,
      });
      return;
    }

    setLaedt(true);
    try {
      const base64 = await new Promise<string>((fertig, fehler) => {
        const reader = new FileReader();
        reader.onerror = () => fehler(new Error('Datei nicht lesbar.'));
        reader.onload = () => fertig(String(reader.result).split(',')[1] ?? '');
        reader.readAsDataURL(file);
      });

      const r = await api.post<{ url: string }>('/api/media', {
        mime: file.type,
        name: file.name,
        dataBase64: base64,
      });
      setMediaUrl(r.url);
      pushToast({ kind: 'success', title: 'Hochgeladen', body: file.name, icon: 'check' });
    } catch (error) {
      melden(error);
    } finally {
      setLaedt(false);
    }
  };

  const abschicken = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.post(`/api/leagues/${leagueId}/host/takeover`, {
        targetUserId: ziel || null,
        title: titel,
        body: text,
        mediaUrl,
        effect,
        seconds: sekunden,
      });
      pushToast({ kind: 'success', title: 'Raus damit', icon: 'zap' });
    } catch (error) {
      melden(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 p-3">
      <Field label="An wen">
        <select className="input" value={ziel} onChange={(e) => setZiel(e.target.value)}>
          <option value="">alle</option>
          {spieler.map((eintrag) => (
            <option key={eintrag.userId} value={eintrag.userId}>
              {eintrag.username}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Ueberschrift">
          <input
            className="input"
            placeholder="MARGIN CALL"
            value={titel}
            onChange={(e) => setTitel(e.target.value)}
          />
        </Field>
        <Field label="Sekunden">
          <input
            className="input"
            inputMode="numeric"
            value={sekunden}
            onChange={(e) => setSekunden(Number(e.target.value) || 6)}
          />
        </Field>
      </div>

      <Field label="Text">
        <input
          className="input"
          placeholder="Dein Depot wurde eingezogen."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>

      <Field label="Bild, Clip oder Link">
        <input
          className="input"
          placeholder="YouTube-Link oder Adresse"
          value={mediaUrl}
          onChange={(e) => setMediaUrl(e.target.value)}
        />
      </Field>

      <div className="flex items-center gap-2">
        <input
          ref={datei}
          type="file"
          accept="image/*,video/mp4,video/webm,audio/mpeg"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void hochladen(file);
            event.target.value = '';
          }}
        />
        <button className="btn btn-sm" disabled={laedt} onClick={() => datei.current?.click()}>
          <Icon name="plus" size={12} />
          {laedt ? 'laedt ...' : 'Datei waehlen'}
        </button>
        <span className="dimmer text-[12px]">bis 6 MB - Bild, GIF, MP4, WebM</span>
      </div>

      <Field label="Effekt auf dem Bildschirm">
        <select className="input" value={effect} onChange={(e) => setEffect(e.target.value)}>
          {EFFEKTE.map((eintrag) => (
            <option key={eintrag.key} value={eintrag.key}>
              {eintrag.label}
            </option>
          ))}
        </select>
      </Field>

      <button
        className="btn btn-primary w-full justify-center"
        disabled={busy}
        onClick={() => void abschicken()}
      >
        <Icon name="zap" size={13} />
        Auf den Bildschirm
      </button>

      <p className="dimmer text-[12px] leading-snug">
        Laesst sich nicht wegklicken, solange die Zeit laeuft. Kopfstand und Stroboskop fassen den
        ganzen Bildschirm an, nicht nur das Fenster.
      </p>
    </div>
  );
}
