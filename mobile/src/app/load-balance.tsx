import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { loadBalanceFlow, syncEngine, useLoadBalance } from '@/sync/runtime';
import { Banner, Button, Card, Chip, Screen, ScreenHeader, StatusPill, formatInr, useAppTheme } from '@/ui';

export default function LoadBalanceScreen() {
  const theme = useAppTheme();
  const [amount, setAmount] = useState(500);
  const [ready, setReady] = useState(false);
  const [localError, setLocalError] = useState('');
  const state = useLoadBalance();
  const busy = ['kyc', 'creating', 'payment', 'polling', 'issuing', 'saving'].includes(state.phase);
  useEffect(() => { void loadBalanceFlow.hydrate().then(() => setReady(true)).catch(() => setReady(true)); }, []);
  const finish = async () => { await loadBalanceFlow.acknowledgeSuccess(); void syncEngine.run(); router.replace('/(tabs)'); };
  return <Screen>
    <ScreenHeader title="Load Offline Balance" subtitle="Identity verification → UPI payment → funded vouchers" />
    <Card><Text style={{ color: theme.text, fontSize: 30 }}>{formatInr(BigInt(state.journal?.amountInr ?? amount) * 100n)}</Text>
      <Text style={{ color: theme.textSecondary }}>Keep this amount available when you lose signal.</Text></Card>
    {state.error ? <Banner title={state.error} tone="warning" /> : null}
    {localError ? <Banner title={localError} tone="warning" /> : null}
    <StatusPill label={state.phase} tone={state.phase === 'success' ? 'success' : 'neutral'} />
    {state.journal ? <Text selectable style={{ color: theme.textSecondary }}>Order: {state.journal.orderId}</Text> : null}
    {state.phase === 'success' ? <>
      <Banner title="You’re offline-ready" detail="Vouchers saved and ledger updated." tone="success" />
      <Button title="Back to home" onPress={finish} />
    </> : <>
      {!state.journal ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {[200, 500, 1000, 2000, 5000].map(value => <Chip key={value} label={formatInr(BigInt(value) * 100n)} selected={value === amount} onPress={() => { if (!busy) setAmount(value); }} />)}
      </View> : null}
      <Button title={state.journal ? 'Resume and check payment' : 'Verify identity and pay'} loading={busy} disabled={!ready}
        onPress={() => { void (state.journal ? loadBalanceFlow.resume() : loadBalanceFlow.start(amount)); }} />
      {state.journal ? <Button title="Reopen payment page" variant="secondary" disabled={busy} onPress={() => { void loadBalanceFlow.resume(true); }} /> : null}
      {state.journal && state.phase === 'failed' ? <Button title="Clear failed or expired order" variant="ghost" onPress={() => {
        void loadBalanceFlow.discardTerminalOrder().catch(error => setLocalError(error instanceof Error ? error.message : 'Cannot clear active order.'));
      }} /> : null}
      {busy ? <Button title="Pause" variant="ghost" onPress={loadBalanceFlow.cancel} /> : null}
      <Text style={{ color: theme.textSecondary }}>Closing the payment page does not cancel the server order. Resume this order before starting another load.</Text>
    </>}
  </Screen>;
}
