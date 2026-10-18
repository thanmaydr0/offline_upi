import { useRef, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { PaymentRequest } from '@offline-pay/shared';
import { offlineFlows, formatOfflineInr } from '../offline';
import { Message, OfflinePage, OfflineScanner, QrDisplay } from '../offline/ui';
import { Banner, Button, useAppTheme } from '../ui';

export default function PayScreen() {
  const theme = useAppTheme();
  const [preview, setPreview] = useState<{ request: PaymentRequest; balanceAfterPaise: bigint } | null>(null);
  const [frames, setFrames] = useState<string[] | null>(null);
  const [remainingBalancePaise, setRemainingBalancePaise] = useState<bigint | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const paying = useRef(false);
  const seenScans = useRef(new Set<string>());
  const scan = async (data: string) => {
    if (seenScans.current.has(data)) { setError('Request scanned twice. Scan a fresh request.'); return; }
    try {
      const request = await offlineFlows.parseRequestQr(data);
      const next = await offlineFlows.previewRequest(request);
      seenScans.current.add(data);
      setError(''); setRemainingBalancePaise(null); setPreview(next);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Invalid request QR.'); }
  };
  const pay = async () => {
    if (!preview || paying.current) return;
    paying.current = true; setBusy(true); setError('');
    try {
      const proof = await offlineFlows.payRequest(preview.request);
      setRemainingBalancePaise(preview.balanceAfterPaise);
      setFrames(proof); setPreview(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Payment failed.'); }
    finally { paying.current = false; setBusy(false); }
  };
  return <OfflinePage title={frames ? 'Show payment proof' : 'Pay nearby'}>
    {frames ? <>
      <Message>Vouchers spent. Show every frame to the receiver.</Message>
      {remainingBalancePaise !== null && <Message>Updated offline balance on this phone: {formatOfflineInr(remainingBalancePaise)}</Message>}
      <QrDisplay frames={frames} />
      <Message>Wait for their “Payment received” screen. Closing this proof cannot undo the payment or generate it again.</Message>
      <Button title="Done — close proof" onPress={() => { setFrames(null); router.replace('/(tabs)'); }} />
    </> : <>
      <Message>Scan the receiver’s OfflinePay request. It works in airplane mode after both phones have synced once and the payer has loaded vouchers.</Message>
      {!preview && <OfflineScanner onScan={scan} />}
      {error ? <Banner title={error} tone="warning" /> : null}
      <Button title="Back" variant="ghost" disabled={busy} onPress={() => router.back()} />
      <Modal visible={preview !== null} transparent animationType="slide" onRequestClose={() => { if (!busy) setPreview(null); }}>
        <View style={styles.scrim}><View style={[styles.sheet, { backgroundColor: theme.background }]}>
          <Text style={[styles.heading, { color: theme.text }]}>Confirm offline payment</Text>
          {preview && <>
            <Message>{preview.request.name ?? `${preview.request.payee.slice(0, 8)}…${preview.request.payee.slice(-6)}`}</Message>
            {preview.request.name && <Message>{`${preview.request.payee.slice(0, 8)}…${preview.request.payee.slice(-6)} · Name supplied by QR`}</Message>}
            <Text style={[styles.amount, { color: theme.text }]}>{formatOfflineInr(preview.request.inrPaise)}</Text>
            <Message>Offline balance after payment: {formatOfflineInr(preview.balanceAfterPaise)}</Message>
          </>}
          {error ? <Banner title={error} tone="warning" /> : null}
          <Button title="Authenticate and pay" loading={busy} onPress={() => void pay()} />
          <Button title="Cancel" variant="ghost" disabled={busy} onPress={() => setPreview(null)} />
          <Message>One biometric approval signs all selected vouchers.</Message>
        </View></View>
      </Modal>
    </>}
  </OfflinePage>;
}
const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { padding: 24, paddingBottom: 40, gap: 16, borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  heading: { fontSize: 22, fontWeight: '700' }, amount: { fontSize: 38, fontWeight: '700', textAlign: 'center' },
});
