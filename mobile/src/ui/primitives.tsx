import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatInr } from './format';
import { themes, typeScale, useAppTheme } from './tokens';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

type ButtonProps = Omit<PressableProps, 'onPress' | 'children'> & {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  fullWidth?: boolean;
  compact?: boolean;
  loading?: boolean;
  leading?: string;
};

export function Button({
  title,
  onPress,
  variant = 'primary',
  fullWidth = false,
  compact = false,
  loading = false,
  leading,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const theme = useAppTheme();
  const backgroundColor =
    variant === 'primary'
      ? theme.accent
      : variant === 'danger'
        ? theme.dangerSoft
        : variant === 'secondary'
          ? theme.surfaceMuted
          : 'transparent';
  const textColor =
    variant === 'primary' ? theme.accentText : variant === 'danger' ? theme.danger : theme.text;

  const handlePress = () => {
    if (disabled || loading) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    onPress();
  };

  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || loading) }}
      disabled={disabled || loading}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor, borderColor: theme.border, opacity: pressed ? 0.86 : disabled ? 0.5 : 1 },
        compact && styles.buttonCompact,
        fullWidth && styles.fullWidth,
        variant === 'ghost' && styles.ghostButton,
        style as StyleProp<ViewStyle>,
      ]}>
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <View style={styles.buttonInner}>
          {leading ? <Text style={[styles.buttonLeading, { color: textColor }]}>{leading}</Text> : null}
          <Text style={[styles.buttonText, { color: textColor }, compact && styles.buttonTextCompact]}>
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

export function Card({
  children,
  style,
  raised = false,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  raised?: boolean;
}) {
  const theme = useAppTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: raised ? theme.surfaceRaised : theme.surface, borderColor: theme.border },
        raised && styles.raisedCard,
        style,
      ]}>
      {children}
    </View>
  );
}

export function Chip({
  label,
  selected = false,
  onPress,
  style,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useAppTheme();
  const content = (
    <Text style={[styles.chipText, { color: selected ? theme.accentText : theme.text }]}>{label}</Text>
  );
  const chipStyle = [
    styles.chip,
    { backgroundColor: selected ? theme.accent : theme.surface, borderColor: selected ? theme.accent : theme.border },
    style,
  ];
  if (!onPress) return <View style={chipStyle}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => undefined);
        onPress();
      }}
      style={({ pressed }) => [...chipStyle, pressed && styles.pressed]}>
      {content}
    </Pressable>
  );
}

export function StatusPill({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'success' | 'warning' | 'danger' | 'neutral';
}) {
  const theme = useAppTheme();
  const colors = {
    success: [theme.successSoft, theme.success],
    warning: [theme.warningSoft, theme.warning],
    danger: [theme.dangerSoft, theme.danger],
    neutral: [theme.surfaceMuted, theme.textSecondary],
  }[tone];
  return (
    <View style={[styles.statusPill, { backgroundColor: colors[0] }]}>
      <View style={[styles.statusDot, { backgroundColor: colors[1] }]} />
      <Text style={[styles.statusText, { color: colors[1] }]}>{label}</Text>
    </View>
  );
}

