/**
 * Ikonografie.
 *
 * Ein eigener Satz statt Emojis. Emojis sehen auf jedem Betriebssystem
 * anders aus, springen aus dem Textfluss und lassen jede Oberflaeche
 * beliebig wirken. Diese Glyphen teilen sich ein 16er-Raster, 1,5 px
 * Strichstaerke, runde Enden - und uebernehmen die Textfarbe.
 */

export type IconName =
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'trend-up'
  | 'trend-down'
  | 'candles'
  | 'wallet'
  | 'list'
  | 'gauge'
  | 'trophy'
  | 'users'
  | 'message'
  | 'coin'
  | 'cpu'
  | 'zap'
  | 'shield'
  | 'hourglass'
  | 'lock'
  | 'unlock'
  | 'alert'
  | 'octagon'
  | 'scissors'
  | 'target'
  | 'diamond'
  | 'page'
  | 'wave'
  | 'droplet'
  | 'bear'
  | 'bag'
  | 'run'
  | 'stone'
  | 'dice'
  | 'scale'
  | 'plus'
  | 'x'
  | 'check'
  | 'copy'
  | 'link'
  | 'volume-on'
  | 'volume-off'
  | 'power'
  | 'pause'
  | 'play'
  | 'clock'
  | 'search'
  | 'chevron-right'
  | 'chevron-down'
  | 'sliders'
  | 'flag'
  | 'star'
  | 'eye-off'
  | 'grave'
  | 'medal';

const PATHS: Record<IconName, string> = {
  'arrow-up': 'M8 13V3M8 3 4 7M8 3l4 4',
  'arrow-down': 'M8 3v10M8 13l4-4M8 13l-4-4',
  'arrow-left': 'M13 8H3M3 8l4-4M3 8l4 4',
  'trend-up': 'M2 11.5 6 7.5l2.5 2.5L14 4.5M14 4.5H10M14 4.5v4',
  'trend-down': 'M2 4.5 6 8.5l2.5-2.5L14 11.5M14 11.5H10M14 11.5v-4',
  candles: 'M4 3v10M4 5.5h0M2.5 5.5h3v5h-3zM11 2v12M9.5 5h3v6h-3z',
  wallet: 'M2 5.5A1.5 1.5 0 0 1 3.5 4h9A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5zM2 7h12M11 10h1',
  list: 'M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01',
  gauge: 'M2.5 12a6 6 0 1 1 11 0M8 12 11 6',
  trophy: 'M5 3h6v3a3 3 0 0 1-6 0zM5 4H3.5v1A2.5 2.5 0 0 0 5 7.3M11 4h1.5v1A2.5 2.5 0 0 1 11 7.3M6.5 9v2.5h3V9M5.5 13.5h5',
  users: 'M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM2 13.5c0-2 1.8-3.5 4-3.5s4 1.5 4 3.5M10.5 4.2a2.25 2.25 0 0 1 0 4.1M11.5 10.4c1.5.5 2.5 1.7 2.5 3.1',
  message: 'M2.5 4.5A1.5 1.5 0 0 1 4 3h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 11H6.5L3.5 13.5V11A1.5 1.5 0 0 1 2.5 9.5z',
  coin: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM9.8 6.2c-.4-.5-1-.8-1.8-.8-1.1 0-1.8.5-1.8 1.3 0 1.9 3.8.8 3.8 2.8 0 .9-.8 1.4-2 1.4-.9 0-1.5-.3-2-.9M8 4.3v7.4',
  cpu: 'M4.5 4.5h7v7h-7zM6.5 6.5h3v3h-3zM6 2.5v2M10 2.5v2M6 11.5v2M10 11.5v2M2.5 6h2M2.5 10h2M11.5 6h2M11.5 10h2',
  zap: 'M9 2 3.5 9H7.5l-.5 5L12.5 7H8.5z',
  shield: 'M8 2 3 4v4c0 3 2.2 5.3 5 6 2.8-.7 5-3 5-6V4z',
  hourglass: 'M4 2.5h8M4 13.5h8M4.5 2.5v2.2c0 1 .6 1.9 1.5 2.4L8 8l2-.9c.9-.5 1.5-1.4 1.5-2.4V2.5M4.5 13.5v-2.2c0-1 .6-1.9 1.5-2.4L8 8l2 .9c.9.5 1.5 1.4 1.5 2.4v2.2',
  lock: 'M4 7.5h8v6H4zM5.8 7.5V5.3a2.2 2.2 0 0 1 4.4 0v2.2',
  unlock: 'M4 7.5h8v6H4zM5.8 7.5V5.3a2.2 2.2 0 0 1 4.3-.6',
  alert: 'M8 2.5 1.8 13h12.4zM8 6.5v3M8 11.3h.01',
  octagon: 'M5.4 2h5.2L14 5.4v5.2L10.6 14H5.4L2 10.6V5.4zM8 5v3.5M8 10.8h.01',
  scissors: 'M4.2 4.2 11.5 11.5M11.5 4.2 7.4 8.3M4.2 11.5l1.7-1.7M4 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM4 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  target: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 9.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z',
  diamond: 'M4 2.5h8l2 3.2L8 14 2 5.7zM2 5.7h12M6 2.5 4.5 5.7 8 14M10 2.5l1.5 3.2L8 14',
  page: 'M4 2h5l3 3v9H4zM9 2v3h3M6 8.5h4M6 11h4',
  wave: 'M1.5 9.5c1.6 0 1.6-4 3.2-4s1.6 4 3.2 4 1.6-4 3.2-4 1.6 4 3.2 4',
  droplet: 'M8 2.2c2.4 2.6 3.8 4.5 3.8 6.3a3.8 3.8 0 1 1-7.6 0c0-1.8 1.4-3.7 3.8-6.3Z',
  bear: 'M3.5 6.5a2 2 0 1 1 1.3-3.5M12.5 6.5a2 2 0 1 0-1.3-3.5M8 13.5c2.8 0 4.8-2 4.8-4.5S10.8 4.5 8 4.5 3.2 6.5 3.2 9s2 4.5 4.8 4.5ZM6.4 8.4h.01M9.6 8.4h.01M6.8 11h2.4',
  bag: 'M3.5 5.5h9l1 8h-11zM6 5.5V4a2 2 0 0 1 4 0v1.5',
  run: 'M9.5 3.6a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2ZM4 14l2.2-3.4L5 8.2 3 9.5M6.2 10.6 9 9l1-3.5L7 6.4 5.5 8M10 5.5l2 1.6.8 2.4',
  stone: 'M3 7.5 5.5 3.5h5L13 7.5 8 13.5zM3 7.5h10M5.5 3.5 8 7.5l2.5-4M8 7.5v6',
  dice: 'M2.5 4.2 8 1.8l5.5 2.4v7.6L8 14.2 2.5 11.8zM8 6.6l-2-.9M8 6.6l2-.9M8 6.6v3.6',
  scale: 'M8 2.5v11M4 4.5h8M4.5 4.5 2.5 9h4zM11.5 4.5 9.5 9h4zM5.5 13.5h5',
  plus: 'M8 3.5v9M3.5 8h9',
  x: 'M4 4l8 8M12 4l-8 8',
  check: 'M3 8.5 6.5 12 13 4.5',
  copy: 'M5.5 5.5h7v8h-7zM3.5 10.5h-1v-8h7v1',
  link: 'M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-1 1M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l1-1',
  'volume-on': 'M3 6.2h2.3L8.5 3.5v9L5.3 9.8H3zM11 6a3 3 0 0 1 0 4M12.8 4.2a5.5 5.5 0 0 1 0 7.6',
  'volume-off': 'M3 6.2h2.3L8.5 3.5v9L5.3 9.8H3zM11 6.5l3 3M14 6.5l-3 3',
  power: 'M8 2.5v5.5M4.8 4.6a4.8 4.8 0 1 0 6.4 0',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  play: 'M5 3.2 12.5 8 5 12.8z',
  clock: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 4.8V8l2.2 1.6',
  search: 'M7.2 12.4a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4ZM11 11l3 3',
  'chevron-right': 'M6 3.5 10.5 8 6 12.5',
  'chevron-down': 'M3.5 6 8 10.5 12.5 6',
  sliders: 'M2.5 5h5M10.5 5h3M2.5 11h3M8.5 11h5M9 3v4M6 9v4',
  flag: 'M4 14V2.5M4 3.2h8l-1.6 2.6L12 8.4H4',
  star: 'M8 2 9.9 6.1l4.1.5-3 2.9.8 4.5L8 11.8 4.2 14l.8-4.5-3-2.9 4.1-.5z',
  'eye-off': 'M6.3 6.4a2.2 2.2 0 0 0 3.1 3.1M4.2 4.4C2.7 5.4 1.6 6.8 1.2 8c1 2.6 3.6 4.4 6.8 4.4 1.1 0 2.1-.2 3-.6M11.4 11c1.6-.9 2.9-2.3 3.4-3.6-1-2.6-3.6-4.4-6.8-4.4-.7 0-1.3.1-1.9.2M2 2l12 12',
  grave: 'M4.5 14V6a3.5 3.5 0 1 1 7 0v8zM6.5 6.5h3M8 6.5V10M3 14h10',
  medal: 'M8 10.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM5.5 1.5 7 4.3M10.5 1.5 9 4.3M6.4 10.2 5.5 14.5 8 13.2l2.5 1.3-.9-4.3',
};

