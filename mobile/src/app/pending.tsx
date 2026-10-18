import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Text } from 'react-native';
import { receivedStatuses, useSync, type ReceivedStatus } from '@/sync/runtime';
import { ActivityRow, SyncNotice } from '@/sync/components';
import { Banner, Screen, ScreenHeader, useAppTheme } from '@/ui';

const reasons = ['Redeemed', 'Already redeemed', 'Bad issuer signature', 'Bad device signature', 'Voucher expired', 'Deadline passed', 'Device frozen', 'Insufficient collateral', 'Field mismatch'];
export default function PendingScreen() {
  const theme = useAppTheme();
  const state = useSync();
  const [items, setItems] = useState<ReceivedStatus[]>([]);
  const [error, setError] = useState('');
  const refresh = useCallback(() => { void receivedStatuses().then(setItems).catch(caught => setError(caught instanceof Error ? caught.message : 'Cannot read received payments.')); }, []);
  useFocusEffect(refresh);
  useEffect(refresh, [refresh, state.running, state.snapshot]);
  return <Screen><ScreenHeader title="Received payments" subtitle="Verified offline receipts retain individual settlement results." /><SyncNotice />
    {error ? <Banner title={error} tone="warning" /> : null}
    {items.length === 0 ? <Banner title="No received payments" /> : null}
    {items.map(item => <ActivityRow key={item.voucherId} title={`${item.voucherId.slice(0, 12)}… · ${item.settlementStatus === null ? 'Awaiting settlement' : reasons[item.settlementStatus] ?? 'Unknown failure'}`}
      amount={item.inrPaise} status={item.status === 'pending' ? state.running ? 'settling' : 'verified_offline' : item.settlementStatus === 0 ? 'settling' : 'failed'} />)}
    <Text style={{ color: theme.textSecondary }}>Redemption confirms settlement. “Paid out” appears in History only after the payout completes.</Text>
  </Screen>;
}
