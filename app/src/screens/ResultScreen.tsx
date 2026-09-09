/**
 * The result screen. Every number on it came from the server.
 *
 * ── The score shown is the REPLAYED score ────────────────────────────────────
 *
 * Not the one Unity reported. The server re-simulated the input trace against
 * the seed it issued and computed the score itself; that is what it paid on, so
 * that is what is displayed. When the two disagree, the game's number is the
 * one that is wrong, and showing it would be lying to the player about what they
 * were paid for.
 *
 * ── Why the settle reason is visible ─────────────────────────────────────────
 *
 * A round can be settled by the player submitting, by the sweeper picking it up
 * after the app was killed, or by the server refusing an unreadable trace. Those
 * pay differently, and a player who is shown a smaller number than they expected
 * deserves to be told which of the three happened. Hiding it would make the
 * honest cases look like the dishonest one.
 */

import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Card, Label, Txt } from '../ui/components';
import { colors, space } from '../ui/theme';
import { money, multiplier } from '../api/format';
import type { Settlement } from '../api/types';

interface Props {
  settlement: Settlement;
  gameName: string;
  busy: boolean;
  onPlayAgain: () => void;
  onBack: () => void;
}

export default function ResultScreen({
  settlement,
  gameName,
  busy,
  onPlayAgain,
  onBack,
}: Props) {
  const net = settlement.netCents ?? settlement.payoutCents - settlement.stakeCents;
  const won = net > 0;
  const brokeEven = net === 0;

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.headline}>
          <Label>{gameName}</Label>
          <Txt variant="title" color={colors.textMuted}>
            {won ? 'Cashed out' : brokeEven ? 'Broke even' : 'No payout'}
          </Txt>
          <Txt variant="hero" color={won ? colors.win : brokeEven ? colors.text : colors.loss}>
            {money(settlement.payoutCents)}
          </Txt>
          <Txt variant="body" color={colors.textMuted}>
            {net >= 0 ? '+' : ''}
            {money(net)} on a {money(settlement.stakeCents)} entry
          </Txt>
        </View>

        <Card style={styles.breakdown}>
          <Line label="Score" value={String(settlement.score)} />
          <Line label="Multiplier" value={multiplier(settlement.multiplier)} />
          <Line label="Entry" value={money(-settlement.stakeCents)} tone={colors.loss} />
          <Line
            label="Payout"
            value={money(settlement.payoutCents)}
            tone={settlement.payoutCents > 0 ? colors.win : colors.textFaint}
          />
          <View style={styles.divider} />
          <Line label="Balance" value={money(settlement.balanceCents)} strong />
        </Card>

        <Explanation settlement={settlement} />
      </ScrollView>

      <View style={styles.footer}>
        <Button title="Play again" onPress={onPlayAgain} busy={busy} />
        <Button title="Back to lobby" tone="quiet" onPress={onBack} style={styles.back} />
      </View>
    </View>
  );
}

/** Says, in a sentence, why this number and not another one. */
function Explanation({ settlement }: { settlement: Settlement }) {
  if (settlement.settleReason === 'sweep') {
    return (
      <Note tone={colors.textMuted}>
        The app closed before this round finished, so it was settled on the last
        score we had confirmed. Your entry was not lost.
      </Note>
    );
  }
  if (settlement.settleReason === 'invalid_trace') {
    return (
      <Note tone={colors.loss}>
        We could not replay this run, so it was settled on the last score we had
        confirmed rather than the one the game reported.
      </Note>
    );
  }
  if (settlement.scoreMismatch) {
    return (
      <Note tone={colors.loss}>
        The score the game reported did not match the replay. You were paid on the
        replay.
      </Note>
    );
  }
  if (settlement.endReason === 'death' || settlement.endReason === 'idle') {
    return (
      <Note tone={colors.textFaint}>
        The run ended before you cashed out, so the score does not count. That is
        the rule the payout screen was written against.
      </Note>
    );
  }
  return null;
}

function Note({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <Txt variant="small" color={tone} style={styles.note}>
      {children}
    </Txt>
  );
}

function Line({
  label,
  value,
  tone = colors.text,
  strong,
}: {
  label: string;
  value: string;
  tone?: string;
  strong?: boolean;
}) {
  return (
    <View style={styles.line}>
      <Txt variant="body" color={colors.textMuted}>
        {label}
      </Txt>
      <Txt variant={strong ? 'heading' : 'body'} color={tone}>
        {value}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: space.lg, gap: space.lg, paddingTop: space.xxl },
  headline: { gap: space.xs },
  breakdown: { gap: space.md },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  divider: { height: 1, backgroundColor: colors.border },
  note: { lineHeight: 19 },
  footer: {
    padding: space.lg,
    gap: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  back: { minHeight: 44 },
});
