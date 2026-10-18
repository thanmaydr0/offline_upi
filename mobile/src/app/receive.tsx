import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PaymentRequest } from '@offline-pay/shared';

import { services } from '@/services';
import { AmountKeypad, Banner, Button, Card, NetworkBanner, Screen, ScreenHeader, formatInr, useAppTheme } from '@/ui';

function isFinder(row: number, column: number): boolean {
  return (
    (row < 5 && column < 5) ||
    (row < 5 && column > 9) ||
    (row > 9 && column < 5)
  );
}

function QrPlaceholder() {
  const theme = useAppTheme();
  return (
    <View accessibilityLabel="Sample payment QR code" style={[styles.qrFrame, { backgroundColor: '#FFFFFF', borderColor: theme.border }]}>
      {Array.from({ length: 15 }, (_, row) => (
        <View key={row} style={styles.qrRow}>
          {Array.from({ length: 15 }, (_, column) => {
            const pattern = isFinder(row, column)
              ? row === 0 || column === 0 || row === 4 || column === 4 || (row >= 2 && row <= 2 && column >= 2 && column <= 2)
              : (row * 13 + column * 7 + row * column) % 5 < 2;
            return <View key={column} style={[styles.qrCell, { backgroundColor: pattern ? '#19231D' : '#FFFFFF' }]} />;
          })}
        </View>
      ))}
    </View>
  );
}

export default function ReceiveScreen() {
  const theme = useAppTheme();
  const [value, setValue] = useState('');
  const [request, setRequest] = useState<PaymentRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const amountPaise = Number(value || '0') * 100;

  const createQr = async () => {
    setLoading(true);
    setError('');
    try {
      const next = await services.offline.createRequest(amountPaise);
      setRequest(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not make your QR code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <ScreenHeader title="Receive money" subtitle="Set an amount and show your QR code." />
      <NetworkBanner />

      {!request ? (
        <>
          <Card style={styles.amountCard}>
            <Text style={[styles.amountLabel, { color: theme.textSecondary }]}>REQUEST AMOUNT</Text>
            <Text style={[styles.amount, { color: theme.text }]}>{formatInr(amountPaise)}</Text>
            <Text style={[styles.helper, { color: theme.textSecondary }]}>Enter a whole rupee amount.</Text>
          </Card>
          <AmountKeypad value={value} onChange={setValue} maxDigits={5} />
          {error ? <Banner title={error} tone="warning" icon="!" /> : null}
          <Button title="Create my QR" fullWidth disabled={amountPaise <= 0} loading={loading} onPress={createQr} />
        </>
      ) : (
        <>
          <Card style={styles.qrCard}>
            <View style={[styles.qrOwner, { backgroundColor: theme.accentSoft }]}>
              <Text style={[styles.qrOwnerText, { color: theme.accent }]}>A</Text>
            </View>
            <Text style={[styles.qrName, { color: theme.text }]}>Ananya Sharma</Text>
            <Text style={[styles.amount, { color: theme.text }]}>{formatInr(request.inrPaise)}</Text>
            <QrPlaceholder />
            <Text style={[styles.helper, { color: theme.textSecondary }]}>Let the other person scan to pay.</Text>
            <View style={[styles.demoLabel, { backgroundColor: theme.surfaceMuted }]}>
              <Text style={[styles.demoLabelText, { color: theme.textSecondary }]}>DEMO QR · SAMPLE ONLY</Text>
            </View>
          </Card>
          <Button title="Create another QR" variant="secondary" fullWidth onPress={() => setRequest(null)} />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  amountCard: { alignItems: 'center', paddingVertical: 24, gap: 7 },
  amountLabel: { fontSize: 10, lineHeight: 14, letterSpacing: 1.1, fontWeight: '800' },
  amount: { fontSize: 36, lineHeight: 44, fontWeight: '700', letterSpacing: -0.7 },
  helper: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
  qrCard: { alignItems: 'center', gap: 11, paddingVertical: 20 },
  qrOwner: { width: 38, height: 38, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  qrOwnerText: { fontSize: 17, fontWeight: '800' },
  qrName: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  qrFrame: { padding: 10, borderWidth: 1, borderRadius: 12, marginVertical: 5 },
  qrRow: { flexDirection: 'row' },
  qrCell: { width: 9, height: 9 },
  demoLabel: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6 },
  demoLabelText: { fontSize: 9, lineHeight: 13, fontWeight: '800', letterSpacing: 0.8 },
});
