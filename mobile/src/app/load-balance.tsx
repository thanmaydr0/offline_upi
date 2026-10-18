import { useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { services } from '@/services';
import { useBalanceStore } from '@/state/balances';
import { useHistoryStore } from '@/state/history';
import {
  Banner,
  Button,
  Card,
  Chip,
  LoadingOverlay,
  NetworkBanner,
  Screen,
  ScreenHeader,
  StatusPill,
  formatInr,
  typeScale,
  useAppTheme,
} from '@/ui';

const suggestedAmounts = [200, 500, 1_000, 2_000, 5_000];
type Step = 1 | 2 | 3 | 4;

export default function LoadBalanceScreen() {
  const theme = useAppTheme();
  const [amount, setAmount] = useState(500);
  const [step, setStep] = useState<Step>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const addOfflinePaise = useBalanceStore((state) => state.addOfflinePaise);
  const addTransaction = useHistoryStore((state) => state.addTransaction);

  const verifyIdentity = async () => {
    setLoading(true);
    setError('');
    try {
      await services.api.startKyc();
      const status = await services.api.kycStatus();
      if (status !== 'approved') throw new Error('Please try the identity check again.');
      setStep(3);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const payWithUpi = async () => {
    setLoading(true);
    setError('');
    try {
      const order = await services.api.createOnramp(amount);
      const paymentStatus = await services.api.onrampStatus(order.orderId);
      if (paymentStatus !== 'paid') throw new Error('The sample payment did not complete. Please try again.');
      const items = await services.api.issueVouchers(order.orderId);
      await services.wallet.addIssued(items);
      const amountPaise = amount * 100;
      addOfflinePaise(amountPaise);
      addTransaction({
        id: `load-${Date.now()}`,
        title: 'Money added',
        subtitle: 'Just now · UPI',
        amountPaise,
        direction: 'in',
        status: 'completed',
        date: 'Today',
        icon: '＋',
      });
      setStep(4);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const selectedPaise = amount * 100;
  const stepTitle = ['Choose amount', 'Identity check', 'Pay with UPI', 'You’re offline-ready'][step - 1];

  return (
    <Screen>
      <ScreenHeader
        eyebrow={`STEP ${Math.min(step, 3)} OF 3`}
        title="Get offline-ready"
        subtitle={stepTitle}
      />
      <View style={styles.progress}>
        {[1, 2, 3].map((item) => (
          <View key={item} style={[styles.progressBar, { backgroundColor: item <= step ? theme.accent : theme.border }]} />
        ))}
      </View>
      <NetworkBanner />

      {step === 1 ? (
        <>
          <Card style={styles.amountCard}>
            <Text style={[styles.caption, { color: theme.textSecondary }]}>ADD TO OFFLINE BALANCE</Text>
            <Text style={[styles.amountText, { color: theme.text }]}>{formatInr(selectedPaise)}</Text>
            <Text style={[styles.helper, { color: theme.textSecondary }]}>Choose an amount to keep handy without signal.</Text>
          </Card>
          <View style={styles.chips}>
            {suggestedAmounts.map((value) => (
              <Chip
                key={value}
                label={formatInr(value * 100)}
                selected={amount === value}
                onPress={() => setAmount(value)}
              />
            ))}
          </View>
          <Button title="Continue" fullWidth onPress={() => setStep(2)} />
          <Text style={[styles.note, { color: theme.textMuted }]}>You can use this balance for nearby payments when offline.</Text>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <Card style={styles.stepCard}>
            <View style={[styles.stepIcon, { backgroundColor: theme.accentSoft }]}>
              <Text style={[styles.stepIconText, { color: theme.accent }]}>✓</Text>
            </View>
            <Text style={[typeScale.heading, { color: theme.text }]}>A quick identity check</Text>
            <Text style={[styles.helper, { color: theme.textSecondary }]}>
              This one-time check helps keep offline payments safer. It only takes a moment in this demo.
            </Text>
            <StatusPill label="One time only" tone="success" />
          </Card>
          {error ? <Banner title={error} tone="warning" icon="!" /> : null}
          <Button title="Verify and continue" fullWidth loading={loading} onPress={verifyIdentity} />
          <Button title="Back" variant="ghost" fullWidth onPress={() => setStep(1)} />
        </>
      ) : null}

      {step === 3 ? (
        <>
          <Card style={styles.upiCard}>
            <View style={styles.upiHeading}>
              <View style={[styles.upiMark, { backgroundColor: theme.surfaceMuted }]}>
                <Text style={[styles.upiMarkText, { color: theme.accent }]}>UPI</Text>
              </View>
              <View style={styles.upiCopy}>
                <Text style={[typeScale.heading, { color: theme.text }]}>Pay with UPI</Text>
                <Text style={[styles.helper, { color: theme.textSecondary }]}>A secure payment step in your banking app</Text>
              </View>
            </View>
            <View style={[styles.amountLine, { borderTopColor: theme.border }]}>
              <Text style={[styles.helper, { color: theme.textSecondary }]}>Amount to add</Text>
              <Text style={[styles.amountLineValue, { color: theme.text }]}>{formatInr(selectedPaise)}</Text>
            </View>
            <Text style={[styles.demoNote, { color: theme.textMuted }]}>Demo mode · payment completes automatically</Text>
          </Card>
          {error ? <Banner title={error} tone="warning" icon="!" /> : null}
          <Button title={`Pay ${formatInr(selectedPaise)} with UPI`} fullWidth loading={loading} onPress={payWithUpi} />
          <Button title="Back" variant="ghost" fullWidth onPress={() => setStep(2)} />
        </>
      ) : null}

      {step === 4 ? (
        <>
          <Card style={styles.completeCard}>
            <View style={[styles.completeMark, { backgroundColor: theme.accentSoft }]}>
              <Text style={[styles.completeMarkText, { color: theme.accent }]}>✓</Text>
            </View>
            <Text style={[styles.completeTitle, { color: theme.text }]}>You’re ready to go</Text>
            <Text style={[styles.helper, { color: theme.textSecondary }]}>{formatInr(selectedPaise)} added to your offline balance.</Text>
            <StatusPill label="Balance updated" tone="success" />
          </Card>
          <Button title="Back to home" fullWidth onPress={() => router.replace('/(tabs)')} />
        </>
      ) : null}

      <LoadingOverlay visible={loading} label={step === 2 ? 'Checking details' : 'Completing payment'} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  progress: { flexDirection: 'row', gap: 7 },
  progressBar: { height: 4, flex: 1, borderRadius: 2 },
  amountCard: { alignItems: 'center', paddingVertical: 27, gap: 8 },
  caption: { fontSize: 10, lineHeight: 14, letterSpacing: 1, fontWeight: '800' },
  amountText: { fontSize: 38, lineHeight: 46, letterSpacing: -0.8, fontWeight: '700' },
  helper: { fontSize: 13, lineHeight: 19 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  note: { textAlign: 'center', fontSize: 11, lineHeight: 16 },
  stepCard: { alignItems: 'center', gap: 13, paddingVertical: 28 },
  stepIcon: { width: 56, height: 56, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  stepIconText: { fontSize: 27, fontWeight: '800' },
  upiCard: { gap: 20 },
  upiHeading: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  upiMark: { width: 54, height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  upiMarkText: { fontSize: 13, fontWeight: '900', letterSpacing: 0.4 },
  upiCopy: { flex: 1, gap: 3 },
  amountLine: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  amountLineValue: { fontSize: 17, lineHeight: 23, fontWeight: '700' },
  demoNote: { fontSize: 11, lineHeight: 16, textAlign: 'center' },
  completeCard: { alignItems: 'center', gap: 12, paddingVertical: 30 },
  completeMark: { width: 66, height: 66, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  completeMarkText: { fontSize: 34, fontWeight: '800' },
  completeTitle: { fontSize: 23, lineHeight: 30, fontWeight: '700' },
});
