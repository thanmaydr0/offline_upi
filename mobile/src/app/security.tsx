import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { getSecurityStatus, type SecurityStatus } from '@/core';
import { servicesMode } from '@/services';
import { useSync } from '@/sync/runtime';
import { Banner, Card, Screen, ScreenHeader, StatusPill, useAppTheme } from '@/ui';

export default function SecurityScreen() {
  const theme = useAppTheme();
  const sync = useSync();
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void getSecurityStatus().then(value => { if (active) setStatus(value); }).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : 'Checks unavailable'); });
    return () => { active = false; };
  }, [sync.snapshot]);
  const rows = status ? [ ['Biometrics enrolled', status.biometricsEnrolled], ['Device integrity (best effort)', !status.integrity.rooted && status.integrity.isDevice && !status.integrity.debug],
    ['Secure key ready', status.keyState === 'READY'], ['Ledger intact', status.ledgerOk], ['Clock verified', status.clockOk], ['Offline enabled', status.offlineEnabled] ] as const : [];
  return <Screen><ScreenHeader title="Security status" subtitle="Live device checks" />
    {error ? <Banner title={error} tone="warning" /> : null}
    {!status && !error ? <Banner title="Checking device…" /> : null}
    {servicesMode === 'mock' ? <Banner title="Mock service mode" tone="warning" /> : null}
    {rows.map(([label, ready]) => <Card key={label}><Text style={{ color: theme.text }}>{label}</Text><StatusPill label={ready ? 'Ready' : 'Review'} tone={ready ? 'success' : 'warning'} /></Card>)}
    <Banner title="Best-effort device protection" detail="Integrity and clock checks are best effort. The signing key is encrypted at rest; a hardware secp256k1 counter is not implemented." tone="warning" />
  </Screen>;
}
