import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { encodePayload, type PaymentRequest, type VerifyResult } from '@offline-pay/shared';
import { offlineFlows, formatOfflineInr } from '../offline';
import { Message, OfflinePage, OfflineScanner, QrDisplay } from '../offline/ui';
import { Banner, Button, useAppTheme } from '../ui';

export default function ReceiveScreen() {
  const theme = useAppTheme();
  const [amount, setAmount] = useState('');
  const [request, setRequest] = useState<PaymentRequest | null>(null);
  const [scanning, setScanning] = useState(false);
  const [expired, setExpired] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<Extract<VerifyResult, { ok: true }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useFocusEffect(useCallback(() => {
    let current = true;
    void offlineFlows.getOpenRequest().then((open) => { if (current) setRequest(open); })
      .catch((caught: unknown) => { if (current) setError(caught instanceof Error ? caught.message : 'Cannot restore request.'); });
    return () => { current = false; };
  }, []));
  useEffect(() => {
    if (!request || result) return;
    const timer = setInterval(() => {
      void offlineFlows.getOpenRequest().then((open) => { if (!open) { setExpired(true); setScanning(false); } })
        .catch(() => { setExpired(true); setScanning(false); });
    }, 1000);
    return () => clearInterval(timer);
  }, [request, result]);
  const create = async () => {
    setBusy(true); setError('');
    try {
      if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(amount)) throw new Error('Enter an INR amount with up to two decimal places.');
      const [rupees, fraction = ''] = amount.split('.');
      const value = BigInt(rupees) * 100n + BigInt(fraction.padEnd(2, '0'));
      if (value > 0xffff_ffffn || value <= 0n) throw new Error('Enter a positive amount within the offline limit.');
      setRequest(await offlineFlows.createRequest(Number(value)));
      setExpired(false); setProgress(0); setScanning(false); setResult(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Cannot create request.'); }
    finally { setBusy(false); }
  };
  const scan = async (data: string) => {
    const verified = await offlineFlows.receiveFrame(data);
    if ('progress' in verified) { setProgress(verified.progress); setError(''); }
    else if (verified.ok) { setResult(verified); setScanning(false); setError(''); }
    else { setError(verified.reason); setProgress(0); }
  };
  if (result) return <OfflinePage title="Payment received">
    <View style={styles.success}>
      <Text style={styles.tick}>✓</Text>
      <Text style={styles.received}>Payment received</Text>
      <Text style={styles.received}>+{formatOfflineInr(result.totalInrPaise)}</Text>
      <Text style={styles.successText}>Saved on this phone while offline. It will settle when the backend is available again.</Text>
      <Text style={styles.successText}>Risk: {result.risk}</Text>
      <Text style={styles.successText}>Based on cached revocations and local unsettled exposure.</Text>
    </View>
    <Button title="Done" onPress={() => router.replace('/(tabs)')} />
  </OfflinePage>;
  return <OfflinePage title="Receive money">
    {!request ? <>
      <Message>Enter the amount in INR. After first-time setup, this transfer works without a backend or internet connection.</Message>
      <TextInput accessibilityLabel="Amount in INR" value={amount} onChangeText={setAmount} keyboardType="decimal-pad"
        maxLength={10} placeholder="0.00" placeholderTextColor={theme.textSecondary}
        style={[styles.input, { color: theme.text, borderColor: theme.border }]} />
      <Button title="Create my QR" loading={busy} onPress={() => void create()} />
    </> : <>
      <Message>{formatOfflineInr(request.inrPaise)} · {request.payee.slice(0, 8)}…{request.payee.slice(-6)}</Message>
      {expired ? <Message>Request expired after five minutes. Create a new request.</Message> : scanning ? <>
        <OfflineScanner onScan={scan} />
        <Message>Proof frames: {Math.round(progress * 100)}% · Scan in any order</Message>
        <Button title="Restart proof scan" variant="secondary" onPress={() => { offlineFlows.resetFrames(); setProgress(0); setError(''); }} />
        <Button title="Show request QR" variant="ghost" onPress={() => setScanning(false)} />
      </> : <>
        <QrDisplay frames={[encodePayload(request)]} />
        <Message>Valid for five minutes. Then scan the payer’s proof.</Message>
        <Button title="Scan payment proof" onPress={() => { offlineFlows.resetFrames(); setProgress(0); setScanning(true); }} />
      </>}
      <Button title="New amount" variant="secondary" onPress={() => { setRequest(null); setScanning(false); setError(''); }} />
    </>}
    {error ? <Banner title={error} tone="warning" /> : null}
    <Button title="Back" variant="ghost" onPress={() => router.back()} />
  </OfflinePage>;
}
const styles = StyleSheet.create({
  input: { fontSize: 36, borderWidth: 1, borderRadius: 16, padding: 16 },
  success: { flex: 1, justifyContent: 'center', alignItems: 'center', borderRadius: 24, padding: 24, gap: 20, backgroundColor: '#06743D' },
  tick: { color: '#FFFFFF', fontSize: 80 }, received: { color: '#FFFFFF', fontSize: 32, fontWeight: '800', textAlign: 'center' },
  successText: { color: '#FFFFFF', fontSize: 18, textAlign: 'center' },
});
