import { useCallback, useEffect, useMemo, useState } from 'react';

import { inviteLink, navigate } from '../App.js';
import { BotsPanel } from '../components/BotsPanel.js';
import { Chart } from '../components/Chart.js';
import { CoinsPanel } from '../components/CoinsPanel.js';
import { Icon, MODE_ICONS } from '../components/Icon.js';
import { NextStep } from '../components/NextStep.js';
import { Onboarding } from '../components/Onboarding.js';
import { Leaderboard, OpenOrders, OrderBook, Positions, Watchlist } from '../components/Panels.js';
import { Chat, Feed } from '../components/Social.js';
import { StatsPanel } from '../components/StatsPanel.js';
import { Ticket } from '../components/Ticket.js';
import { CopyButton, Status, Tabs } from '../components/Ui.js';
import {
  api,
  quiet,
  type Candle,
  type ChatMessage,
  type Coin,
  type FeedEvent,
  type Instrument,
  type LeaderboardEntry,
  type LeagueDetail,
  type Me,
  type Portfolio,
} from '../lib/api.js';
import { fmtBps, fmtCountdown, fmtUsd, priceToNumber, returnBps, signClass } from '../lib/format.js';
import { useLeagueSubscription, useLiveEvent, usePrices } from '../lib/live.js';
import { confetti, isSoundEnabled, setSoundEnabled, sounds } from '../lib/sound.js';
import { pushToast } from '../lib/toast.js';

type SidePanel = 'rangliste' | 'feed' | 'chat' | 'coins' | 'bots';
type MainPanel = 'positionen' | 'orders' | 'auswertung';

const SIDE_LABELS: Record<SidePanel, string> = {
  rangliste: 'Rangliste',
  feed: 'Feed',
  chat: 'Chat',
  coins: 'Coins',
  bots: 'Bots',
};

const MAIN_LABELS: Record<MainPanel, string> = {
  positionen: 'Positionen',
  orders: 'Orders',
  auswertung: 'Auswertung',
};

const MODE_LABELS: Record<string, string> = {
  classic: 'Klassisch',
  blitz: 'Blitzrunde',
  survival: 'Survival',
  timemachine: 'Zeitmaschine',
};

