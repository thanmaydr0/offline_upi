import { useSync } from '@/sync/runtime';
import { ActivityRow, SyncNotice } from '@/sync/components';
import { Banner, Screen, ScreenHeader, SectionTitle } from '@/ui';

export default function HistoryScreen() {
  const { snapshot } = useSync();
  return <Screen><ScreenHeader title="History" subtitle="Last synced activity is available offline." /><SyncNotice />
    {!snapshot?.history.length ? <Banner title="No synced activity yet" /> : null}
    {snapshot?.history.map(row => <ActivityRow key={`${row.type}:${row.id}`} title={`${row.type} · ${new Date(row.createdAt * 1000).toLocaleString()}`}
      amount={row.amountInrPaise} status={row.status} type={row.type} />)}
    <SectionTitle title="Payouts" />
    {snapshot?.payouts.map(row => <ActivityRow key={row.payoutId} title={`Payout · ${row.vpa ?? 'VPA not set'}`} amount={row.amountInrPaise} status={row.status} type="payout" />)}
  </Screen>;
}
