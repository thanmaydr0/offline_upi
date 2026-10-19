import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Linking, Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
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
  const [permission, requestPermission] = useCameraPermissions();
  const systemScannerAvailable = CameraView.isModernBarcodeScannerAvailable;
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [systemScannerOpen, setSystemScannerOpen] = useState(false);
  const [torch, setTorch] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const [scanStatus, setScanStatus] = useState('Starting camera…');
  const scanning = useRef(false);
  const lastScan = useRef(0);
  const mounted = useRef(false);
  const systemScannerPreferred = useRef(false);
  const systemScanHandled = useRef(false);
  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  const handleBarcode = useCallback(({ data }: { data: string }): Promise<void> => {
    if (scanning.current || Date.now() - lastScan.current < 350) return Promise.resolve();
    scanning.current = true;
    lastScan.current = Date.now();
    setScanStatus('QR detected. Checking it on this phone…');
    return onScanRef.current(data)
      .catch(() => setCameraError('QR detected, but could not process it. Try a fresh OfflinePay QR.'))
      .finally(() => {
        scanning.current = false;
        setScanStatus('Camera ready. Hold the complete QR inside the frame.');
      });
  }, []);
  useEffect(() => {
    if (!systemScannerOpen || !permission?.granted || !focused || !systemScannerAvailable) return;
    systemScanHandled.current = false;
    let restart: ReturnType<typeof setTimeout> | undefined;
    const subscription = CameraView.onModernBarcodeScanned(({ data }) => {
      if (systemScanHandled.current) return;
      systemScanHandled.current = true;
      if (Platform.OS === 'ios') void CameraView.dismissScanner().catch(() => {});
      void handleBarcode({ data }).finally(() => {
        // The Android system scanner closes after every QR. Reopen it for the
        // next proof frame while this scanner screen is still mounted.
        if (mounted.current && systemScannerPreferred.current) {
          restart = setTimeout(() => {
            if (!mounted.current || !systemScannerPreferred.current) return;
            systemScanHandled.current = false;
            void CameraView.launchScanner({ barcodeTypes: ['qr'] }).catch((caught: unknown) => {
              if (!mounted.current) return;
              systemScannerPreferred.current = false;
              setSystemScannerOpen(false);
              setCameraError(caught instanceof Error ? `System QR scanner could not start: ${caught.message}` : 'System QR scanner could not start. Use the camera preview below.');
              setScanStatus('Use the live camera preview to scan.');
            });
          }, 700);
        }
      });
    });
    const timer = setTimeout(() => {
      void CameraView.launchScanner({ barcodeTypes: ['qr'] }).catch((caught: unknown) => {
        if (!mounted.current) return;
        systemScannerPreferred.current = false;
        setSystemScannerOpen(false);
        setCameraError(caught instanceof Error ? `System QR scanner could not start: ${caught.message}` : 'System QR scanner could not start. Use the camera preview below.');
        setScanStatus('Use the live camera preview to scan.');
      });
    }, 250);
    return () => {
      clearTimeout(timer);
      if (restart) clearTimeout(restart);
      subscription.remove();
    };
  }, [focused, handleBarcode, permission?.granted, systemScannerAvailable, systemScannerOpen]);
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
      {focused && active && !systemScannerOpen && <CameraView style={StyleSheet.absoluteFill} facing="back" enableTorch={torch}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onCameraReady={() => { setCameraReady(true); setCameraError(''); setScanStatus('Camera ready. Hold the complete QR inside the frame.'); }}
        onMountError={({ message }) => { setCameraReady(false); setCameraError(`Camera could not start: ${message}`); setScanStatus('Camera unavailable. Check app camera permission.'); }}
        onBarcodeScanned={handleBarcode} />}
      {systemScannerOpen && <View style={styles.scannerNotice}><Message>Opening the system QR scanner…</Message></View>}
    </View>
    {systemScannerAvailable ? <Button title={systemScannerOpen ? 'Use live camera preview instead' : 'Scan QR'} variant="secondary" onPress={() => {
      systemScannerPreferred.current = !systemScannerOpen;
      setSystemScannerOpen((value) => !value);
      setCameraError('');
    }} /> : <Button title={torch ? 'Torch off' : 'Torch on'} variant="secondary" onPress={() => setTorch((value) => !value)} />}
    {cameraError ? <Message>{cameraError}</Message> : null}
    <Message>{systemScannerOpen ? 'The system scanner closes after each QR and reopens for the next proof frame.' : cameraReady ? scanStatus : focused && active ? scanStatus : 'Camera paused while this screen is not active.'}</Message>
    <Message>Only OfflinePay request and proof QR codes work here. Keep the full code visible and reduce glare.</Message>
  </>;
}
const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 20, paddingVertical: 12, gap: 14 },
  title: { fontSize: 26, fontWeight: '700' },
  message: { fontSize: 16, lineHeight: 23, textAlign: 'center' },
  qrArea: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  qrWhite: { backgroundColor: '#FFFFFF', padding: 12 },
  camera: { flex: 1, minHeight: 180, maxHeight: 420, overflow: 'hidden', borderRadius: 18 },
  scannerNotice: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111111' },
  controls: { flexDirection: 'row', gap: 12 },
});
