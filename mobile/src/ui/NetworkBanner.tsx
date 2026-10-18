import { StyleSheet, Text, View } from 'react-native';
import { useNetworkState } from 'expo-network';

import { spacing, useAppTheme } from './tokens';

export function NetworkBanner() {
  const network = useNetworkState();
  const theme = useAppTheme();
  const offline = network.isConnected === false || network.isInternetReachable === false;
  const accent = offline ? theme.warning : theme.success;
  const background = offline ? theme.warningSoft : theme.successSoft;

  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={offline ? "You're offline. Offline payments available" : "You're online. Sync is up to date"}
      style={[styles.banner, { backgroundColor: background }]}>
      <View style={[styles.icon, { backgroundColor: theme.surface }]}>
        <Text style={[styles.iconText, { color: accent }]}>{offline ? '↯' : '✓'}</Text>
      </View>
      <View style={styles.copy}>
        <Text style={[styles.title, { color: theme.text }]}>
          {offline ? "You're offline. Offline payments available" : "You're online"}
        </Text>
        <Text style={[styles.detail, { color: theme.textSecondary }]}>
          {offline ? 'You can still pay nearby and settle later' : 'Your account is synced and ready'}
        </Text>
      </View>
      <View style={[styles.dot, { backgroundColor: accent }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { minHeight: 62, borderRadius: 18, flexDirection: 'row', alignItems: 'center', padding: spacing.md, gap: 11 },
  icon: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 16, fontWeight: '800' },
  copy: { flex: 1, gap: 2 },
  title: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  detail: { fontSize: 11, lineHeight: 15 },
  dot: { width: 8, height: 8, borderRadius: 4, marginHorizontal: 2 },
});
