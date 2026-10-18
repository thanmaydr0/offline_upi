import { useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { services } from '@/services';
import { useBalanceStore } from '@/state/balances';
import { usePendingStore } from '@/state/pending';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  ListRow,
  LoadingOverlay,
  NetworkBanner,
  Screen,
  ScreenHeader,
  SectionDivider,
  StatusPill,
  formatInr,
  useAppTheme,
} from '@/ui';

export default function PendingScreen() {
  const theme = useAppTheme();
  const payments = usePendingStore((state) => state.payments);
  const removePayment = usePendingStore((state) => state.removePayment);
  const pendingSettlementPaise = useBalanceStore((state) => state.pendingSettlementPaise);
  const setBalances = useBalanceStore((state) => state.setBalances);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const totalPaise = payments.reduce((total, payment) => total + payment.amountPaise, 0);

  const syncPayments = async () => {
    setLoading(true);
    setError('');
    try {
      const proofItems = await services.received.pending();
      const settlement = await services.api.settle(proofItems);
      for (const result of settlement.results) {
        await services.received.markSettled(result.voucherId, result.status);
      }
      payments.forEach((payment) => removePayment(payment.id));
      setBalances({ onlinePaise: useBalanceStore.getState().onlinePaise, offlinePaise: useBalanceStore.getState().offlinePaise, pendingSettlementPaise: 0 });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not sync right now. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <ScreenHeader title="Received offline" subtitle="These payments will settle when you’re back online." />
      <NetworkBanner />
      {payments.length > 0 ? (
        <>
          <Card style={styles.summaryCard}>
            <View style={[styles.summaryIcon, { backgroundColor: theme.warningSoft }]}>
              <Text style={[styles.summaryIconText, { color: theme.warning }]}>↘</Text>
            </View>
            <View style={styles.summaryCopy}>
              <Text style={[styles.summaryLabel, { color: theme.textSecondary }]}>WAITING TO SETTLE</Text>
              <Text style={[styles.summaryAmount, { color: theme.text }]}>{formatInr(totalPaise)}</Text>
            </View>
            <StatusPill label={`${payments.length} payments`} tone="warning" />
          </Card>
          <Card style={styles.listCard}>
            {payments.map((payment, index) => (
              <View key={payment.id}>
                <ListRow
                  icon="↙"
                  title={payment.senderName}
                  subtitle={payment.receivedAt}
                  trailing={
                    <View style={styles.itemTrailing}>
                      <Text style={[styles.paymentAmount, { color: theme.text }]}>+{formatInr(payment.amountPaise)}</Text>
                      <StatusPill label="Pending" tone="warning" />
                    </View>
                  }
                />
                {index < payments.length - 1 ? <SectionDivider /> : null}
              </View>
            ))}
          </Card>
          <Banner
            title="Your money is safe on this device"
            detail="Nothing is lost while these payments wait to sync."
            tone="info"
            icon="✓"
          />
          {error ? <Banner title={error} tone="warning" icon="!" /> : null}
          <Button title="Sync payments" fullWidth loading={loading} onPress={syncPayments} />
        </>
      ) : (
        <Card>
          <EmptyState
            title="All caught up"
            detail="Payments received while offline will appear here until they’re settled."
            icon="✓"
            action={<Button title="Back to home" compact onPress={() => router.replace('/(tabs)')} />}
          />
        </Card>
      )}
      <Text style={[styles.pendingBalance, { color: theme.textMuted }]}>PENDING BALANCE {formatInr(pendingSettlementPaise)}</Text>
      <LoadingOverlay visible={loading} label="Syncing payments" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  summaryCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
  summaryIcon: { width: 46, height: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  summaryIconText: { fontSize: 22, fontWeight: '700' },
  summaryCopy: { flex: 1, gap: 3 },
  summaryLabel: { fontSize: 9, lineHeight: 13, fontWeight: '800', letterSpacing: 0.8 },
  summaryAmount: { fontSize: 21, lineHeight: 27, fontWeight: '700' },
  listCard: { paddingHorizontal: 16, paddingVertical: 6 },
  itemTrailing: { alignItems: 'flex-end', gap: 5 },
  paymentAmount: { fontSize: 14, lineHeight: 19, fontWeight: '700' },
  pendingBalance: { textAlign: 'center', fontSize: 10, lineHeight: 15, fontWeight: '700', letterSpacing: 0.8 },
});
