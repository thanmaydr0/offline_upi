import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import type { VerifyResult } from '@offline-pay/shared';
import { offlineFlows, formatOfflineInr } from '../offline';
import { Message, OfflinePage, QrDisplay } from '../offline/ui';
import { Banner, Button, useAppTheme } from '../ui';
import { answerHello, lastReceiverInvite, receiverInvite, receiveRadioProof, startReceiving } from '../transport';
import { localLink } from '../transport/native';
import { inviteQr, type LocalInvite } from '../transport/protocol';
import { disableSync } from '../sync/runtime';
import { receivedStore } from '../core/received';

export default function ReceiveScreen() {
  const theme = useAppTheme();
  const [amount, setAmount] = useState('');
  const [invite, setInvite] = useState<LocalInvite | null>(null);
  const [result, setResult] = useState<Extract<VerifyResult, { ok: true }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');
  const activeSession = useRef<string | null>(null);
  const inFlight = useRef(0);
  const current = useRef(true);
  useEffect(() => {
    current.current = true;
    return () => { current.current = false; };
  }, []);
  const listen = useCallback(async (next: LocalInvite) => {
    activeSession.current = next.request.reqId;
    await startReceiving(next.request.reqId);
    if (current.current) {
      setInvite(next); setConnected(true);
      const prior = await receivedStore.findVerified(next.request.reqId);
      if (prior) setResult({ ok: true, risk: 'high', totalInrPaise: prior.items.reduce((sum, item) => sum + BigInt(item.voucher.inrPaise), 0n) });
      else setExpired(await offlineFlows.getOpenRequest() === null);
    }
  }, []);
  useFocusEffect(useCallback(() => {
    disableSync();
    const link = localLink();
    let active = true;
    const hello = link.addListener('hello', event => {
      if (event.session !== activeSession.current) {
        void link.respond(event.id, JSON.stringify({ error: 'Receiving request changed.' })).catch(() => undefined);
        return;
      }
      void answerHello(event).catch(() => { void link.respond(event.id, JSON.stringify({ error: 'Unable to authenticate receiver.' })).catch(() => undefined); });
    });
    const proof = link.addListener('proof', event => {
      if (event.session !== activeSession.current) {
        void link.respond(event.id, JSON.stringify({ error: 'Receiving request changed.' })).catch(() => undefined);
        return;
      }
      inFlight.current++;
      if (active) setBusy(true);
      void receiveRadioProof(event).then(verified => {
        if (active && event.session === activeSession.current) { setResult(verified); setError(''); }
      }).catch(caught => {
        const message = caught instanceof Error ? caught.message : 'Invalid payment proof.';
        void link.respond(event.id, JSON.stringify({ error: message })).catch(() => undefined);
        if (active && event.session === activeSession.current) setError(message);
      }).finally(() => { inFlight.current--; if (active && inFlight.current === 0) setBusy(false); });
    });
    const errors = link.addListener('linkError', event => { if (active) { setConnected(false); setError(event.message); } });
    void offlineFlows.getOpenRequest().then(async request => {
      const restored = request ? await receiverInvite(request) : await lastReceiverInvite();
      if (active && restored) await listen(restored);
    }).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : 'Cannot restore receiving session.'); });
    return () => { active = false; hello.remove(); proof.remove(); errors.remove(); void link.disconnect().catch(() => undefined); };
  }, [listen]));
  useEffect(() => {
    if (!invite || result) return;
    let active = true;
    const timer = setInterval(() => {
      void offlineFlows.getOpenRequest().then(open => { if (active) setExpired(open === null); }).catch(() => undefined);
    }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [invite, result]);
  const create = async () => {
    setBusy(true); setError('');
    try {
      if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(amount)) throw new Error('Enter an INR amount with up to two decimal places.');
      const [rupees, fraction = ''] = amount.split('.');
      const value = BigInt(rupees) * 100n + BigInt(fraction.padEnd(2, '0'));
      if (value <= 0n || value > 0xffff_ffffn) throw new Error('Enter a positive amount within the offline limit.');
      const request = await offlineFlows.createRequest(Number(value));
      const next = await receiverInvite(request);
      await listen(next);
      setResult(null); setExpired(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Cannot start receiving.'); }
    finally { setBusy(false); }
  };
  return <OfflinePage title={result ? 'Payment received' : 'Receive money'}>
    {result ? <>
      <View style={styles.success}>
        <Text style={styles.tick}>✓</Text>
        <Text style={styles.received}>+{formatOfflineInr(result.totalInrPaise)}</Text>
        <Text style={styles.successText}>Verified and saved on this phone without internet. The payer has been sent confirmation over Bluetooth.</Text>
        <Text style={styles.successText}>Received credit is pending backend settlement after reconnection.</Text>
      </View>
      <Button title="Done" onPress={() => router.replace('/(tabs)')} />
    </> : invite ? <>
      <Message>{formatOfflineInr(invite.request.inrPaise)} · Keep this screen open</Message>
      {expired ? <Message>This request expired. Tap New amount to create a fresh QR.</Message> : <QrDisplay frames={[inviteQr(invite)]} />}
      <Message>{busy ? 'Verifying and saving the payment locally…' : connected ? 'Listening over Bluetooth. The payer scans this QR and pays; no second scan is needed.' : 'Bluetooth stopped. Turn it on and tap Reconnect.'}</Message>
      <Button title="Reconnect Bluetooth" variant="secondary" disabled={busy} onPress={() => { void listen(invite).catch(caught => setError(String(caught))); }} />
    </> : <>
      <Message>Internet is not needed after setup. Switch Bluetooth on and pair these two phones in Android settings once.</Message>
      <TextInput accessibilityLabel="Amount in INR" value={amount} onChangeText={setAmount} keyboardType="decimal-pad"
        maxLength={10} placeholder="0.00" placeholderTextColor={theme.textSecondary}
        style={[styles.input, { color: theme.text, borderColor: theme.border }]} />
      <Button title="Create my QR and receive" loading={busy} onPress={() => void create()} />
      <Button title="Bluetooth pairing settings" variant="secondary" onPress={() => { void localLink().openBluetoothSettings().catch(caught => setError(String(caught))); }} />
    </>}
    {invite && <Button title="New amount" variant="secondary" disabled={busy} onPress={() => {
      activeSession.current = null; setInvite(null); setResult(null); setError(''); setConnected(false);
      void localLink().disconnect().catch(() => undefined);
    }} />}
    {error ? <Banner title={error} tone="warning" /> : null}
    <Button title="Back" variant="ghost" disabled={busy} onPress={() => router.back()} />
  </OfflinePage>;
}
const styles = StyleSheet.create({
  input: { fontSize: 36, borderWidth: 1, borderRadius: 16, padding: 16 },
  success: { flex: 1, justifyContent: 'center', alignItems: 'center', borderRadius: 24, padding: 24, gap: 20, backgroundColor: '#06743D' },
  tick: { color: '#FFFFFF', fontSize: 80 }, received: { color: '#FFFFFF', fontSize: 32, fontWeight: '800', textAlign: 'center' },
  successText: { color: '#FFFFFF', fontSize: 18, textAlign: 'center' },
});
