/**
 * The lobby. Balance, games, and the choice of entry.
 *
 * ── Practice is offered first ────────────────────────────────────────────────
 *
 * Every game can be played for nothing, and that button sits above the paid
 * ones. Partly because Section 1 of the brief is the game on its own and it has
 * to be playable without money existing — but mostly because a player who has
 * never seen Chicken Run cannot judge whether a target of 14 is a fair ask. The
 * target engine calibrates on real scores; sending someone into a paid round
 * before they know the controls produces a bad number for them and a bad datum
 * for us.
 *
 * ── The stake tiers come from the server ─────────────────────────────────────
 *
 * They are read from listGames, which reads the active config. If the tiers are
 * retuned in the database, this screen changes with no rebuild — which is the
 * brief's requirement, and not something a hard-coded array can satisfy.
 */

import React from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { Button, Card, ErrorNote, Label, Txt } from '../ui/components';
import { colors, radius, space } from '../ui/theme';
import { money, stakeHint } from '../api/format';
import type { Game, Profile } from '../api/types';
import type { FeedbackSettings } from '../api/settings';
import type { GameId } from '../unity/protocol';

interface Props {
  profile: Profile | null;
  games: Game[];
  busy: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  onPractice: (gameId: GameId) => void;
  onQuote: (gameId: GameId, stakeCents: number) => void;
  onDeposit: () => void;
  feedback: FeedbackSettings;
  onFeedbackChange: (next: FeedbackSettings) => void;
}

export default function LobbyScreen({
  profile,
  games,
  busy,
  refreshing,
  error,
  onRefresh,
  onPractice,
  onQuote,
  onDeposit,
  feedback,
  onFeedbackChange,
}: Props) {
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.scroll}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textMuted} />
      }
    >
      <Card>
        <Label>Balance</Label>
        <View style={styles.balanceRow}>
          <Txt variant="hero">{money(profile?.balanceCents ?? 0)}</Txt>
          <Button title="+ $10" tone="quiet" onPress={onDeposit} style={styles.depositButton} />
        </View>
        <Txt variant="small" color={colors.textFaint} style={styles.balanceNote}>
          Mock funds. Every movement is a ledger entry — nothing writes a balance
          directly, including this button.
        </Txt>
      </Card>

      <ErrorNote message={error} />

      <Card style={styles.settings}>
        <Label>Feedback</Label>
        <Toggle
          label="Sound"
          value={feedback.sound}
          onChange={(sound) => onFeedbackChange({ ...feedback, sound })}
        />
        <Toggle
          label="Vibration"
          value={feedback.haptics}
          onChange={(haptics) => onFeedbackChange({ ...feedback, haptics })}
        />
      </Card>

      {games.map((game) => {
        const stats = profile?.profiles.find((p) => p.game_id === game.game_id);
        return (
          <Card key={game.game_id} style={styles.gameCard}>
            <View style={styles.gameHeader}>
              <Txt variant="title">{game.display_name}</Txt>
              {stats ? (
                <View style={styles.stats}>
                  <Txt variant="small" color={colors.textFaint}>
                    best {stats.best_score ?? 0} · {stats.rounds_played} rounds
                  </Txt>
                </View>
              ) : null}
            </View>

            <Button
              title="Practice"
              subtitle="free, no entry"
              tone="quiet"
              onPress={() => onPractice(game.game_id)}
              disabled={busy}
            />

            {game.blitz_enabled ? (
              <View style={styles.blitz}>
                <Label>Blitz entry</Label>
                <View style={styles.tiers}>
                  {game.stakeTiersCents.map((cents) => {
                    const overBootstrapCap =
                      isBootstrapping(stats) &&
                      game.bootstrapMaxStakeCents !== null &&
                      cents > game.bootstrapMaxStakeCents;
                    const unaffordable = (profile?.balanceCents ?? 0) < cents;

                    return (
                      <Button
                        key={cents}
                        title={money(cents)}
                        onPress={() => onQuote(game.game_id, cents)}
                        // Disabled rather than hidden: a player should be able to
                        // see the entry that exists and why it is not available
                        // to them yet, not wonder where it went.
                        disabled={busy || unaffordable || overBootstrapCap}
                        style={styles.tier}
                      />
                    );
                  })}
                </View>
                {isBootstrapping(stats) && game.bootstrapMaxStakeCents !== null ? (
                  <Txt variant="small" color={colors.textFaint}>
                    Capped at {money(game.bootstrapMaxStakeCents)} until we have seen
                    you play a few rounds.
                  </Txt>
                ) : null}
                <StakeHint
                  balanceCents={profile?.balanceCents ?? 0}
                  tiersCents={game.stakeTiersCents}
                  capCents={isBootstrapping(stats) ? game.bootstrapMaxStakeCents : null}
                />
              </View>
            ) : (
              <Txt variant="small" color={colors.textFaint}>
                Practice only for now.
              </Txt>
            )}
          </Card>
        );
      })}
    </ScrollView>
  );
}

/** The reason, if any, that a stake is greyed out for lack of money. */
function StakeHint({
  balanceCents,
  tiersCents,
  capCents,
}: {
  balanceCents: number;
  tiersCents: number[];
  capCents: number | null;
}) {
  const hint = stakeHint(balanceCents, tiersCents, capCents);
  return hint ? (
    <Txt variant="small" color={colors.textFaint}>
      {hint}
    </Txt>
  ) : null;
}

/**
 * A labelled switch.
 *
 * The whole row is pressable, not just the switch. A 51x31pt control is under
 * the 44pt minimum on one axis, and a mis-tap that silently does nothing is how
 * a settings screen earns the reputation of being broken.
 */
function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      style={styles.toggleRow}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
    >
      <Txt variant="body" color={colors.text}>
        {label}
      </Txt>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.surfaceHigh, true: colors.accent }}
        thumbColor={colors.text}
      />
    </Pressable>
  );
}

/**
 * Whether the target engine is still calibrating for this player.
 *
 * A guess, and labelled as one: the authoritative answer is `bootstrap` on the
 * quote, which the server computes from a lifetime counter this endpoint does
 * not return. Used only to grey out tiers the server would refuse — being wrong
 * here shows a cap message a round early, never a charge.
 */
function isBootstrapping(stats?: { rounds_played: number }): boolean {
  return !stats || stats.rounds_played < 5;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl },
  balanceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  depositButton: { minHeight: 44, paddingHorizontal: space.lg },
  balanceNote: { marginTop: space.sm, lineHeight: 18 },
  settings: { gap: space.xs, paddingVertical: space.md },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  gameCard: { gap: space.md },
  gameHeader: { gap: space.xs },
  stats: { flexDirection: 'row', gap: space.sm },
  blitz: { gap: space.sm, marginTop: space.xs },
  tiers: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tier: { flexGrow: 1, minWidth: 78, minHeight: 48, borderRadius: radius.sm },
});
