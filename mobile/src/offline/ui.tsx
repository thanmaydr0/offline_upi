import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Linking, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
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
    const timer = setInterval(() => setIndex((value) => (value + 1) % frames.length), 1000);
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
  const [permission, requestPermission] = useCameraPermissions();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [torch, setTorch] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const scanning = useRef(false);
  const lastScan = useRef(0);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  if (!permission) return <Message>Checking camera permission…</Message>;
  if (!permission.granted) return <>
    <Message>Allow camera access to scan QR codes offline.</Message>
    <Button title={permission.canAskAgain ? 'Allow camera' : 'Open app settings'} onPress={() => {
      void (permission.canAskAgain ? requestPermission() : Linking.openSettings()).catch(() => setCameraError('Camera permission could not be opened.'));
    }} />
    {cameraError ? <Message>{cameraError}</Message> : null}
  </>;
  return <>
    <View style={styles.camera}>
      {focused && active && <CameraView style={StyleSheet.absoluteFill} facing="back" enableTorch={torch}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onMountError={({ message }) => setCameraError(message)}
        onBarcodeScanned={({ data }) => {
          if (scanning.current || Date.now() - lastScan.current < 350) return;
          scanning.current = true; lastScan.current = Date.now();
          void onScan(data).catch(() => setCameraError('Could not read QR. Try again.')).finally(() => { scanning.current = false; });
        }} />}
    </View>
    <Button title={torch ? 'Torch off' : 'Torch on'} variant="secondary" onPress={() => setTorch((value) => !value)} />
    {cameraError ? <Message>{cameraError}</Message> : null}
    <Message>Hold steady. Reduce glare and keep the whole QR visible.</Message>
  </>;
}
const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 20, paddingVertical: 12, gap: 14 },
  title: { fontSize: 26, fontWeight: '700' },
  message: { fontSize: 16, lineHeight: 23, textAlign: 'center' },
  qrArea: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  qrWhite: { backgroundColor: '#FFFFFF', padding: 12 },
  camera: { flex: 1, minHeight: 180, maxHeight: 420, overflow: 'hidden', borderRadius: 18 },
  controls: { flexDirection: 'row', gap: 12 },
});
