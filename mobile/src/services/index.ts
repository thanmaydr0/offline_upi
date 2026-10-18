import { mockServices } from './mock';

type ServiceBundle = typeof mockServices;

const useMocks = process.env.EXPO_PUBLIC_USE_MOCKS === '1';

/*
 * TODO: wire the real KeyService and VoucherWallet from src/core, the ApiClient
 * from src/api, and OfflineFlows from src/offline as those sessions land.
 * Keep mocks as the safe development fallback until the complete bundle exists.
 */
const realServices: ServiceBundle | undefined = undefined;

export const services: ServiceBundle = useMocks ? mockServices : realServices ?? mockServices;
export const servicesMode = useMocks || !realServices ? 'mock' : 'real';
