import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useBalanceStore } from '@/state/balances';
import { useHistoryStore } from '@/state/history';
import { useSessionStore } from '@/state/session';
import {
  BalanceCard,
  Button,
  Card,
  ListRow,
  NetworkBanner,
  Screen,
  SectionTitle,
  StatusPill,
  TextLink,
  formatInr,
  typeScale,
  useAppTheme,
} from '@/ui';

export default function HomeScreen() {
  const theme = useAppTheme();
  const name = useSessionStore((state) => state.displayName);
  const onlinePaise = useBalanceStore((state) => state.onlinePaise);
  const offlinePaise = useBalanceStore((state) => state.offlinePaise);
  const allTransactions = useHistoryStore((state) => state.transactions);
  const transactions = allTransactions.slice(0, 3);

  return (
    <Screen contentStyle={styles.content}>
      <View style={styles.topRow}>
        <View style={styles.greeting}>
          <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>YOUR EVERYDAY PAYMENTS</Text>
          <Text style={[typeScale.title, { color: theme.text }]}>Good morning, {name}</Text>
        </View>
        <Pressable
          accessibilityLabel="Open security status"
          accessibilityRole="button"
          onPress={() => router.push('/security')}
          style={[styles.profile, { backgroundColor: theme.accentSoft }]}>
          <Text style={[styles.profileText, { color: theme.accent }]}>{name.slice(0, 1)}</Text>
        </Pressable>
      </View>

      <NetworkBanner />

      <BalanceCard
        onlinePaise={onlinePaise}
        offlinePaise={offlinePaise}
        onPressOffline={() => router.push('/load-balance')}
      />

      <View style={styles.actions}>
        <Button title="Pay" leading="↗" onPress={() => router.push('/pay')} style={styles.actionButton} />
        <Button title="Receive" leading="↙" variant="secondary" onPress={() => router.push('/receive')} style={styles.actionButton} />
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => router.push('/load-balance')}
        style={({ pressed }) => [styles.readyCard, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }, pressed && styles.pressed]}>
        <View style={[styles.readyIcon, { backgroundColor: theme.accentSoft }]}>
          <Text style={[styles.readyIconText, { color: theme.accent }]}>↯</Text>
        </View>
        <View style={styles.readyCopy}>
          <Text style={[styles.readyTitle, { color: theme.text }]}>Get offline-ready</Text>
          <Text style={[styles.readySubtitle, { color: theme.textSecondary }]}>Add a little cash for when signal drops</Text>
        </View>
        <Text style={[styles.chevron, { color: theme.accent }]}>›</Text>
      </Pressable>

      <View style={styles.activityHeading}>
        <SectionTitle title="Recent activity" />
        <TextLink title="See all" onPress={() => router.push('/(tabs)/history')} />
      </View>
      <Card style={styles.activityCard}>
        {transactions.length === 0 ? (
          <Text style={[typeScale.body, { color: theme.textSecondary }]}>Your latest activity will show here.</Text>
        ) : (
          transactions.map((transaction, index) => (
            <View key={transaction.id}>
              <ListRow
                title={transaction.title}
                subtitle={transaction.subtitle}
                icon={transaction.icon}
                trailing={
                  <View style={styles.amountColumn}>
                    <Text style={[styles.transactionAmount, { color: theme.text }]}>
                      {transaction.direction === 'out' ? '−' : '+'}{formatInr(transaction.amountPaise)}
                    </Text>
                    {transaction.status === 'pending' ? <StatusPill label="Pending" tone="warning" /> : null}
                  </View>
                }
              />
              {index < transactions.length - 1 ? <View style={[styles.divider, { backgroundColor: theme.border }]} /> : null}
            </View>
          ))
        )}
      </Card>

      <View style={styles.footer}>
        <Text style={[styles.footerLabel, { color: theme.textMuted }]}>OFFLINEPAY DEMO</Text>
        <Text style={[styles.footerAmount, { color: theme.textMuted }]}>{formatInr(offlinePaise)} ready offline</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 16, gap: 18 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  greeting: { flex: 1, gap: 5 },
  eyebrow: { fontSize: 10, lineHeight: 14, fontWeight: '800', letterSpacing: 1.15 },
  profile: { width: 44, height: 44, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  profileText: { fontSize: 18, fontWeight: '800' },
  actions: { flexDirection: 'row', gap: 12 },
  actionButton: { flex: 1, minHeight: 62, borderRadius: 18 },
  readyCard: { minHeight: 80, borderWidth: 1, borderRadius: 22, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  readyIcon: { width: 46, height: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  readyIconText: { fontSize: 22, fontWeight: '800' },
  readyCopy: { flex: 1, gap: 3 },
  readyTitle: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  readySubtitle: { fontSize: 12, lineHeight: 17 },
  chevron: { fontSize: 28, fontWeight: '300' },
  activityHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 },
  activityCard: { paddingHorizontal: 16, paddingVertical: 8 },
  amountColumn: { alignItems: 'flex-end', gap: 5 },
  transactionAmount: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 54 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 2 },
  footerLabel: { fontSize: 9, lineHeight: 14, letterSpacing: 1, fontWeight: '800' },
  footerAmount: { fontSize: 10, lineHeight: 14, fontWeight: '600' },
  pressed: { opacity: 0.78 },
});
