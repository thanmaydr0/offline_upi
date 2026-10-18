import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { services } from '@/services';
import { useSecurityStore } from '@/state/security';
import { Banner, Card, NetworkBanner, Screen, ScreenHeader, SectionDivider, StatusPill, useAppTheme } from '@/ui';

export default function SecurityScreen() {
  const theme = useAppTheme();
  const biometricsEnrolled = useSecurityStore((state) => state.biometricsEnrolled);
  const deviceIntegrity = useSecurityStore((state) => state.deviceIntegrity);
  const secureKeyReady = useSecurityStore((state) => state.secureKeyReady);
  const ledgerIntact = useSecurityStore((state) => state.ledgerIntact);
  const lastSync = useSecurityStore((state) => state.lastSync);
  const setCheck = useSecurityStore((state) => state.setCheck);

  useEffect(() => {
    let active = true;
    void Promise.all([services.keys.init(), services.keys.integrity(), services.ledger.verifyChain()]).then(
      ([key, integrity, ledger]) => {
        if (!active) return;
        setCheck('secureKeyReady', Boolean(key.address));
        setCheck('deviceIntegrity', !integrity.rooted && integrity.isDevice);
        setCheck('ledgerIntact', ledger.ok);
      },
    );
    return () => {
      active = false;
    };
  }, [setCheck]);

  const rows = [
    { title: 'Biometrics enrolled', detail: 'Approval for sensitive payments', ready: biometricsEnrolled },
    { title: 'Device integrity', detail: 'Device checks are passing', ready: deviceIntegrity },
    { title: 'Secure key', detail: 'Ready for payment approval', ready: secureKeyReady },
    { title: 'Ledger intact', detail: 'Local payment history verified', ready: ledgerIntact },
  ];

  return (
    <Screen>
      <ScreenHeader title="Security status" subtitle="A quick check of your payment setup." />
      <NetworkBanner />
      <Card style={styles.overview}>
        <View style={[styles.overviewIcon, { backgroundColor: theme.accentSoft }]}>
          <Text style={[styles.overviewIconText, { color: theme.accent }]}>✓</Text>
        </View>
        <View style={styles.overviewCopy}>
          <Text style={[styles.overviewTitle, { color: theme.text }]}>You’re all set</Text>
          <Text style={[styles.overviewDetail, { color: theme.textSecondary }]}>Your device is ready for the demo.</Text>
        </View>
        <StatusPill label="Protected" tone="success" />
      </Card>

      <Card style={styles.checklist}>
        <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>DEVICE CHECKLIST</Text>
        {rows.map((row, index) => (
          <View key={row.title}>
            <View style={styles.checkRow}>
              <View style={[styles.checkIcon, { backgroundColor: row.ready ? theme.successSoft : theme.warningSoft }]}>
                <Text style={[styles.checkIconText, { color: row.ready ? theme.success : theme.warning }]}>{row.ready ? '✓' : '!'}</Text>
              </View>
              <View style={styles.checkCopy}>
                <Text style={[styles.checkTitle, { color: theme.text }]}>{row.title}</Text>
                <Text style={[styles.checkDetail, { color: theme.textSecondary }]}>{row.detail}</Text>
              </View>
              <StatusPill label={row.ready ? 'Ready' : 'Review'} tone={row.ready ? 'success' : 'warning'} />
            </View>
            {index < rows.length - 1 ? <SectionDivider /> : null}
          </View>
        ))}
        <SectionDivider />
        <View style={styles.lastSync}>
          <View style={[styles.checkIcon, { backgroundColor: theme.surfaceMuted }]}>
            <Text style={[styles.checkIconText, { color: theme.accent }]}>↻</Text>
          </View>
          <View style={styles.checkCopy}>
            <Text style={[styles.checkTitle, { color: theme.text }]}>Last sync</Text>
            <Text style={[styles.checkDetail, { color: theme.textSecondary }]}>{lastSync}</Text>
          </View>
          <StatusPill label="Up to date" tone="success" />
        </View>
      </Card>

      <Banner
        title="Demo checks are best-effort"
        detail="The live security protections are not enabled in this sample build."
        tone="warning"
        icon="i"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  overview: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
  overviewIcon: { width: 48, height: 48, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  overviewIconText: { fontSize: 25, fontWeight: '800' },
  overviewCopy: { flex: 1, gap: 3 },
  overviewTitle: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  overviewDetail: { fontSize: 11, lineHeight: 16 },
  checklist: { paddingHorizontal: 16, paddingVertical: 18, gap: 5 },
  sectionLabel: { fontSize: 10, lineHeight: 14, letterSpacing: 1, fontWeight: '800', marginBottom: 4 },
  checkRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 10 },
  lastSync: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkIcon: { width: 39, height: 39, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  checkIconText: { fontSize: 16, fontWeight: '800' },
  checkCopy: { flex: 1, gap: 3 },
  checkTitle: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  checkDetail: { fontSize: 10, lineHeight: 15 },
});
