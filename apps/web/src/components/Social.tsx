import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { ChatMessage, FeedEvent } from '../lib/api.js';
import { fmtPrice, fmtQty, fmtTime, fmtUsd } from '../lib/format.js';
import { FEED_ICONS, Icon, type IconName } from './Icon.js';
import { Avatar, Empty } from './Ui.js';

/**
 * Reaktionen.
 *
 * Statt Emojis ein kleiner, benannter Satz - die fuenf Dinge, die man einem
 * fremden Trade tatsaechlich entgegenschleudern will. Gespeichert wird der
 * Schluessel, gezeichnet wird ein Glyph.
 */
const REACTIONS: ReadonlyArray<{ key: string; icon: IconName; label: string }> = [
  { key: 'bull', icon: 'trend-up', label: 'stark' },
  { key: 'bear', icon: 'trend-down', label: 'geht schief' },
  { key: 'star', icon: 'star', label: 'Respekt' },
  { key: 'brutal', icon: 'octagon', label: 'brutal' },
  { key: 'doubt', icon: 'eye-off', label: 'glaub ich nicht' },
];

const REACTION_BY_KEY = new Map(REACTIONS.map((reaction) => [reaction.key, reaction]));

export function Feed({
  events,
  onReact,
  meUserId,
}: {
  events: FeedEvent[];
  onReact: (id: string, key: string) => void;
  meUserId: string;
}): JSX.Element {
  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="panel-head">
        <span>Feed</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <Empty icon="list" title="Noch still hier">
            Sobald jemand handelt, steht es hier.
          </Empty>
        ) : null}

        {events.map((event) => {
          const described = describe(event);

          return (
            <div
              key={event.id}
              className="enter border-b border-[var(--color-hairline)] px-2.5 py-2 last:border-0"
            >
              <div className="flex items-start gap-2.5">
                <span className={`mt-0.5 ${described.tone ?? 'dimmer'}`}>
                  <Icon name={described.icon ?? FEED_ICONS[event.kind] ?? 'list'} size={14} />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] leading-snug">{described.text}</div>

                  <div className="mt-1 flex items-center gap-2">
                    <span className="dimmer num text-[10.5px]">{fmtTime(event.createdAt)}</span>

                    {REACTIONS.map((reaction) => {
                      const count = event.reactions.filter((r) => r.emoji === reaction.key).length;
                      if (count === 0) return null;
                      const mine = event.reactions.some(
                        (r) => r.emoji === reaction.key && r.userId === meUserId,
                      );

                      return (
                        <button
                          key={reaction.key}
                          onClick={() => onReact(event.id, reaction.key)}
                          title={reaction.label}
                          className={`flex items-center gap-0.5 rounded-[4px] border px-1 py-px text-[10.5px] transition ${
                            mine
                              ? 'border-[var(--color-border)] bg-[var(--color-raised)] text-[var(--color-fg)]'
                              : 'border-transparent text-[var(--color-fg-3)] hover:text-[var(--color-fg-2)]'
                          }`}
                        >
                          <Icon name={reaction.icon} size={11} />
                          <span className="num">{count}</span>
                        </button>
                      );
                    })}

                    <ReactionPicker onPick={(key) => onReact(event.id, key)} />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReactionPicker({ onPick }: { onPick: (key: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  return (
    <span className="relative">
      <button
        className="text-[var(--color-fg-3)] transition hover:text-[var(--color-fg)]"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
        title="reagieren"
      >
        <Icon name="plus" size={11} />
      </button>

      {open ? (
        <span className="panel absolute bottom-5 left-0 z-10 flex gap-px p-1 shadow-xl">
          {REACTIONS.map((reaction) => (
            <button
              key={reaction.key}
              title={reaction.label}
              className="rounded-[4px] p-1 text-[var(--color-fg-2)] transition hover:bg-[var(--color-raised)] hover:text-[var(--color-fg)]"
              onClick={(event) => {
                event.stopPropagation();
                onPick(reaction.key);
                setOpen(false);
              }}
            >
              <Icon name={reaction.icon} size={13} />
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** Aus einem Ereignis einen Satz machen, den man gern liest. */
function describe(event: FeedEvent): { text: ReactNode; tone?: string; icon?: IconName } {
  const payload = event.payload as Record<string, string | number | null>;
  const who = event.username ?? 'Jemand';

  switch (event.kind) {
    case 'trade': {
      const buy = payload.side === 'buy';
      const realized = Number(payload.realizedCents ?? 0);

      return {
        /*
         * Wurde ein Trade geschlossen, zaehlt das Ergebnis - nicht die
         * Richtung. Ein roter Pfeil neben einem gruenen Plus liest sich
         * widerspruechlich: "Verkauf" ist keine schlechte Nachricht, wenn
         * Gewinn dabei herauskommt.
         */
        tone: realized !== 0 ? (realized > 0 ? 'up' : 'down') : 'dim',
        icon: buy ? 'arrow-up' : 'arrow-down',
        text: (
          <>
            <b className="font-medium">{who}</b> {buy ? 'kauft' : 'verkauft'}{' '}
            <span className="num">{fmtQty(String(payload.qty ?? '0'))}</span>{' '}
            {String(payload.display ?? '')} zu{' '}
            <span className="num">{fmtPrice(String(payload.price ?? '0'))} $</span>
            {realized !== 0 ? (
              <span className={realized > 0 ? 'up' : 'down'}>
                {' '}
                {fmtUsd(String(realized), true)}
              </span>
            ) : null}
            {payload.source === 'bot' ? <span className="dimmer"> · Bot</span> : null}
          </>
        ),
      };
    }

    case 'coin_launch':
      return {
        tone: 'accent',
        text: (
          <>
            <b className="font-medium">{who}</b> startet{' '}
            <b className="num font-medium">{String(payload.ticker)}</b> mit{' '}
            {fmtUsd(String(payload.liquidityCents ?? '0'))} Liquiditaet
            {payload.lockUntil ? ', gesperrt' : ', nicht gesperrt'}.
          </>
        ),
      };

    case 'rugpull':
      return {
        tone: 'down',
        text: (
          <>
            <b className="down font-medium">{who} zieht die Liquiditaet aus {String(payload.ticker)}.</b>{' '}
            {fmtUsd(String(payload.amountCents ?? '0'))} abgezogen, Kurs von{' '}
            <span className="num">{fmtPrice(String(payload.priceBefore ?? '0'))}</span> auf{' '}
            <span className="num">{fmtPrice(String(payload.priceAfter ?? '0'))}</span>.{' '}
            {Number(payload.holders ?? 0)} halten den Coin noch.
          </>
        ),
      };

    case 'liquidation':
      return {
        tone: 'down',
        text: (
          <>
            <b className="font-medium">{who}</b> wurde liquidiert —{' '}
            {String(payload.display ?? '')} zwangsweise geschlossen.
          </>
        ),
      };

    case 'eliminated':
      return {
        tone: 'down',
        text: (
          <>
            <b className="font-medium">{who}</b> ist ausgeschieden mit{' '}
            {fmtUsd(String(payload.equityCents ?? '0'))}.
          </>
        ),
      };

    case 'achievement':
      return {
        tone: 'accent',
        text: (
          <>
            <b className="font-medium">{who}</b> schaltet{' '}
            <b className="font-medium">{String(payload.name ?? '')}</b> frei.
          </>
        ),
      };

    case 'bot':
      return {
        tone: payload.mistake ? 'down' : 'dim',
        text: (
          <>
            <b className="num font-medium">{String(payload.name ?? 'Bot')}</b>{' '}
            <span className="dimmer">({who})</span>{' '}
            {payload.mistake ? (
              <span className="down">{String(payload.reason)}</span>
            ) : (
              String(payload.reason)
            )}
          </>
        ),
      };

    case 'bot_hired':
      return {
        text: (
          <>
            <b className="font-medium">{who}</b> stellt{' '}
            <b className="num font-medium">{String(payload.name)}</b> ein —{' '}
            {String(payload.strategy)}, {fmtUsd(String(payload.budgetCents ?? '0'))} Budget.
          </>
        ),
      };

    case 'bet':
      return {
        text: (
          <>
            <b className="font-medium">{who}</b> behauptet: „{String(payload.text ?? '')}" ·{' '}
            {fmtUsd(String(payload.stakeCents ?? '0'))}
          </>
        ),
      };

    case 'bet_resolved':
      return {
        tone: 'accent',
        text: (
          <>
            Wette entschieden: „{String(payload.text ?? '')}" —{' '}
            <b className="font-medium">
              {payload.outcome === 'for' ? 'Behauptung stimmte' : 'Dagegenhalter gewinnen'}
            </b>
            . Topf {fmtUsd(String(payload.potCents ?? '0'))}.
          </>
        ),
      };

    case 'join':
      return {
        text: (
          <>
            <b className="font-medium">{String(payload.username ?? who)}</b> ist dabei.
          </>
        ),
      };

    case 'league_end':
      return {
        tone: 'accent',
        text: (
          <>
            <b className="font-medium">Die Liga ist vorbei.</b>
            {payload.reveal ? <span className="dim"> {String(payload.reveal)}</span> : null}
          </>
        ),
      };

    default:
      return { text: <>{event.kind}</> };
  }
}

export function Chat({
  messages,
  onSend,
  meUserId,
}: {
  messages: ChatMessage[];
  onSend: (body: string) => void;
  meUserId: string;
}): JSX.Element {
  const [text, setText] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = (): void => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
  };

  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="panel-head">
        <span>Chat</span>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
        {messages.length === 0 ? <Empty icon="message" title="Noch nichts gesagt" /> : null}

        {messages.map((message) => (
          <div key={message.id} className="flex items-start gap-2">
            <Avatar name={message.username} id={message.user_id} size={20} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span
                  className={`text-[12px] font-medium ${
                    message.user_id === meUserId ? 'accent' : ''
                  }`}
                >
                  {message.username}
                </span>
                <span className="dimmer num text-[10px]">{fmtTime(message.created_at)}</span>
              </div>
              <div className="break-words text-[12.5px] leading-snug">{message.body}</div>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <div className="flex gap-1.5 border-t border-[var(--color-hairline)] p-2">
        <input
          className="input"
          value={text}
          placeholder="Nachricht"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') send();
          }}
        />
        <button className="btn btn-sm px-2" onClick={send} disabled={!text.trim()}>
          <Icon name="chevron-right" size={13} />
        </button>
      </div>
    </div>
  );
}

export { REACTION_BY_KEY };
