/**
 * The end of a free run.
 *
 * Deliberately not the Blitz result screen with the money removed. There is no
 * settlement here, no server round trip, and nothing to reconcile — the score is
 * simply what the game says it was, because nothing is riding on it. Reusing the
 * paid screen would mean rendering a settlement-shaped object that no server
 * ever produced, and that object would eventually get passed somewhere that
 * assumed it had.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Label, Txt } from '../ui/components';
import { colors, space } from '../ui/theme';

interface Props {
  gameName: string;
  score: number;
  reason: string;
  onPlayAgain: () => void;
  onBack: () => void;
}

export default function PracticeResultScreen({
  gameName,
  score,
  reason,
  onPlayAgain,
  onBack,
}: Props) {
  const banked = reason === 'cash_out';

  return (
    <View style={styles.root}>
      <View style={styles.body}>
        <Label>{`${gameName} · practice`}</Label>
        <Txt variant="title" color={colors.textMuted}>
          {banked ? 'Banked' : reason === 'idle' ? 'Caught standing still' : 'Run over'}
        </Txt>
        <Txt variant="hero" color={banked ? colors.win : colors.text}>
          {score}
        </Txt>
        <Txt variant="body" color={colors.textFaint}>
          {banked
            ? 'In a Blitz round this is the score you would be paid on.'
            : 'In a Blitz round a run that ends this way pays nothing.'}
        </Txt>
      </View>

      <View style={styles.footer}>
        <Button title="Run it again" onPress={onPlayAgain} />
        <Button title="Back to lobby" tone="quiet" onPress={onBack} style={styles.back} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, justifyContent: 'center', padding: space.xl, gap: space.sm },
  footer: {
    padding: space.lg,
    gap: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  back: { minHeight: 44 },
});