export function Icon({
  name,
  size = 16,
  className,
  strokeWidth = 1.5,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Welches Glyph gehoert zu welchem Achievement. */
export const ACHIEVEMENT_ICONS: Record<string, IconName> = {
  first_blood: 'target',
  diamond_hands: 'diamond',
  paper_hands: 'page',
  sniper: 'target',
  liquidated: 'octagon',
  ten_bagger: 'trend-up',
  round_trip: 'wave',
  whale: 'droplet',
  short_seller: 'bear',
  rugger: 'scissors',
  bagholder: 'bag',
  exit_liquidity: 'run',
  coin_creator: 'coin',
  bot_owner: 'cpu',
  bot_beats_you: 'grave',
  comeback: 'trend-up',
  league_winner: 'trophy',
  survivor: 'shield',
  iron_hand: 'stone',
  overtrader: 'dice',
};

/** Welches Glyph gehoert zu welchem Feed-Ereignis. */
export const FEED_ICONS: Record<string, IconName> = {
  trade: 'candles',
  coin_launch: 'coin',
  rugpull: 'scissors',
  liquidation: 'octagon',
  eliminated: 'grave',
  achievement: 'medal',
  bot: 'cpu',
  bot_hired: 'cpu',
  bet: 'dice',
  bet_resolved: 'scale',
  join: 'users',
  league_end: 'flag',
};

export const MODE_ICONS: Record<string, IconName> = {
  classic: 'candles',
  feierabend: 'clock',
  blitz: 'zap',
  survival: 'shield',
  timemachine: 'hourglass',
};
