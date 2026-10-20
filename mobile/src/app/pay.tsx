import { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { offlineFlows, formatOfflineInr } from '../offline';
import { Message, OfflinePage, OfflineScanner } from '../offline/ui';
import { Banner, Button, useAppTheme } from '../ui';
import { deliverPayment, pendingDelivery, prepareDelivery, rememberedPeer } from '../transport';
import { localLink, pairedPhones } from '../transport/native';
import { parseInvite, type LocalInvite } from '../transport/protocol';
import { voucherWallet } from '../core/wallet';
import { disableSync } from '../sync/runtime';

export default function PayScreen() {
  const theme = useAppTheme();
  const [invite, setInvite] = useState<LocalInvite | null>(null);
  const [frames, setFrames] = useState<string[] | null>(null);
  const [peers, setPeers] = useState<{ address: string; name: string }[]>([]);
  const [peer, setPeer] = useState('');
  const [after, setAfter] = useState<bigint | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const paying = useRef(false);
  useEffect(() => {
    disableSync();
    let active = true;
    void pendingDelivery().then(async pending => {
      if (!active || !pending) return;
      setInvite(pending.invite); setFrames(pending.frames); setPeer(pending.peer);
      setAfter(await voucherWallet.offlineBalancePaise());
      setStatus('Payment saved. Retry delivery to receive confirmation. You will not be charged twice.');
    }).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : 'Cannot restore payment.'); })
      .finally(() => { if (active) setHydrated(true); });
    return () => { active = false; void localLink().disconnect().catch(() => undefined); };
  }, []);
  const refreshPeers = async (next = invite) => {
    try {
      const phones = await pairedPhones(); setPeers(phones);
      const previous = next ? await rememberedPeer(next) : null;
      if (previous && phones.some(phone => phone.address === previous)) setPeer(previous);
      else if (phones.length === 1) setPeer(phones[0].address);
      else setPeer('');
      setError(phones.length ? '' : 'Pair the two phones in Bluetooth settings, then refresh this list.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Cannot read paired phones.'); }
  };
  const scan = async (data: string) => {
    try {
      const parsed = parseInvite(data);
      const preview = await offlineFlows.previewRequest(parsed.request);
      setInvite(parsed); setAfter(preview.balanceAfterPaise); setError('');
      await refreshPeers(parsed);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Invalid request QR.'); }
  };
  const pay = async () => {
    if (!invite || !peer || paying.current) return;
    paying.current = true; setBusy(true); setError('');
    try {
      setStatus('Connecting to the receiver over Bluetooth…');
      await prepareDelivery(invite, peer);
      setStatus('Approve the payment on this phone…');
      const proof = await offlineFlows.payRequest(invite.request);
      setFrames(proof);
      setStatus('Sending payment and waiting for the receiver to save it…');
      await deliverPayment(invite, proof);
      setConfirmed(true); setStatus('Receiver verified and saved this payment.');
    } catch (caught) {
      const pending = await pendingDelivery().catch(() => null);
      if (pending) { setFrames(pending.frames); setStatus('Payment is saved. Retry delivery; do not pay again.'); }
      setError(caught instanceof Error ? caught.message : 'Local payment could not complete.');
    } finally { paying.current = false; setBusy(false); }
  };
  const retry = async () => {
    if (!invite || !frames || paying.current) return;
    paying.current = true; setBusy(true); setError('');
    try {
      setStatus('Reconnecting and delivering the same signed payment…');
      await deliverPayment(invite, frames, true);
      setConfirmed(true); setStatus('Receiver verified and saved this payment.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Keep Receive open on the other phone and retry.'); }
    finally { paying.current = false; setBusy(false); }
  };
  return <OfflinePage title={confirmed ? 'Payment delivered' : frames ? 'Payment delivery pending' : 'Pay nearby'}>
    {!hydrated ? <Message>Checking saved payments…</Message> : frames ? <>
      <Message>{status}</Message>
      {invite && <Text style={[styles.amount, { color: theme.text }]}>{formatOfflineInr(invite.request.inrPaise)}</Text>}
      {after !== null && <Message>Offline balance after payment: {formatOfflineInr(after)}</Message>}
      {!confirmed && <Button title="Retry delivery — no second charge" loading={busy} onPress={() => void retry()} />}
      <Button title={confirmed ? 'Done' : 'Close — keep payment saved'} disabled={busy} onPress={() => router.replace('/(tabs)')} />
    </> : <>
      <Message>Keep Receive open on the other phone. Both phones need Bluetooth on; internet can stay off.</Message>
      {!invite && <OfflineScanner onScan={scan} />}
      <Button title="Back" variant="ghost" disabled={busy} onPress={() => router.back()} />
      <Modal visible={invite !== null} transparent animationType="slide" onRequestClose={() => { if (!busy) setInvite(null); }}>
        <View style={styles.scrim}><View style={[styles.sheet, { backgroundColor: theme.background }]}><ScrollView contentContainerStyle={styles.sheetContent}>
          <Text style={[styles.heading, { color: theme.text }]}>Confirm offline payment</Text>
          {invite && <>
            <Message>{invite.request.payee.slice(0, 8)}…{invite.request.payee.slice(-6)}</Message>
            <Text style={[styles.amount, { color: theme.text }]}>{formatOfflineInr(invite.request.inrPaise)}</Text>
          </>}
          <Message>Select the receiver’s paired phone:</Message>
          {peers.map(phone => <Button key={phone.address} title={`${peer === phone.address ? '✓ ' : ''}${phone.name}`} variant="secondary" disabled={busy} onPress={() => setPeer(phone.address)} />)}
          <Button title="Bluetooth pairing settings" variant="ghost" disabled={busy} onPress={() => { void localLink().openBluetoothSettings().catch(caught => setError(String(caught))); }} />
          <Button title="Refresh paired phones" variant="ghost" disabled={busy} onPress={() => void refreshPeers()} />
          {status ? <Message>{status}</Message> : null}
          {error ? <Banner title={error} tone="warning" /> : null}
          <Button title="Authenticate and pay" disabled={!peer} loading={busy} onPress={() => void pay()} />
          <Button title="Cancel" variant="ghost" disabled={busy} onPress={() => setInvite(null)} />
        </ScrollView></View></View>
      </Modal>
    </>}
    {error && (!invite || frames) ? <Banner title={error} tone="warning" /> : null}
  </OfflinePage>;
}
const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '90%', borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  sheetContent: { padding: 24, paddingBottom: 40, gap: 12 },
  heading: { fontSize: 22, fontWeight: '700' }, amount: { fontSize: 38, fontWeight: '700', textAlign: 'center' },
});
