import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import {
  Banner,
  Card,
  ListRow,
  NetworkBanner,
  Screen,
  ScreenHeader,
  SectionDivider,
  StatusPill,
  useAppTheme,
} from '@/ui';

export default function SettingsScreen() {
  const theme = useAppTheme();
  return (
    <Screen>
      <ScreenHeader title="Settings" subtitle="Your account and app preferences." />
      <NetworkBanner />

      <Card style={styles.profileCard}>
        <View style={[styles.avatar, { backgroundColor: theme.accentSoft }]}>
          <Text style={[styles.avatarText, { color: theme.accent }]}>A</Text>
        </View>
        <View style={styles.profileCopy}>
          <Text style={[styles.profileName, { color: theme.text }]}>Ananya Sharma</Text>
          <Text style={[styles.profileDetail, { color: theme.textSecondary }]}>Personal account</Text>
        </View>
        <StatusPill label="Verified" tone="success" />
      </Card>

      <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>SECURITY & PRIVACY</Text>
      <Card style={styles.groupCard}>
        <ListRow icon="✓" title="Security status" subtitle="Review your device checks" onPress={() => router.push('/security')} />
        <SectionDivider />
        <ListRow icon="◉" title="Biometric approval" subtitle="Required for offline payments" trailing={<StatusPill label="On" tone="success" />} />
        <SectionDivider />
        <ListRow icon="⌁" title="Offline payments" subtitle="See payments waiting to sync" onPress={() => router.push('/pending')} />
      </Card>

      <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>YOUR ACCOUNT</Text>
      <Card style={styles.groupCard}>
        <ListRow icon="＋" title="Add money" subtitle="Move money into your offline balance" onPress={() => router.push('/load-balance')} />
        <SectionDivider />
        <ListRow icon="↻" title="Payment activity" subtitle="View all recent payments" onPress={() => router.push('/(tabs)/history')} />
      </Card>

      <Banner
        icon="i"
        title="OfflinePay demo"
        detail="Payments and balances on this build use sample data."
        tone="info"
      />
      <Text style={[styles.version, { color: theme.textMuted }]}>VERSION 1.0.0 · INDIA</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  profileCard: { flexDirection: 'row', alignItems: 'center', gap: 13, padding: 16 },
  avatar: { width: 52, height: 52, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 21, fontWeight: '800' },
  profileCopy: { flex: 1, gap: 4 },
  profileName: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  profileDetail: { fontSize: 12, lineHeight: 17 },
  sectionLabel: { fontSize: 10, lineHeight: 14, letterSpacing: 1, fontWeight: '800', marginBottom: -10 },
  groupCard: { paddingHorizontal: 16, paddingVertical: 5 },
  version: { textAlign: 'center', fontSize: 10, lineHeight: 15, fontWeight: '700', letterSpacing: 1 },
});
