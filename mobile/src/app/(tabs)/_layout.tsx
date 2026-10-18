import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';

import { useAppTheme } from '@/ui';

export default function TabsLayout() {
  const theme = useAppTheme();
  const icon = (symbol: string, color: ColorValue | undefined) => (
    <Text style={{ color: color ?? theme.text, fontSize: 19, fontWeight: '700' }}>{symbol}</Text>
  );

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textMuted,
        tabBarStyle: {
          height: 70,
          paddingTop: 7,
          paddingBottom: 8,
          backgroundColor: theme.surface,
          borderTopColor: theme.border,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: ({ color }) => icon('⌂', color) }} />
      <Tabs.Screen name="history" options={{ title: 'Activity', tabBarIcon: ({ color }) => icon('↻', color) }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: ({ color }) => icon('☼', color) }} />
    </Tabs>
  );
}