export function Terminal({ me, leagueId }: { me: Me; leagueId: string }): JSX.Element {
  const [league, setLeague] = useState<LeagueDetail | null>(null);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [humans, setHumans] = useState<LeaderboardEntry[]>([]);
  const [bots, setBots] = useState<LeaderboardEntry[]>([]);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [coins, setCoins] = useState<Coin[]>([]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [interval, setIntervalValue] = useState('1m');
  const [sidePanel, setSidePanel] = useState<SidePanel>('rangliste');
  const [mainPanel, setMainPanel] = useState<MainPanel>('positionen');
  const [mobileTab, setMobileTab] = useState<'chart' | 'order' | 'depot' | 'liga'>('chart');
  const [soundOn, setSoundOn] = useState(isSoundEnabled());
  const [feedStatus, setFeedStatus] = useState<string>('live');
  // Der Trading-Desk waechst beim Spielen mit. Ohne diese Anzeige im
  // Terminal bemerkt das niemand, und die ganze Tycoon-Ebene bleibt unsichtbar.
  const [desk, setDesk] = useState({
    prestige: me.prestige,
    lifetime: me.lifetimePrestige,
    rank: me.rank.title,
    next: me.nextRank,
  });
  const [showTutorial, setShowTutorial] = useState(
    () => localStorage.getItem('ta_tutorial_done') !== '1',
  );
  // Einfacher Modus ist der Standard. Ein Handelsterminal mit Orderbuch,
  // fuenf Ordertypen und Indikatoren ist fuer den ersten Abend eine Wand.
  const [simple, setSimple] = useState(() => localStorage.getItem('ta_pro') !== '1');

  const prices = usePrices();
  useLeagueSubscription(leagueId);

  const selected = instruments.find((instrument) => instrument.id === selectedId) ?? null;

  const loadLeague = useCallback(async () => {
    const data = await api.get<{ league: LeagueDetail }>(`/api/leagues/${leagueId}`);
    setLeague(data.league);
  }, [leagueId]);

  const loadInstruments = useCallback(async () => {
    const data = await api.get<{ instruments: Instrument[]; feedStatus: string }>(
      `/api/leagues/${leagueId}/instruments`,
    );
    setInstruments(data.instruments);
    setFeedStatus(data.feedStatus);
    setSelectedId((current) => current ?? data.instruments[0]?.id ?? null);
  }, [leagueId]);

  const loadPortfolio = useCallback(async () => {
    setPortfolio(await api.get<Portfolio>(`/api/leagues/${leagueId}/portfolio`));
  }, [leagueId]);

  const loadBoard = useCallback(async () => {
    const data = await api.get<{ humans: LeaderboardEntry[]; bots: LeaderboardEntry[] }>(
      `/api/leagues/${leagueId}/leaderboard`,
    );
    setHumans(data.humans);
    setBots(data.bots);
  }, [leagueId]);

  const loadFeed = useCallback(async () => {
    const data = await api.get<{ events: FeedEvent[] }>(`/api/leagues/${leagueId}/feed`);
    setFeed(data.events);
  }, [leagueId]);

  const loadChat = useCallback(async () => {
    const data = await api.get<{ messages: ChatMessage[] }>(`/api/leagues/${leagueId}/chat`);
    setChat(data.messages);
  }, [leagueId]);

  const loadCoins = useCallback(async () => {
    const data = await api.get<{ coins: Coin[] }>(`/api/leagues/${leagueId}/coins`);
    setCoins(data.coins);
  }, [leagueId]);

  const loadDesk = useCallback(async () => {
    const data = await api.get<Me>('/api/me');
    setDesk({
      prestige: data.prestige,
      lifetime: data.lifetimePrestige,
      rank: data.rank.title,
      next: data.nextRank,
    });
  }, []);

  const loadCandles = useCallback(async () => {
    if (!selectedId) return;
    const data = await api.get<{ candles: Candle[] }>(
      `/api/leagues/${leagueId}/candles?instrumentId=${selectedId}&interval=${interval}`,
    );
    setCandles(data.candles);
  }, [leagueId, selectedId, interval]);

  useEffect(() => {
    quiet(loadLeague());
    quiet(loadInstruments());
    quiet(loadPortfolio());
    quiet(loadBoard());
    quiet(loadFeed());
    quiet(loadChat());
    quiet(loadCoins());
  }, [loadLeague, loadInstruments, loadPortfolio, loadBoard, loadFeed, loadChat, loadCoins]);

  useEffect(() => {
    quiet(loadCandles());
    const handle = setInterval(() => quiet(loadCandles()), 30_000);
    return () => clearInterval(handle);
  }, [loadCandles]);

  // Kurse kommen live ueber den WebSocket, der Rest im ruhigen Takt.
  useEffect(() => {
    const handle = setInterval(() => {
      quiet(loadPortfolio());
      quiet(loadBoard());
      quiet(loadInstruments());
      if (league?.mode === 'timemachine') quiet(loadLeague());
    }, 4_000);

    return () => clearInterval(handle);
  }, [loadPortfolio, loadBoard, loadInstruments, loadLeague, league?.mode]);

  useEffect(() => {
    const handle = setInterval(() => {
      quiet(loadFeed());
      quiet(loadDesk());
      if (sidePanel === 'chat') quiet(loadChat());
      if (sidePanel === 'coins') quiet(loadCoins());
    }, 9_000);

    return () => clearInterval(handle);
  }, [loadFeed, loadChat, loadCoins, loadDesk, sidePanel]);

  useLiveEvent((event, payload) => {
    if (event === 'trade') {
      quiet(loadPortfolio());
      quiet(loadBoard());
      quiet(loadFeed());
    }
    if (event === 'feed') quiet(loadFeed());
    if (event === 'chat') {
      const message = payload as ChatMessage;
      setChat((current) =>
        current.some((entry) => entry.id === message.id) ? current : [...current, message],
      );
    }
    if (event === 'coins') quiet(loadCoins());
    if (event === 'eliminated') {
      quiet(loadBoard());
      quiet(loadFeed());
    }
    if (event === 'league_end') {
      quiet(loadLeague());
      quiet(loadBoard());
      confetti(2600);
      sounds.win();
    }
  });

  const closePosition = async (instrumentId: string, qty: string): Promise<void> => {
    try {
      await api.post('/api/orders', {
        leagueId,
        instrumentId,
        side: Number(qty) > 0 ? 'sell' : 'buy',
        type: 'market',
        qty: String(Math.abs(Number(qty))),
        reduceOnly: true,
      });
      sounds.fill();
      quiet(loadPortfolio());
      quiet(loadBoard());
    } catch {
      pushToast({ kind: 'error', title: 'Schliessen fehlgeschlagen' });
    }
  };

  const react = async (feedId: string, key: string): Promise<void> => {
    await api.post('/api/reactions', { targetType: 'feed', targetId: feedId, emoji: key });
    quiet(loadFeed());
  };

  const send = async (body: string): Promise<void> => {
    await api.post(`/api/leagues/${leagueId}/chat`, { body });
    quiet(loadChat());
  };

  const finishLeague = async (): Promise<void> => {
    if (!window.confirm('Liga jetzt fuer alle beenden?')) return;
    await api.post(`/api/leagues/${leagueId}/finish`);
    quiet(loadLeague());
    quiet(loadBoard());
  };

  const livePrice = useMemo(() => {
    if (!selected) return null;
    const tick = prices[selected.symbol];
    if (tick) return priceToNumber(tick.last);
    return selected.last ? priceToNumber(selected.last) : null;
  }, [selected, prices]);

  if (!league) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="dimmer num animate-pulse text-[12.5px] tracking-[0.2em]">LADE LIGA</span>
      </div>
    );
  }

  const equity = portfolio?.account.equityCents ?? '0';
  const bps = portfolio ? returnBps(equity, portfolio.account.startCents) : 0;
  const marginWarning = portfolio?.margin.marginCall === true;

  const sideTabs = (['rangliste', 'feed', 'chat', 'coins', 'bots'] as const).filter(
    (tab) => (tab !== 'coins' || league.coinsAllowed) && (tab !== 'bots' || league.botsAllowed),
  ) as SidePanel[];

  const sidePanelContent = (
    <>
      {sidePanel === 'rangliste' ? (
        <Leaderboard entries={humans} bots={bots} meUserId={me.user.id} />
      ) : null}
      {sidePanel === 'feed' ? <Feed events={feed} onReact={react} meUserId={me.user.id} /> : null}
      {sidePanel === 'chat' ? <Chat messages={chat} onSend={send} meUserId={me.user.id} /> : null}
      {sidePanel === 'coins' ? (
        <CoinsPanel
          leagueId={leagueId}
          league={league}
          coins={coins}
          onChanged={() => {
            quiet(loadCoins());
            quiet(loadInstruments());
            quiet(loadPortfolio());
          }}
          onTrade={(id) => {
            setSelectedId(id);
            setMobileTab('order');
          }}
        />
      ) : null}
      {sidePanel === 'bots' ? (
        <BotsPanel
          leagueId={leagueId}
          league={league}
          instruments={instruments}
          onChanged={() => quiet(loadPortfolio())}
        />
      ) : null}
    </>
  );

  return (
    <div className="flex h-full flex-col">
      {/*
        Der Kopf ist die Hauptfigur: der Kontostand gross, alles andere klein.
        Vorher standen hier sieben gleich grosse Kleinigkeiten nebeneinander -
        das liest niemand, und es fuehlt sich nach Werkzeug an, nicht nach Spiel.
      */}
      <header className="border-b border-[var(--color-hairline)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
          <button
            className="btn btn-ghost btn-sm px-2"
            onClick={() => navigate('/')}
            title="Zur Lobby"
          >
            <Icon name="arrow-left" size={15} />
          </button>

          <div className="flex min-w-0 items-center gap-2.5">
            <span className="dimmer">
              <Icon name={MODE_ICONS[league.mode] ?? 'candles'} size={16} />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[17px] font-semibold leading-tight tracking-[-0.01em]">
                {league.name}
              </div>
              <div className="dimmer text-[12.5px] leading-tight">
                {MODE_LABELS[league.mode] ?? league.mode}
                {league.status === 'running' && league.mode !== 'timemachine'
                  ? ` · noch ${fmtCountdown(league.endsAt)}`
                  : ''}
                {league.status === 'finished' ? ' · beendet' : ''}
                {league.maxLeverage > 1 ? ` · ${league.maxLeverage}× Hebel` : ''}
              </div>
            </div>
          </div>

          <div className="flex items-end gap-3">
            <div>
              <div className="stat-label mb-1">Kontostand</div>
              <div className="hero text-[30px]">{fmtUsd(equity)}</div>
            </div>
            <span
              className={`pill mb-1 ${bps > 0 ? 'pill-up' : bps < 0 ? 'pill-down' : 'pill-flat'}`}
            >
              {fmtBps(bps)}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2.5">
            <button
              className="hidden w-[10rem] text-left sm:block"
              onClick={() => navigate('/desk')}
              title={
                desk.next
                  ? `${desk.lifetime} von ${desk.next.minPrestige} Prestige bis ${desk.next.title}`
                  : 'Trading-Desk'
              }
            >
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="stat-label">{desk.rank}</span>
                <span className="num accent text-[13px] font-semibold">{desk.prestige}</span>
              </div>
              <div className="meter meter-gold">
                <i
                  style={{
                    width: desk.next
                      ? `${Math.min(100, Math.round((desk.lifetime / desk.next.minPrestige) * 100))}%`
                      : '100%',
                  }}
                />
              </div>
            </button>

            {league.status === 'running' ? (
              <CopyButton
                value={inviteLink(league.inviteCode)}
                label="Einladen"
                icon="link"
                className="btn btn-ghost btn-sm"
              />
            ) : null}

            <button
              className="btn btn-ghost btn-sm"
              title={simple ? 'Alle Werkzeuge einblenden' : 'Zurueck zur einfachen Ansicht'}
              onClick={() => {
                const next = !simple;
                setSimple(next);
                localStorage.setItem('ta_pro', next ? '0' : '1');
              }}
            >
              {simple ? 'Pro' : 'Einfach'}
            </button>

            <button
              className="btn btn-ghost btn-sm px-2"
              title={soundOn ? 'Ton aus' : 'Ton an'}
              onClick={async () => {
                const next = !soundOn;
                setSoundOn(next);
                setSoundEnabled(next);
                await api.patch('/api/me', { soundEnabled: next });
              }}
            >
              <Icon name={soundOn ? 'volume-on' : 'volume-off'} size={15} />
            </button>

            {league.ownerId === me.user.id && league.status === 'running' ? (
              <button className="btn btn-ghost btn-sm" onClick={() => void finishLeague()}>
                beenden
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-2 flex items-center gap-4">
          <Status tone={feedStatus === 'live' ? 'live' : 'warn'}>
            {feedStatus === 'live' ? 'Kurse live von der Boerse' : 'Ersatzkurse - Boerse nicht erreichbar'}
          </Status>
          <span className="num dimmer text-[12px] tracking-[0.08em]">{league.inviteCode}</span>
        </div>
      </header>

      {marginWarning ? (
        <div
          className="down flex items-center justify-center gap-2 border-b px-3 py-1.5 text-[13px]"
          style={{
            borderColor: 'color-mix(in srgb, var(--color-down) 40%, transparent)',
            background: 'color-mix(in srgb, var(--color-down) 10%, transparent)',
          }}
        >
          <Icon name="alert" size={13} />
          Margin Call — deine Sicherheit reicht kaum noch. Position verkleinern, sonst wird
          liquidiert.
        </div>
      ) : null}

      <NextStep
        portfolio={portfolio}
        league={league}
        bots={bots}
        meUserId={me.user.id}
        prestige={desk.prestige}
        onOpenPanel={(panel) => {
          setSidePanel(panel);
          setMobileTab('liga');
        }}
      />

      {league.status === 'finished' && league.reveal ? (
        <div className="flex items-center justify-center gap-2 border-b border-[var(--color-hairline)] bg-[var(--color-raised)] px-3 py-1.5 text-[13px]">
          <span className="accent">
            <Icon name="flag" size={13} />
          </span>
          {league.reveal}
        </div>
      ) : null}

      {/* Desktop */}
      <div className="hidden min-h-0 flex-1 gap-2 p-2 lg:flex">
        <div className="flex w-[14.5rem] shrink-0 flex-col gap-2">
          <div className="min-h-0 flex-[3]">
            <Watchlist
              instruments={instruments}
              prices={prices}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
          {/* Das Orderbuch ist Deko - es beeinflusst die Ausfuehrung nicht.
              Im einfachen Modus ist es nur eine Wand aus Zahlen. */}
          {simple ? null : (
            <div className="min-h-0 flex-[2]">
              <OrderBook instrument={selected} prices={prices} />
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Chart
            candles={candles}
            interval={interval}
            onInterval={setIntervalValue}
            title={selected?.display ?? '—'}
            livePrice={livePrice}
            simple={simple}
          />

          <div className="panel flex h-[15.5rem] min-h-0 flex-col">
            <Tabs
              tabs={['positionen', 'orders', 'auswertung'] as const}
              active={mainPanel}
              onChange={setMainPanel}
              labels={MAIN_LABELS}
            />
            <div className="min-h-0 flex-1 [&>*]:h-full [&>*]:rounded-none [&>*]:border-0">
              {mainPanel === 'positionen' ? (
                <Positions portfolio={portfolio} onClose={closePosition} />
              ) : null}
              {mainPanel === 'orders' ? (
                <OpenOrders
                  orders={portfolio?.orders ?? []}
                  onChanged={() => quiet(loadPortfolio())}
                />
              ) : null}
              {mainPanel === 'auswertung' ? <StatsPanel leagueId={leagueId} /> : null}
            </div>
          </div>
        </div>

        <div className="flex w-[20rem] shrink-0 flex-col gap-2">
          <Ticket
            leagueId={leagueId}
            instrument={selected}
            portfolio={portfolio}
            onDone={() => {
              quiet(loadPortfolio());
              quiet(loadBoard());
              quiet(loadFeed());
              quiet(loadDesk());
            }}
            simple={simple}
          />

          <div className="panel flex min-h-0 flex-1 flex-col">
            <Tabs tabs={sideTabs} active={sidePanel} onChange={setSidePanel} labels={SIDE_LABELS} />
            <div className="min-h-0 flex-1 [&>*]:h-full [&>*]:rounded-none [&>*]:border-0">
              {sidePanelContent}
            </div>
          </div>
        </div>
      </div>

      {/* Mobil */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 lg:hidden">
        {mobileTab === 'chart' ? (
          <>
            <select
              className="input shrink-0"
              value={selectedId ?? ''}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {instruments.map((instrument) => (
                <option key={instrument.id} value={instrument.id}>
                  {instrument.display}
                </option>
              ))}
            </select>
            <Chart
              candles={candles}
              interval={interval}
              onInterval={setIntervalValue}
              title={selected?.display ?? '—'}
              livePrice={livePrice}
              simple={simple}
            />
          </>
        ) : null}

        {mobileTab === 'order' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Ticket
              leagueId={leagueId}
              instrument={selected}
              portfolio={portfolio}
              onDone={() => {
                quiet(loadPortfolio());
                quiet(loadBoard());
              }}
              simple={simple}
            />
          </div>
        ) : null}

        {mobileTab === 'depot' ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="min-h-0 flex-1">
              <Positions portfolio={portfolio} onClose={closePosition} />
            </div>
            <div className="min-h-0 flex-1">
              <OpenOrders
                orders={portfolio?.orders ?? []}
                onChanged={() => quiet(loadPortfolio())}
              />
            </div>
          </div>
        ) : null}

        {mobileTab === 'liga' ? (
          <div className="panel flex min-h-0 flex-1 flex-col">
            <Tabs tabs={sideTabs} active={sidePanel} onChange={setSidePanel} labels={SIDE_LABELS} />
            <div className="min-h-0 flex-1 [&>*]:h-full [&>*]:rounded-none [&>*]:border-0">
              {sidePanelContent}
            </div>
          </div>
        ) : null}

        <nav className="grid shrink-0 grid-cols-4 gap-1 border-t border-[var(--color-hairline)] pt-2">
          {(
            [
              ['chart', 'candles', 'Chart'],
              ['order', 'zap', 'Handeln'],
              ['depot', 'wallet', 'Depot'],
              ['liga', 'trophy', 'Liga'],
            ] as const
          ).map(([key, icon, label]) => (
            <button
              key={key}
              onClick={() => setMobileTab(key)}
              className={`flex flex-col items-center gap-1 rounded-[var(--radius)] py-1.5 text-[12px] transition ${
                mobileTab === key
                  ? 'bg-[var(--color-raised)] text-[var(--color-fg)]'
                  : 'text-[var(--color-fg-3)]'
              }`}
            >
              <Icon name={icon} size={15} />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {showTutorial ? (
        <Onboarding
          onClose={() => {
            localStorage.setItem('ta_tutorial_done', '1');
            setShowTutorial(false);
          }}
        />
      ) : null}
    </div>
  );
}
