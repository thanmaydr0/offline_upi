import { useEffect, useRef, useState } from 'react';
import { Alert, Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { services, servicesMode } from '@/services';
import { localStore, sessionStorage, setApiUrl } from '@/api/storage';
import { vpaSchema } from '@/api/schemas';
import { resetLocalData } from '@/api/reset';
import { disableSync, loadBalanceFlow, syncEngine } from '@/sync/runtime';
import { z } from 'zod';
import { Banner, Button, Card, Screen, ScreenHeader, useAppTheme } from '@/ui';

export default function SettingsScreen() {
  const theme = useAppTheme();
  const [url, setUrl] = useState('');
  const [vpa, setVpa] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    void sessionStorage.getOverride().then(value => setUrl(value ?? '')).catch(() => setMessage('Could not read API URL.'));
    void localStore.read('vpa', z.string()).then(value => setVpa(value ?? '')).catch(() => undefined);
  }, []);
  const act = async (operation: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage('');
    try { await operation(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save settings.'); }
    finally { lock.current = false; setBusy(false); }
  };
  const reset = () => Alert.alert('Reset all local data?', 'This deletes your device identity, vouchers, receipts and history. Unsynced funds may be lost. Server records remain.', [
    { text: 'Cancel', style: 'cancel' }, { text: 'Delete local data', style: 'destructive', onPress: () => { void act(async () => {
      disableSync(); loadBalanceFlow.cancel(); await Promise.all([syncEngine.idle(), loadBalanceFlow.idle()]); await resetLocalData();
    }); } },
  ]);
  const input = { color: theme.text, borderColor: theme.border, borderWidth: 1, padding: 14, borderRadius: 12 };
  return <Screen><ScreenHeader title="Settings" subtitle={`Version ${Constants.expoConfig?.version ?? 'unknown'} · ${servicesMode}`} />
    {message ? <Banner title={message} /> : null}
    <Card><Text style={{ color: theme.text }}>Backend API URL override</Text>
      <TextInput accessibilityLabel="API URL override" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url"
        placeholder={process.env.EXPO_PUBLIC_API_URL ?? 'http://192.168.1.10:3000'} placeholderTextColor={theme.textMuted} style={input} />
      <Button title="Save API URL" loading={busy} onPress={() => { void act(async () => {
        await Promise.all([syncEngine.idle(), loadBalanceFlow.idle()]);
        await setApiUrl(url); setMessage('API URL saved. Blank uses the build environment URL.');
      }); }} /></Card>
    <Card><Text style={{ color: theme.text }}>Payee UPI VPA</Text>
      <TextInput accessibilityLabel="Payee VPA" value={vpa} onChangeText={setVpa} autoCapitalize="none" autoCorrect={false} placeholder="name@bank" placeholderTextColor={theme.textMuted} style={input} />
      <Button title="Save payout VPA" loading={busy} onPress={() => { void act(async () => {
        const value = vpaSchema.parse(vpa); await services.api.setVpa(value); await localStore.write('vpa', value); setMessage('Payout VPA saved.');
      }); }} /></Card>
    <Button title="Security status" variant="secondary" onPress={() => router.push('/security')} />
    <Button title="Back to onboarding" variant="ghost" onPress={() => router.replace('/onboarding')} />
    <Button title="Reset local data" variant="danger" disabled={busy} onPress={reset} />
  </Screen>;
}
