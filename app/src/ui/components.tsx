/**
 * The shared pieces. Four of them, because four is all the app needs.
 *
 * No component library. Everything here is a View and a Text, which keeps the
 * bundle small and — more usefully for a build we have already fought Gradle
 * over — adds no native modules.
 */

import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { colors, radius, space, type } from './theme';

// ── Text ────────────────────────────────────────────────────────────────────

type Variant = keyof typeof type;

export function Txt({
  variant = 'body',
  color = colors.text,
  style,
  children,
}: {
  variant?: Variant;
  color?: string;
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
}) {
  return <Text style={[type[variant], { color }, style]}>{children}</Text>;
}

/** An all-caps section label. The uppercasing lives here so copy stays readable. */
export function Label({ children, color = colors.textFaint }: { children: string; color?: string }) {
  return (
    <Text style={[type.label, { color }]}>{children.toUpperCase()}</Text>
  );
}

// ── Button ──────────────────────────────────────────────────────────────────

export function Button({
  title,
  onPress,
  tone = 'accent',
  disabled,
  busy,
  subtitle,
  style,
}: {
  title: string;
  onPress: () => void;
  tone?: 'accent' | 'quiet' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  subtitle?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const inactive = disabled || busy;
  const palette = {
    accent: { bg: colors.accent, fg: colors.accentText },
    quiet: { bg: colors.surfaceHigh, fg: colors.text },
    danger: { bg: colors.loss, fg: colors.accentText },
  }[tone];

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      // A 56pt target: comfortably above the 44pt minimum, and this is a button
      // that spends money, so it should not be possible to hit by accident on
      // the way to something else.
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: palette.bg, opacity: inactive ? 0.4 : pressed ? 0.82 : 1 },
        style,
      ]}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
    >
      {busy ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <>
          <Text style={[type.heading, { color: palette.fg }]}>{title}</Text>
          {subtitle ? (
            <Text style={[type.small, styles.subtitle, { color: palette.fg }]}>
              {subtitle}
            </Text>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * An inline error strip.
 *
 * Deliberately not an Alert. A modal on top of a money screen hides the number
 * the player is trying to understand, and on Android it can arrive after they
 * have already moved on.
 */
export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View style={styles.error}>
      <Text style={[type.small, { color: colors.loss }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  subtitle: { opacity: 0.75, marginTop: 2 },
  button: {
    minHeight: 56,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
  },
  error: {
    backgroundColor: 'rgba(248,113,113,0.12)',
    borderColor: 'rgba(248,113,113,0.35)',
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
});
