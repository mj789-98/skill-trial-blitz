/**
 * The payout screen. Shown BEFORE the entry fee is taken.
 *
 * The brief: "Before they pay, they see what their score will be worth." So the
 * three questions a player actually has get answered above the fold, in the
 * order they ask them:
 *
 *   1. What does this cost me?          the stake, stated in cents-exact money
 *   2. What do I have to do?            break-even, then the target
 *   3. What is the most I can get?      the cap
 *
 * ── Why a ladder and not a line chart ────────────────────────────────────────
 *
 * A curve drawn as a line asks the player to read a payout off an axis, and the
 * answer they get is approximate. What they want to know is exact: "if I reach
 * 12, I get $4.20." So the curve is rendered as its breakpoints — the same
 * points the server will settle against — with the bar length carrying the shape
 * and the number carrying the amount. It is also one fewer native dependency in
 * a build we have already fought Gradle over.
 *
 * ── Why the countdown is visible ─────────────────────────────────────────────
 *
 * The quote expires (see DECISIONS.md for why 180s). A player who leaves this
 * screen open and comes back to a refusal would rightly call that a bug, so the
 * expiry is shown, and when it lapses the screen re-quotes itself rather than
 * failing at the moment of payment.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Card, ErrorNote, Label, Txt } from '../ui/components';
import { colors, radius, space } from '../ui/theme';
import { money, multiplier, secondsUntil } from '../api/format';
import type { Quote } from '../api/types';

interface Props {
  quote: Quote;
  gameName: string;
  busy: boolean;
  error: string | null;
  onEnter: () => void;
  onRequote: () => void;
  onBack: () => void;
}

export default function PayoutScreen({
  quote,
  gameName,
  busy,
  error,
  onEnter,
  onRequote,
  onBack,
}: Props) {
  const remaining = useCountdown(quote.expiresAt);
  const expired = remaining <= 0;

  // The largest payout on the curve, used to scale the bars. Taken from the
  // curve itself rather than from maxMultiplier so the bars stay honest if the
  // cap is ever not the last point.
  const peak = useMemo(
    () => quote.curve.reduce((m, p) => Math.max(m, p.payoutCents), 1),
    [quote.curve]
  );

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.header}>
          <Label>Blitz entry</Label>
          <Txt variant="title">{gameName}</Txt>
        </View>

        {/* 1. What it costs. */}
        <Card>
          <View style={styles.row}>
            <View>
              <Label>Entry</Label>
              <Txt variant="hero" color={colors.text}>
                {money(quote.stakeCents)}
              </Txt>
            </View>
            <View style={styles.rightCol}>
              <Label>Balance</Label>
              <Txt variant="heading" color={colors.textMuted}>
                {money(quote.balanceCents)}
              </Txt>
            </View>
          </View>

          {/* 2. What has to happen. Break-even first: it is the number that
              decides whether entering is rational at all. */}
          <View style={styles.goals}>
            <Goal
              label="Entry back at"
              value={`${quote.breakEvenScore}`}
              tone={colors.textMuted}
            />
            <Goal label="Target" value={`${quote.targetScore}`} tone={colors.accent} />
            <Goal
              label="Most you can win"
              value={money(Math.round(quote.stakeCents * quote.maxMultiplier))}
              tone={colors.win}
            />
          </View>

          {quote.bootstrap ? (
            <Txt variant="small" color={colors.textFaint} style={styles.note}>
              Entries are capped while we work out how you play. Your targets settle
              down after a few rounds.
            </Txt>
          ) : null}
        </Card>

        {/* 3. The curve, exactly as it will be settled. */}
        <View style={styles.curveHeader}>
          <Label>What a score is worth</Label>
          <Txt variant="small" color={colors.textFaint}>
            locked at entry
          </Txt>
        </View>

        <Card style={styles.curveCard}>
          {quote.curve.map((point, i) => {
            const isBreakEven = point.score === quote.breakEvenScore;
            const isTarget = point.score === quote.targetScore;
            return (
              <View key={`${point.score}-${i}`} style={styles.curveRow}>
                <Txt variant="body" color={colors.textMuted} style={styles.scoreCol}>
                  {point.score}
                </Txt>

                <View style={styles.barTrack}>
                  <View
                    style={[
                      styles.barFill,
                      {
                        // Floored so a zero-payout breakpoint is still a visible
                        // row rather than an invisible one.
                        width: `${Math.max(2, (point.payoutCents / peak) * 100)}%`,
                        backgroundColor: isTarget
                          ? colors.accent
                          : point.payoutCents >= quote.stakeCents
                          ? colors.win
                          : colors.surfaceHigh,
                      },
                    ]}
                  />
                </View>

                <View style={styles.payoutCol}>
                  <Txt
                    variant="body"
                    color={point.payoutCents >= quote.stakeCents ? colors.win : colors.textFaint}
                  >
                    {money(point.payoutCents)}
                  </Txt>
                  <Txt variant="small" color={colors.textFaint}>
                    {multiplier(point.multiplier)}
                  </Txt>
                </View>

                {isBreakEven || isTarget ? (
                  <View
                    style={[
                      styles.marker,
                      { backgroundColor: isTarget ? colors.accent : colors.border },
                    ]}
                  />
                ) : null}
              </View>
            );
          })}
        </Card>

        <Txt variant="small" color={colors.textFaint} style={styles.fineprint}>
          This is the curve for this round. It is fixed when you enter, and nothing
          that happens afterwards changes it. Cash out to bank your score — if you
          are hit, the round pays nothing.
        </Txt>
      </ScrollView>

      <View style={styles.footer}>
        <ErrorNote message={error} />

        {expired ? (
          <Button title="Get a new offer" onPress={onRequote} busy={busy} />
        ) : (
          <Button
            title={`Pay ${money(quote.stakeCents)} and play`}
            subtitle={`offer holds for ${remaining}s`}
            onPress={onEnter}
            busy={busy}
            disabled={!quote.affordable}
          />
        )}

        <Button title="Not now" tone="quiet" onPress={onBack} style={styles.backButton} />
      </View>
    </View>
  );
}

