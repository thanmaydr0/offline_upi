import { useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useHistoryStore } from '@/state/history';
import {
  Card,
  Chip,
  EmptyState,
  ListRow,
  NetworkBanner,
  Screen,
  ScreenHeader,
  SectionDivider,
  StatusPill,
  formatInr,
  useAppTheme,
} from '@/ui';

type Filter = 'All' | 'Sent' | 'Received';

export default function HistoryScreen() {
  const theme = useAppTheme();
  const [filter, setFilter] = useState<Filter>('All');
  const transactions = useHistoryStore((state) => state.transactions);
  const visibleTransactions = transactions.filter((item) =>
    filter === 'All' || (filter === 'Sent' ? item.direction === 'out' : item.direction === 'in'),
  );

  return (
    <Screen>
      <ScreenHeader title="Activity" subtitle="Your payments, all in one place." />
      <NetworkBanner />
      <View style={styles.filters}>
        {(['All', 'Sent', 'Received'] as const).map((label) => (
          <Chip key={label} label={label} selected={filter === label} onPress={() => setFilter(label)} />
        ))}
      </View>
      <Card style={styles.listCard}>
        <View style={styles.sectionHeading}>
          <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>RECENT PAYMENTS</Text>
          <StatusPill label={`${visibleTransactions.length} items`} />
        </View>
        {visibleTransactions.length === 0 ? (
          <EmptyState title="Nothing here yet" detail="Payments you make and receive will show up here." icon="↻" />
        ) : (
          visibleTransactions.map((transaction, index) => (
            <View key={transaction.id}>
              <ListRow
                icon={transaction.icon}
                title={transaction.title}
                subtitle={transaction.subtitle}
                trailing={
                  <View style={styles.amountColumn}>
                    <Text style={[styles.amount, { color: theme.text }]}>
                      {transaction.direction === 'out' ? '−' : '+'}{formatInr(transaction.amountPaise)}
                    </Text>
                    <Text style={[styles.status, { color: transaction.status === 'pending' ? theme.warning : theme.success }]}>
                      {transaction.status === 'pending' ? 'Waiting to settle' : 'Completed'}
                    </Text>
                  </View>
                }
              />
              {index < visibleTransactions.length - 1 ? <SectionDivider /> : null}
            </View>
          ))
        )}
      </Card>
      <Card style={styles.pendingCard}>
        <ListRow
          icon="↘"
          title="Received offline"
          subtitle="Payments waiting to sync"
          onPress={() => router.push('/pending')}
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', gap: 9 },
  listCard: { paddingHorizontal: 16, paddingTop: 17, paddingBottom: 10, gap: 7 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  sectionLabel: { fontSize: 10, lineHeight: 14, letterSpacing: 1, fontWeight: '800' },
  amountColumn: { alignItems: 'flex-end', gap: 4 },
  amount: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  status: { fontSize: 10, lineHeight: 14, fontWeight: '600' },
  pendingCard: { paddingHorizontal: 16, paddingVertical: 4 },
});
