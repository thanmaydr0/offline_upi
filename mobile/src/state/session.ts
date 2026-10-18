import { create } from 'zustand';

type SessionState = {
  displayName: string;
  onboardingComplete: boolean;
  completeOnboarding: () => void;
  setDisplayName: (name: string) => void;
};

export const useSessionStore = create<SessionState>((set) => ({
  displayName: 'Ananya',
  onboardingComplete: false,
  completeOnboarding: () => set({ onboardingComplete: true }),
  setDisplayName: (displayName) => set({ displayName }),
}));
