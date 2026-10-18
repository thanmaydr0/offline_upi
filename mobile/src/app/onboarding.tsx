import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useSessionStore } from '@/state/session';
import { Button, Screen, StatusPill, typeScale, useAppTheme } from '@/ui';

export default function OnboardingScreen() {
  const theme = useAppTheme();
  const completeOnboarding = useSessionStore((state) => state.completeOnboarding);
  const getStarted = () => {
    completeOnboarding();
    router.replace('/(tabs)');
  };

  return (
    <Screen scroll={false} contentStyle={styles.content}>
      <View style={styles.topLine}>
        <Text style={[styles.brand, { color: theme.text }]}>offline<Text style={{ color: theme.accent }}>pay</Text></Text>
        <StatusPill label="Made for India" tone="success" />
      </View>

      <View style={styles.hero}>
        <View style={[styles.orbit, { borderColor: theme.border }]}>
          <View style={[styles.heroCircle, { backgroundColor: theme.accent }]}>
            <Text style={styles.rupee}>₹</Text>
          </View>
          <View style={[styles.orbitDot, styles.dotOne, { backgroundColor: theme.accentBright }]} />
          <View style={[styles.orbitDot, styles.dotTwo, { backgroundColor: theme.warning }]} />
          <View style={[styles.orbitDot, styles.dotThree, { backgroundColor: theme.accent }]} />
        </View>
      </View>

      <View style={styles.copy}>
        <Text style={[styles.eyebrow, { color: theme.accent }]}>PAYMENTS, EVEN OFFLINE</Text>
        <Text style={[typeScale.display, styles.title, { color: theme.text }]}>Money moves with you.</Text>
        <Text style={[typeScale.body, styles.subtitle, { color: theme.textSecondary }]}>
          Pay nearby when the internet drops. Your payments sync when you’re back online.
        </Text>
      </View>

      <View style={styles.bottom}>
        <Button title="Get started" fullWidth onPress={getStarted} />
        <Text style={[styles.note, { color: theme.textMuted }]}>A simple demo with sample balances and payments.</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, justifyContent: 'space-between', paddingTop: 18, paddingBottom: 18 },
  topLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { fontSize: 20, lineHeight: 28, fontWeight: '800', letterSpacing: -0.6 },
  hero: { flex: 1, minHeight: 215, alignItems: 'center', justifyContent: 'center' },
  orbit: { width: 212, height: 212, borderRadius: 110, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  heroCircle: { width: 132, height: 132, borderRadius: 44, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-8deg' }] },
  rupee: { color: '#FFFFFF', fontSize: 66, lineHeight: 76, fontWeight: '600', transform: [{ rotate: '8deg' }] },
  orbitDot: { width: 17, height: 17, borderRadius: 9, position: 'absolute' },
  dotOne: { top: 21, right: 42 },
  dotTwo: { bottom: 30, right: 10, width: 11, height: 11 },
  dotThree: { bottom: 21, left: 32, width: 12, height: 12 },
  copy: { gap: 13, paddingBottom: 24 },
  eyebrow: { fontSize: 11, lineHeight: 15, fontWeight: '800', letterSpacing: 1.3 },
  title: { maxWidth: 330 },
  subtitle: { maxWidth: 310 },
  bottom: { gap: 12 },
  note: { textAlign: 'center', fontSize: 11, lineHeight: 16 },
});
