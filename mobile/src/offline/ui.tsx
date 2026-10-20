import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { scanOfflineQr } from '../transport/native';
import QRCode from 'react-native-qrcode-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, useAppTheme } from '../ui';

export function OfflinePage({ title, children }: { title: string; children: ReactNode }) {
  const theme = useAppTheme();
  return <SafeAreaView style={[styles.page, { backgroundColor: theme.background }]}>
    <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>{title}</Text>
    {children}
  </SafeAreaView>;
}
export function Message({ children }: { children: ReactNode }) {
  const theme = useAppTheme();
  return <Text accessibilityLiveRegion="polite" style={[styles.message, { color: theme.text }]}>{children}</Text>;
}
export function QrDisplay({ frames }: { frames: string[] }) {
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (frames.length < 2 || paused) return;
    const timer = setInterval(() => setIndex((value) => (value + 1) % frames.length), 1500);
    return () => clearInterval(timer);
  }, [frames.length, paused]);
  const current = Math.min(index, frames.length - 1);
  const size = Math.max(120, Math.min(width - 80, height - 330, 480));
  return <View style={styles.qrArea}>
    <View style={styles.qrWhite} accessibilityLabel={`QR frame ${current + 1} of ${frames.length}`}>
      <QRCode value={frames[current]} size={size} ecl="M" backgroundColor="#FFFFFF" color="#000000" quietZone={12} />
    </View>
    <Message>{frames.length > 1 ? `Frame ${current + 1} / ${frames.length} · Keep scanning until complete` : 'Let the other device scan this QR'}</Message>
    {frames.length > 1 && <View style={styles.controls}>
      <Button title={paused ? 'Animate' : 'Pause'} variant="secondary" onPress={() => setPaused((value) => !value)} />
      <Button title="Next frame" variant="secondary" onPress={() => { setPaused(true); setIndex((value) => (value + 1) % frames.length); }} />
    </View>}
  </View>;
}
export function OfflineScanner({ onScan }: { onScan: (data: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scanning = useRef(false);
  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);
  const scan = useCallback(async () => {
    if (scanning.current) return;
    scanning.current = true; setBusy(true); setError('');
    try {
      const data = await scanOfflineQr();
      if (data !== null) await onScanRef.current(data);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to open offline scanner.'); }
    finally { scanning.current = false; setBusy(false); }
  }, []);
  useFocusEffect(useCallback(() => { void scan(); }, [scan]));
  return <>
    <Message>Scan the receiver’s OfflinePay QR. The scanner works without internet or Google Play services.</Message>
    <Button title="Scan QR" loading={busy} onPress={() => void scan()} />
    {error ? <Message>{error}</Message> : null}
  </>;
}
const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 20, paddingVertical: 12, gap: 14 },
  title: { fontSize: 26, fontWeight: '700' },
  message: { fontSize: 16, lineHeight: 23, textAlign: 'center' },
  qrArea: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  qrWhite: { backgroundColor: '#FFFFFF', padding: 12 },
  camera: { flex: 1, minHeight: 180, maxHeight: 420, overflow: 'hidden', borderRadius: 18 },
  controls: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
});