export function BalanceCard({
  onlinePaise,
  offlinePaise,
  onPressOffline,
}: {
  onlinePaise: number;
  offlinePaise: number;
  onPressOffline?: () => void;
}) {
  const theme = useAppTheme();
  return (
    <View style={[styles.balanceCard, { backgroundColor: theme.accent }]}>
      <View style={styles.balanceTop}>
        <View style={styles.balanceMark}>
          <Text style={[styles.balanceMarkText, { color: theme.accentText }]}>₹</Text>
        </View>
        <StatusPill label="Ready to use" tone="success" />
      </View>
      <Text style={[styles.balanceCaption, { color: '#D1F2DF' }]}>TOTAL AVAILABLE</Text>
      <Text testID="balance-total" style={[styles.balanceTotal, { color: '#FFFFFF' }]}>
        {formatInr(onlinePaise + offlinePaise)}
      </Text>
      <View style={styles.balanceDivider} />
      <View style={styles.balanceBreakdown}>
        <View style={styles.balanceColumn}>
          <Text style={[styles.balanceCaption, { color: '#D1F2DF' }]}>ONLINE BALANCE</Text>
          <Text testID="balance-online" style={[styles.balanceAmount, { color: '#FFFFFF' }]}>
            {formatInr(onlinePaise)}
          </Text>
        </View>
        <Pressable
          accessibilityRole={onPressOffline ? 'button' : undefined}
          onPress={onPressOffline}
          style={styles.balanceColumn}>
          <Text style={[styles.balanceCaption, { color: '#D1F2DF' }]}>OFFLINE BALANCE</Text>
          <Text testID="balance-offline" style={[styles.balanceAmount, { color: '#FFFFFF' }]}>
            {formatInr(offlinePaise)}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export function Banner({
  title,
  detail,
  tone = 'info',
  icon,
  style,
}: {
  title: string;
  detail?: string;
  tone?: 'info' | 'success' | 'warning';
  icon?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useAppTheme();
  const palette = {
    info: [theme.accentSoft, theme.accent],
    success: [theme.successSoft, theme.success],
    warning: [theme.warningSoft, theme.warning],
  }[tone];
  return (
    <View style={[styles.banner, { backgroundColor: palette[0] }, style]}>
      <View style={[styles.bannerIcon, { backgroundColor: theme.surface }]}>
        <Text style={[styles.bannerIconText, { color: palette[1] }]}>{icon ?? '✓'}</Text>
      </View>
      <View style={styles.bannerCopy}>
        <Text style={[styles.bannerTitle, { color: theme.text }]}>{title}</Text>
        {detail ? <Text style={[styles.bannerDetail, { color: theme.textSecondary }]}>{detail}</Text> : null}
      </View>
    </View>
  );
}

export function EmptyState({
  title,
  detail,
  icon = '✦',
  action,
}: {
  title: string;
  detail: string;
  icon?: string;
  action?: ReactNode;
}) {
  const theme = useAppTheme();
  return (
    <View style={styles.emptyState}>
      <View style={[styles.emptyIcon, { backgroundColor: theme.accentSoft }]}>
        <Text style={[styles.emptyIconText, { color: theme.accent }]}>{icon}</Text>
      </View>
      <Text style={[typeScale.heading, { color: theme.text, textAlign: 'center' }]}>{title}</Text>
      <Text style={[typeScale.body, { color: theme.textSecondary, textAlign: 'center', maxWidth: 270 }]}>
        {detail}
      </Text>
      {action}
    </View>
  );
}

export function LoadingOverlay({ visible, label = 'Please wait' }: { visible: boolean; label?: string }) {
  const theme = useAppTheme();
  if (!visible) return null;
  return (
    <View style={styles.loadingOverlay} accessibilityRole="progressbar" accessibilityLabel={label}>
      <View style={[styles.loadingCard, { backgroundColor: theme.surface }]}>
        <ActivityIndicator size="large" color={theme.accent} />
        <Text style={[styles.loadingText, { color: theme.text }]}>{label}</Text>
      </View>
    </View>
  );
}

export function AmountKeypad({
  value,
  onChange,
  maxDigits = 6,
}: {
  value: string;
  onChange: (value: string) => void;
  maxDigits?: number;
}) {
  const theme = useAppTheme();
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'];
  const pressKey = (key: string) => {
    void Haptics.selectionAsync().catch(() => undefined);
    if (key === '⌫') {
      onChange(value.slice(0, -1));
      return;
    }
    if (value.length + key.length <= maxDigits) onChange(`${value}${key}`.replace(/^0+(?=\d)/, ''));
  };

  return (
    <View testID="amount-keypad" style={styles.keypad}>
      {keys.map((key) => (
        <Pressable
          key={key}
          accessibilityRole="button"
          accessibilityLabel={key === '⌫' ? 'Delete' : key}
          onPress={() => pressKey(key)}
          style={({ pressed }) => [
            styles.key,
            { backgroundColor: theme.surface, borderColor: theme.border },
            pressed && { backgroundColor: theme.surfaceMuted },
          ]}>
          <Text style={[styles.keyText, { color: key === '⌫' ? theme.textSecondary : theme.text }]}>
            {key}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Screen({
  children,
  scroll = true,
  style,
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const theme = useAppTheme();
  const content = scroll ? (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.screenContent, contentStyle]}>
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.screenContent, styles.fill, contentStyle]}>
      {children}
    </View>
  );
  return (
    <SafeAreaView edges={['top']} style={[styles.screen, { backgroundColor: theme.background }, style]}>
      {content}
    </SafeAreaView>
  );
}

export function ScreenHeader({
  title,
  subtitle,
  eyebrow,
  action,
  style,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  action?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useAppTheme();
  return (
    <View style={[styles.screenHeader, style]}>
      <View style={styles.screenHeaderCopy}>
        {eyebrow ? <Text style={[styles.eyebrow, { color: theme.accent }]}>{eyebrow}</Text> : null}
        <Text style={[typeScale.title, { color: theme.text }]}>{title}</Text>
        {subtitle ? <Text style={[typeScale.body, { color: theme.textSecondary }]}>{subtitle}</Text> : null}
      </View>
      {action}
    </View>
  );
}

export function SectionTitle({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  const theme = useAppTheme();
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={[typeScale.heading, { color: theme.text }]}>{title}</Text>
      {action}
    </View>
  );
}

export function TextLink({ title, onPress }: { title: string; onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.textLink, pressed && styles.pressed]}>
      <Text style={[styles.textLinkText, { color: theme.accent }]}>{title}</Text>
      <Text style={[styles.textLinkArrow, { color: theme.accent }]}>›</Text>
    </Pressable>
  );
}

export function ListRow({
  title,
  subtitle,
  icon,
  trailing,
  onPress,
}: {
  title: string;
  subtitle?: string;
  icon?: string;
  trailing?: ReactNode;
  onPress?: () => void;
}) {
  const theme = useAppTheme();
  const row = (
    <>
      {icon ? (
        <View style={[styles.listIcon, { backgroundColor: theme.surfaceMuted }]}>
          <Text style={[styles.listIconText, { color: theme.accent }]}>{icon}</Text>
        </View>
      ) : null}
      <View style={styles.listCopy}>
        <Text style={[styles.listTitle, { color: theme.text }]}>{title}</Text>
        {subtitle ? <Text style={[styles.listSubtitle, { color: theme.textSecondary }]}>{subtitle}</Text> : null}
      </View>
      {trailing ?? (onPress ? <Text style={[styles.listChevron, { color: theme.textMuted }]}>›</Text> : null)}
    </>
  );
  if (!onPress) return <View style={styles.listRow}>{row}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.listRow, pressed && styles.pressed]}>
      {row}
    </Pressable>
  );
}

export function SectionDivider() {
  const theme = useAppTheme();
  return <View style={[styles.divider, { backgroundColor: theme.border }]} />;
}

const styles = StyleSheet.create({
  button: {
    minHeight: 54,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonCompact: { minHeight: 42, borderRadius: 13, paddingHorizontal: 15 },
  fullWidth: { alignSelf: 'stretch' },
  ghostButton: { borderColor: 'transparent' },
  buttonInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  buttonLeading: { fontSize: 19, fontWeight: '700' },
  buttonText: { ...typeScale.body, fontWeight: '700' },
  buttonTextCompact: { fontSize: 14, lineHeight: 20 },
  card: { borderRadius: 22, borderWidth: 1, padding: 20 },
  raisedCard: {
    shadowColor: themes.light.shadow,
    shadowOpacity: 0.07,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 7 },
    elevation: 2,
  },
  chip: { minHeight: 42, borderRadius: 14, borderWidth: 1, paddingHorizontal: 17, justifyContent: 'center' },
  chipText: { ...typeScale.label },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 50 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
  balanceCard: { minHeight: 238, borderRadius: 26, padding: 22, overflow: 'hidden' },
  balanceTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 25 },
  balanceMark: { width: 42, height: 42, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
  balanceMarkText: { fontSize: 22, fontWeight: '700' },
  balanceCaption: { fontSize: 10, lineHeight: 14, fontWeight: '700', letterSpacing: 1.1 },
  balanceTotal: { fontSize: 32, lineHeight: 40, fontWeight: '700', letterSpacing: -0.7, marginTop: 4 },
  balanceDivider: { height: 1, backgroundColor: 'rgba(255,255,255,0.24)', marginTop: 18, marginBottom: 15 },
  balanceBreakdown: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  balanceColumn: { flex: 1 },
  balanceAmount: { fontSize: 17, lineHeight: 23, fontWeight: '700', marginTop: 4 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 18, padding: 14 },
  bannerIcon: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  bannerIconText: { fontSize: 15, fontWeight: '800' },
  bannerCopy: { flex: 1, gap: 2 },
  bannerTitle: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  bannerDetail: { fontSize: 12, lineHeight: 17 },
  emptyState: { alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 36, paddingHorizontal: 24 },
  emptyIcon: { width: 58, height: 58, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyIconText: { fontSize: 26, fontWeight: '700' },
  loadingOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 10, backgroundColor: 'rgba(12,19,15,0.42)', alignItems: 'center', justifyContent: 'center' },
  loadingCard: { paddingVertical: 24, paddingHorizontal: 30, borderRadius: 20, minWidth: 170, alignItems: 'center', gap: 14 },
  loadingText: { ...typeScale.label },
  keypad: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 9 },
  key: { width: '31.8%', height: 57, borderWidth: 1, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  keyText: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  screen: { flex: 1 },
  fill: { flex: 1 },
  screenContent: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 30, gap: 22, alignSelf: 'center', width: '100%', maxWidth: 640 },
  screenHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 },
  screenHeaderCopy: { flex: 1, gap: 6 },
  eyebrow: { fontSize: 11, lineHeight: 15, fontWeight: '800', letterSpacing: 1.25 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  textLink: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 40, paddingHorizontal: 3 },
  textLinkText: { fontSize: 13, fontWeight: '700' },
  textLinkArrow: { fontSize: 22, lineHeight: 24, fontWeight: '400' },
  listRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 12 },
  listIcon: { width: 42, height: 42, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  listIconText: { fontSize: 17, fontWeight: '700' },
  listCopy: { flex: 1, gap: 3 },
  listTitle: { fontSize: 14, lineHeight: 19, fontWeight: '700' },
  listSubtitle: { fontSize: 12, lineHeight: 17 },
  listChevron: { fontSize: 26, fontWeight: '300', paddingHorizontal: 3 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 2 },
  pressed: { opacity: 0.72 },
});
