import { Text, View } from 'react-native';
import { Banner, Button, Card, StatusPill, formatInr, useAppTheme } from '../ui';
import { syncEngine, useSync } from './runtime';

export function SyncNotice() {
  const state = useSync();
  return <View style={{ gap: 8 }}>
    <Banner title={state.running ? 'Syncing…' : state.error ?? (state.snapshot ? `Last sync ${new Date(state.snapshot.lastSync).toLocaleString()}` : 'No sync completed yet')}
      tone={state.error ? 'warning' : 'info'} />
    <Button title="Sync now" loading={state.running} variant="secondary" onPress={() => { void syncEngine.run(); }} />
  </View>;
}
export function PaymentStatus({ status, type }: { status: string; type?: string }) {
  const failed = ['failed', 'rejected', 'expired', 'cancelled'].includes(status);
  const paid = type === 'payout' && ['paid', 'paid_out', 'completed', 'success'].includes(status);
  const verified = ['verified', 'issued', 'verified_offline'].includes(status);
  return <StatusPill label={failed ? 'Failed' : paid ? 'Paid out' : verified ? 'Verified offline' : 'Settling'}
    tone={failed ? 'danger' : paid || verified ? 'success' : 'warning'} />;
}
export function ActivityRow({ title, amount, status, type }: { title: string; amount: number | bigint; status: string; type?: string }) {
  const theme = useAppTheme();
  return <Card><View style={{ gap: 8 }}><Text style={{ color: theme.text }}>{title}</Text>
    <Text style={{ color: theme.text }}>{formatInr(amount)}</Text><PaymentStatus status={status} type={type} /></View></Card>;
}
