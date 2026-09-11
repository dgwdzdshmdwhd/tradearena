import { useCallback, useEffect, useState } from 'react';

import { Announce } from './components/Announce.js';
import { ConfirmHost } from './components/ConfirmHost.js';
import { Takeover } from './components/Takeover.js';
import { Toasts } from './components/Toasts.js';
import { ApiError, api, quiet, type Me } from './lib/api.js';
import { live, useLiveEvent } from './lib/live.js';
import { confetti, flashDanger, setSoundEnabled, sounds } from './lib/sound.js';
import { pushToast } from './lib/toast.js';
import { Auth } from './views/Auth.js';
import { Desk } from './views/Desk.js';
import { Lobby } from './views/Lobby.js';
import { Profile } from './views/Profile.js';
import { Terminal } from './views/Terminal.js';

type Route =
  | { name: 'lobby' }
  | { name: 'league'; id: string }
  | { name: 'desk' }
  | { name: 'profile'; id: string }
  | { name: 'join'; code: string };

function parseHash(): Route {
  const hash = location.hash.replace(/^#\/?/, '');
  const [head, id] = hash.split('/');

  if (head === 'l' && id) return { name: 'league', id };
  if (head === 'desk') return { name: 'desk' };
  if (head === 'p' && id) return { name: 'profile', id };
  if (head === 'join' && id) return { name: 'join', code: id.toUpperCase() };
  return { name: 'lobby' };
}

export function navigate(path: string): void {
  location.hash = path;
}

/** Vollstaendiger Einladungslink zu einer Liga. */
export function inviteLink(code: string): string {
  return `${location.origin}/#/join/${code}`;
}

export function App(): JSX.Element {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useState<Route>(parseHash());
  const [joining, setJoining] = useState(false);

  const loadMe = useCallback(async () => {
    try {
      const data = await api.get<Me>('/api/me');
      setMe(data);
      setSoundEnabled(data.soundEnabled);
      live.connect();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setMe(null);
      else console.error(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    quiet(loadMe());
  }, [loadMe]);

  useEffect(() => {
    const onHash = (): void => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Einladungslink: sobald jemand angemeldet ist, tritt er still bei und
  // landet direkt im Terminal. Niemand muss einen Code abtippen.
  useEffect(() => {
    if (route.name !== 'join' || !me || joining) return;

    setJoining(true);
    void (async () => {
      try {
        const result = await api.post<{ leagueId: string; alreadyMember: boolean }>(
          '/api/leagues/join',
          { code: route.code },
        );
        pushToast({
          kind: result.alreadyMember ? 'info' : 'success',
          title: result.alreadyMember ? 'Du bist schon dabei' : 'Liga beigetreten',
        });
        navigate(`/l/${result.leagueId}`);
      } catch (error) {
        pushToast({
          kind: 'error',
          title: 'Beitritt nicht moeglich',
          body: error instanceof ApiError ? error.message : 'Unbekannter Fehler',
        });
        navigate('/');
      } finally {
        setJoining(false);
      }
    })();
  }, [route, me, joining]);

  // Ereignisse, die den Spieler ueberall erreichen sollen, nicht nur in einer
  // bestimmten Ansicht.
  useLiveEvent((event, payload) => {
    const data = (payload ?? {}) as Record<string, unknown>;

    if (event === 'achievement') {
      sounds.achievement();
      confetti(1400);
      pushToast({
        kind: 'achievement',
        achievementKey: String(data.key ?? ''),
        title: String(data.name ?? ''),
        body: String(data.description ?? ''),
      });
      quiet(loadMe());
    }

    if (event === 'liquidated') {
      sounds.liquidation();
      flashDanger();
      pushToast({
        kind: 'danger',
        title: 'Zwangsliquidiert',
        body: 'Deine groesste Position wurde geschlossen.',
      });
    }

    if (event === 'margin_call') {
      pushToast({
        kind: 'error',
        title: 'Margin Call',
        body: 'Deine Sicherheit reicht kaum noch. Position verkleinern oder Geld nachlegen.',
      });
    }
  });

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="num dimmer animate-pulse text-[12.5px] tracking-[0.3em]">TRADEARENA</div>
      </div>
    );
  }

  if (!me) {
    return (
      <>
        <Auth
          inviteCode={route.name === 'join' ? route.code : null}
          onDone={() => quiet(loadMe())}
        />
        <Toasts />
      </>
    );
  }

  return (
    <>
      {route.name === 'lobby' || route.name === 'join' ? (
        <Lobby me={me} onRefresh={() => quiet(loadMe())} />
      ) : null}
      {route.name === 'league' ? <Terminal me={me} leagueId={route.id} /> : null}
      {route.name === 'desk' ? <Desk me={me} onRefresh={() => quiet(loadMe())} /> : null}
      {route.name === 'profile' ? <Profile userId={route.id} /> : null}
      <Announce />
      <Takeover meUserId={me.user.id} />
      <ConfirmHost />
      <Toasts />
    </>
  );
}
