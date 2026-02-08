import { create } from 'zustand';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persist, createJSONStorage } from 'zustand/middleware';

type ThemeState = {
    isDark: boolean;
    toggleTheme: () => void;
    setTheme: (isDark: boolean) => void;
};

export const useThemeStore = create<ThemeState>()(
    persist(
        (set) => ({
            isDark: true, // Default as requested
            toggleTheme: () => set((state) => ({ isDark: !state.isDark })),
            setTheme: (isDark) => set({ isDark }),
        }),
        {
            name: 'theme-storage',
            storage: createJSONStorage(() => AsyncStorage),
        }
    )
);
