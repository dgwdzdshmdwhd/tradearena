import { useCallback, useEffect, useState } from 'react';

import { navigate } from '../App.js';
import { ACHIEVEMENT_ICONS, Icon } from '../components/Icon.js';
import { Tabs } from '../components/Ui.js';
import { ApiError, api, quiet, type Achievement, type Me, type Upgrade } from '../lib/api.js';
import { sounds } from '../lib/sound.js';
import { pushToast } from '../lib/toast.js';

const BRANCH_LABELS: Record<string, string> = {
  broker: 'Broker',
  research: 'Research',
  bots: 'Bot-Abteilung',
  launchpad: 'Launchpad',
  treasury: 'Treasury',
  office: 'Buero',
};

const TIER_COLOR: Record<string, string> = {
  bronze: 'var(--color-fg-2)',
  silber: 'var(--color-fg)',
  gold: 'var(--color-accent)',
  schande: 'var(--color-down)',
};

export function Desk({ me, onRefresh }: { me: Me; onRefresh: () => void }): JSX.Element {
  const [upgrades, setUpgrades] = useState<Upgrade[]>([]);
  const [prestige, setPrestige] = useState(me.prestige);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [tab, setTab] = useState<'upgrades' | 'trophaeen'>('upgrades');

  const load = useCallback(async () => {
    const [upgradeData, achievementData] = await Promise.all([
      api.get<{ prestige: number; upgrades: Upgrade[] }>('/api/upgrades'),
      api.get<{ achievements: Achievement[] }>('/api/achievements'),
    ]);
    setUpgrades(upgradeData.upgrades);
    setPrestige(upgradeData.prestige);
    setAchievements(achievementData.achievements);
  }, []);

  useEffect(() => {
    quiet(load());
  }, [load]);

  const buy = async (key: string): Promise<void> => {
    try {
      await api.post(`/api/upgrades/${key}/buy`);
      sounds.achievement();
      await load();
      onRefresh();
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Kauf nicht moeglich',
        body: error instanceof ApiError ? error.message : 'Unbekannter Fehler',
      });
    }
  };

  const branches = [...new Set(upgrades.map((upgrade) => upgrade.branch))];
  const unlocked = achievements.filter((achievement) => achievement.unlockedAt !== null);

  return (
    <div className="mx-auto max-w-[54rem] px-5 pb-20 pt-5">
      <header className="mb-6 flex items-center justify-between gap-3">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>
          <Icon name="arrow-left" size={13} />
          Lobby
        </button>

        <div className="text-right">
          <div className="text-[12.5px] font-medium">{me.rank.title}</div>
          <div className="dimmer num text-[11px]">{prestige} Prestige verfuegbar</div>
        </div>
      </header>

      <div className="mb-5">
        <h1 className="text-[17px] font-medium">Trading-Desk</h1>
        <p className="dim mt-1.5 max-w-[40rem] text-[12.5px] leading-relaxed">
          Prestige verdienst du mit Platzierungen, Volumen und Achievements. Es laesst sich nicht in
          Spielgeld umwandeln — und in Wettkampf-Ligen wirken Upgrades gar nicht. Dort handeln alle
          zu identischen Konditionen.
        </p>
      </div>

      {me.nextRank ? (
        <div className="panel mb-6 p-3">
          <div className="mb-2 flex justify-between text-[11px]">
            <span className="dimmer">naechster Rang · {me.nextRank.title}</span>
            <span className="num dimmer">
              {me.lifetimePrestige} / {me.nextRank.minPrestige}
            </span>
          </div>
          <div className="meter">
            <i
              style={{
                width: `${Math.min(100, (me.lifetimePrestige / me.nextRank.minPrestige) * 100)}%`,
              }}
            />
          </div>
        </div>
      ) : null}

      <div className="mb-4">
        <Tabs
          tabs={['upgrades', 'trophaeen'] as const}
          active={tab}
          onChange={setTab}
          labels={{
            upgrades: 'Ausbau',
            trophaeen: `Trophaeen ${unlocked.length}/${achievements.length}`,
          }}
        />
      </div>

      {tab === 'upgrades'
        ? branches.map((branch) => (
            <section key={branch} className="mb-5">
              <h2 className="stat-label mb-2">{BRANCH_LABELS[branch] ?? branch}</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {upgrades
                  .filter((upgrade) => upgrade.branch === branch)
                  .map((upgrade) => {
                    const maxed = upgrade.level >= upgrade.maxLevel;
                    const affordable = upgrade.nextCost !== null && prestige >= upgrade.nextCost;

                    return (
                      <div key={upgrade.key} className="panel p-3">
                        <div className="mb-2 flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[12.5px] font-medium">{upgrade.name}</div>
                            <p className="dimmer mt-0.5 text-[11px] leading-snug">
                              {upgrade.description}
                            </p>
                          </div>
                          <span className="num dimmer shrink-0 text-[11px]">
                            {upgrade.level}/{upgrade.maxLevel}
                          </span>
                        </div>

                        <div className="mb-2 flex gap-1">
                          {Array.from({ length: upgrade.maxLevel }, (_, index) => (
                            <span
                              key={index}
                              className="h-[3px] flex-1 rounded-full"
                              style={{
                                background:
                                  index < upgrade.level
                                    ? 'var(--color-accent)'
                                    : 'var(--color-raised)',
                              }}
                            />
                          ))}
                        </div>

                        <button
                          className={`btn btn-sm w-full ${affordable && !maxed ? 'btn-primary' : ''}`}
                          disabled={maxed || !affordable}
                          onClick={() => void buy(upgrade.key)}
                        >
                          {maxed ? 'voll ausgebaut' : `ausbauen · ${upgrade.nextCost} Prestige`}
                        </button>
                      </div>
                    );
                  })}
              </div>
            </section>
          ))
        : null}

      {tab === 'trophaeen' ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {achievements.map((achievement) => {
            const done = achievement.unlockedAt !== null;
            const color = TIER_COLOR[achievement.tier] ?? 'var(--color-fg-2)';

            return (
              <div
                key={achievement.key}
                className="panel flex items-start gap-2.5 p-3"
                style={{
                  opacity: done ? 1 : 0.45,
                  borderColor: done
                    ? `color-mix(in srgb, ${color} 35%, var(--color-hairline))`
                    : undefined,
                }}
              >
                <span className="mt-0.5" style={{ color: done ? color : 'var(--color-fg-3)' }}>
                  <Icon
                    name={done ? (ACHIEVEMENT_ICONS[achievement.key] ?? 'medal') : 'lock'}
                    size={16}
                  />
                </span>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium">{achievement.name}</div>
                  <p className="dimmer text-[11px] leading-snug">{achievement.description}</p>
                  {achievement.prestige > 0 ? (
                    <div className="num accent mt-1 text-[10.5px]">
                      +{achievement.prestige} Prestige
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
