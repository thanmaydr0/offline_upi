import { useState } from 'react';
import { router } from 'expo-router';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { services } from '@/services';
import { useBalanceStore } from '@/state/balances';
import { useHistoryStore } from '@/state/history';
import { Banner, Button, Card, NetworkBanner, Screen, ScreenHeader, StatusPill, formatInr, typeScale, useAppTheme } from '@/ui';

const DEMO_AMOUNT_PAISE = 50_000;

export default function PayScreen() {
  const theme = useAppTheme();
  const offlinePaise = useBalanceStore((state) => state.offlinePaise);
  const spendOfflinePaise = useBalanceStore((state) => state.spendOfflinePaise);
  const addTransaction = useHistoryStore((state) => state.addTransaction);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [paid, setPaid] = useState(false);

  const confirmPayment = async () => {
    setLoading(true);
    setError('');
    try {
      const request = await services.offline.createRequest(DEMO_AMOUNT_PAISE);
      await services.offline.payRequest(request);
      spendOfflinePaise(DEMO_AMOUNT_PAISE);
      addTransaction({
        id: `pay-${Date.now()}`,
        title: 'Corner Store',
        subtitle: 'Just now · Offline',
        amountPaise: DEMO_AMOUNT_PAISE,
        direction: 'out',
        status: 'completed',
        date: 'Today',
        icon: '⌂',
      });
      setPaid(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Payment could not be completed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const closeSheet = () => {
    setConfirmOpen(false);
    setPaid(false);
    setError('');
  };

  return (
    <Screen>
      <ScreenHeader title="Pay nearby" subtitle="Scan a merchant’s payment QR code." />
      <NetworkBanner />

      <View style={[styles.scanner, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }]}>
        <View style={[styles.cameraWindow, { borderColor: theme.accent }]}>
          <View style={[styles.corner, styles.cornerTopLeft, { borderColor: theme.accent }]} />
          <View style={[styles.corner, styles.cornerTopRight, { borderColor: theme.accent }]} />
          <View style={[styles.corner, styles.cornerBottomLeft, { borderColor: theme.accent }]} />
          <View style={[styles.corner, styles.cornerBottomRight, { borderColor: theme.accent }]} />
          <View style={[styles.scanLine, { backgroundColor: theme.accentBright }]} />
          <View style={[styles.cameraIcon, { backgroundColor: theme.accentSoft }]}>
            <Text style={[styles.cameraIconText, { color: theme.accent }]}>⌗</Text>
          </View>
        </View>
        <Text style={[styles.scannerTitle, { color: theme.text }]}>Point your camera at a QR code</Text>
        <Text style={[styles.scannerDetail, { color: theme.textSecondary }]}>Keep the code inside the frame to scan.</Text>
      </View>

      <Banner
        title="Offline payments are ready"
        detail={`${formatInr(offlinePaise)} available for nearby payments`}
        tone="success"
        icon="✓"
      />

      <Card style={styles.demoCard}>
        <View style={styles.demoHeading}>
          <Text style={[typeScale.heading, { color: theme.text }]}>Try a sample payment</Text>
          <StatusPill label="Demo" />
        </View>
        <Text style={[styles.scannerDetail, { color: theme.textSecondary }]}>Send {formatInr(DEMO_AMOUNT_PAISE)} to Corner Store and see the confirmation flow.</Text>
        <Button
          title="Review sample payment"
          fullWidth
          disabled={offlinePaise < DEMO_AMOUNT_PAISE}
          onPress={() => setConfirmOpen(true)}
        />
        {offlinePaise < DEMO_AMOUNT_PAISE ? (
          <Text style={[styles.smallNote, { color: theme.warning }]}>Add more money to your offline balance to try this demo.</Text>
        ) : null}
      </Card>

      <Modal visible={confirmOpen} animationType="slide" transparent onRequestClose={closeSheet}>
        <Pressable style={styles.scrim} onPress={closeSheet} accessibilityLabel="Close payment sheet">
          <Pressable style={[styles.sheet, { backgroundColor: theme.background }]} onPress={() => undefined}>
            <View style={[styles.sheetHandle, { backgroundColor: theme.border }]} />
            {paid ? (
              <>
                <View style={[styles.successMark, { backgroundColor: theme.accentSoft }]}>
                  <Text style={[styles.successMarkText, { color: theme.accent }]}>✓</Text>
                </View>
                <Text style={[styles.sheetTitle, { color: theme.text }]}>Payment complete</Text>
                <Text style={[styles.sheetDetail, { color: theme.textSecondary }]}>
                  {formatInr(DEMO_AMOUNT_PAISE)} sent to Corner Store.
                </Text>
                <StatusPill label="Saved on this device" tone="success" />
                <Button title="Done" fullWidth onPress={() => { closeSheet(); router.replace('/(tabs)'); }} />
              </>
            ) : (
              <>
                <Text style={[styles.sheetEyebrow, { color: theme.accent }]}>CONFIRM PAYMENT</Text>
                <Text style={[styles.sheetTitle, { color: theme.text }]}>Corner Store</Text>
                <Text style={[styles.sheetAmount, { color: theme.text }]}>{formatInr(DEMO_AMOUNT_PAISE)}</Text>
                <View style={[styles.sheetSummary, { borderColor: theme.border }]}>
                  <Text style={[styles.sheetDetail, { color: theme.textSecondary }]}>Paying from</Text>
                  <Text style={[styles.sheetSummaryValue, { color: theme.text }]}>Offline balance</Text>
                </View>
                {error ? <Banner title={error} tone="warning" icon="!" /> : null}
                <Button title="Confirm and pay" fullWidth loading={loading} onPress={confirmPayment} />
                <Button title="Cancel" fullWidth variant="ghost" onPress={closeSheet} />
                <Text style={[styles.smallNote, { color: theme.textMuted }]}>Approve with your device security check.</Text>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scanner: { borderRadius: 24, borderWidth: 1, padding: 19, alignItems: 'center', gap: 10 },
  cameraWindow: { width: 218, height: 218, borderWidth: 1, borderRadius: 25, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  corner: { width: 27, height: 27, position: 'absolute', borderWidth: 3 },
  cornerTopLeft: { left: 13, top: 13, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 8 },
  cornerTopRight: { right: 13, top: 13, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 8 },
  cornerBottomLeft: { left: 13, bottom: 13, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 8 },
  cornerBottomRight: { right: 13, bottom: 13, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 8 },
  scanLine: { position: 'absolute', height: 2, width: 155, opacity: 0.8 },
  cameraIcon: { width: 54, height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  cameraIconText: { fontSize: 30, lineHeight: 35, fontWeight: '700' },
  scannerTitle: { fontSize: 14, lineHeight: 19, fontWeight: '700', marginTop: 7 },
  scannerDetail: { fontSize: 12, lineHeight: 18 },
  demoCard: { gap: 13 },
  demoHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  smallNote: { fontSize: 11, lineHeight: 16, textAlign: 'center' },
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(10,16,12,0.48)' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 22, paddingTop: 12, paddingBottom: 30, gap: 15 },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 4 },
  sheetEyebrow: { fontSize: 10, lineHeight: 14, letterSpacing: 1.2, fontWeight: '800' },
  sheetTitle: { fontSize: 23, lineHeight: 30, fontWeight: '700' },
  sheetAmount: { fontSize: 35, lineHeight: 43, fontWeight: '700', letterSpacing: -0.5 },
  sheetDetail: { fontSize: 13, lineHeight: 19 },
  sheetSummary: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetSummaryValue: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  successMark: { width: 60, height: 60, borderRadius: 21, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginTop: 8 },
  successMarkText: { fontSize: 30, fontWeight: '800' },
});