function Goal({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <View style={styles.goal}>
      {/* The label sits in a fixed-height box so the three VALUES share a
          baseline. Without it, "Most you can win" wraps to two lines while
          "Target" stays on one, and the numbers underneath end up at different
          heights — which on a device reads as a broken layout rather than as a
          row of three related facts. Only visible at real phone widths. */}
      <View style={styles.goalLabel}>
        <Label>{label}</Label>
      </View>
      <Txt variant="heading" color={tone}>
        {value}
      </Txt>
    </View>
  );
}

/**
 * Seconds left on the quote, ticking down.
 *
 * Driven off the server's `expiresAt`, not off a local duration: the phone's
 * clock and the database's do not have to agree, and the database is what will
 * actually refuse the entry.
 */
function useCountdown(expiresAt: string): number {
  const compute = useCallback(() => secondsUntil(expiresAt), [expiresAt]);
  const [left, setLeft] = useState(compute);

  useEffect(() => {
    setLeft(compute());
    const id = setInterval(() => setLeft(compute()), 1000);
    return () => clearInterval(id);
  }, [compute]);

  return left;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: space.lg, paddingBottom: space.xl, gap: space.lg },
  header: { gap: space.xs },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  rightCol: { alignItems: 'flex-end', gap: space.xs },
  goals: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.lg,
    paddingTop: space.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  goal: { gap: space.xs, flex: 1, paddingRight: space.sm },
  goalLabel: { minHeight: 30, justifyContent: 'flex-start' },
  note: { marginTop: space.md },
  curveHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  curveCard: { gap: space.sm, paddingVertical: space.md },
  curveRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  scoreCol: { width: 34, textAlign: 'right' },
  barTrack: {
    flex: 1,
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.bg,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: radius.pill },
  payoutCol: { width: 74, alignItems: 'flex-end' },
  marker: { position: 'absolute', left: 0, width: 3, height: 22, borderRadius: radius.pill },
  fineprint: { lineHeight: 19 },
  footer: {
    padding: space.lg,
    gap: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  backButton: { minHeight: 44 },
});
