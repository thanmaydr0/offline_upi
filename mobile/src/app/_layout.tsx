import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { useAppTheme } from '@/ui';

export default function RootLayout() {
  const theme = useAppTheme();
  return (
    <>
      <StatusBar style={theme.background === '#101713' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="load-balance" />
        <Stack.Screen name="pay" />
        <Stack.Screen name="receive" />
        <Stack.Screen name="pending" />
        <Stack.Screen name="security" />
      </Stack>
    </>
  );
}
