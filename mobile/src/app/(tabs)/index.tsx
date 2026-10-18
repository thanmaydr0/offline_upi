import { useCallback, useEffect, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Text, View } from 'react-native';
import { services, servicesMode } from '@/services';
import { useBalanceStore } from '@/state/balances';
import { useSync, enableSync, loadBalanceFlow } from '@/sync/runtime';
import { ActivityRow, SyncNotice } from '@/sync/components';
import { BalanceCard, Banner, Button, Screen, ScreenHeader, SectionTitle, useAppTheme } from '@/ui';

export default function HomeScreen() {
  const theme = useAppTheme();
  const { snapshot } = useSync();
  const [offline, setOffline] = useState<bigint | null>(null);
  const onlinePaise = snapshot?.wallet.onlineInrPaise ?? 0n;
  const offlinePaise = offline ?? snapshot?.offlinePaise ?? 0n;
  const amountsFit = onlinePaise <= BigInt(Number.MAX_SAFE_INTEGER) && offlinePaise <= BigInt(Number.MAX_SAFE_INTEGER);
  useEffect(() => { enableSync(); }, []);
  const refreshOffline = useCallback(() => {
    let active = true;
    void services.wallet.offlineBalancePaise().then(value => { if (active) setOffline(value); }).catch(() => undefined);
    void loadBalanceFlow.hydrate().catch(() => undefined);
    return () => { active = false; };
  }, []);
  useFocusEffect(refreshOffline);
  useEffect(() => refreshOffline(), [snapshot, refreshOffline]);
  useEffect(() => {
    if (!snapshot) return;
    const values = [snapshot.wallet.onlineInrPaise ?? 0n, snapshot.offlinePaise, snapshot.wallet.pendingSettlementPaise ?? 0n];
    if (values.every(v => v <= BigInt(Number.MAX_SAFE_INTEGER))) useBalanceStore.getState().setBalances({
      onlinePaise: Number(values[0]), offlinePaise: Number(values[1]), pendingSettlementPaise: Number(values[2]),
    });
  }, [snapshot]);
  return <Screen>
    <ScreenHeader title="Your OfflinePay wallet" subtitle={servicesMode === 'real' ? 'Device-backed offline balance' : 'Mock services'} />
    <SyncNotice />
    {amountsFit ? <BalanceCard onlinePaise={Number(onlinePaise)} offlinePaise={Number(offlinePaise)} onPressOffline={() => router.push('/load-balance')} /> : <Banner title="Balance exceeds display range. Review security status." tone="warning" />}
    <Button title="Load Offline Balance" onPress={() => router.push('/load-balance')} />
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <Button title="Pay" onPress={() => router.push('/pay')} />
      <Button title="Receive" onPress={() => router.push('/receive')} />
    </View>
    {servicesMode === 'mock' ? <Banner title="Mock wallet mode" detail="Pay and Receive require real core vouchers and configuration." /> : null}
    <Button title="Pending received payments" variant="secondary" onPress={() => router.push('/pending')} />
    <Button title="Security status" variant="ghost" onPress={() => router.push('/security')} />
    <SectionTitle title="Recent activity" />
    {snapshot?.history.slice(0, 3).map(row => <ActivityRow key={row.id} title={row.type} amount={row.amountInrPaise} status={row.status} type={row.type} />)}
    {!snapshot?.history.length ? <Text style={{ color: theme.textSecondary }}>No synced activity yet.</Text> : null}
  </Screen>;
}
