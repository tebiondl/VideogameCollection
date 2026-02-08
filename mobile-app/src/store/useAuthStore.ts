import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import client from '../api/client';

type User = {
    id: number;
    username: string;
};

type AuthState = {
    token: string | null;
    user: User | null;
    isLoading: boolean;
    login: (token: string, username: string) => Promise<void>;
    logout: () => Promise<void>;
    checkAuth: () => Promise<void>;
};

export const useAuthStore = create<AuthState>((set, get) => ({
    token: null,
    user: null,
    isLoading: true,
    login: async (token, username) => {
        await AsyncStorage.setItem('user-token', token);
        await AsyncStorage.setItem('user-username', username);
        set({ token, user: { id: 0, username }, isLoading: false }); // We fetch full user details if needed later
        // Could fetch user /me here
        try {
            const res = await client.get('/users/me');
            set({ user: res.data });
        } catch (e) {
            console.error("Failed to fetch user details", e);
        }
    },
    logout: async () => {
        await AsyncStorage.removeItem('user-token');
        await AsyncStorage.removeItem('user-username');
        set({ token: null, user: null, isLoading: false });
    },
    checkAuth: async () => {
        set({ isLoading: true });
        try {
            const token = await AsyncStorage.getItem('user-token');
            const username = await AsyncStorage.getItem('user-username');
            if (token && username) {
                set({ token, user: { id: 0, username } });
                // Validate token by fetching me
                const res = await client.get('/users/me');
                set({ user: res.data, isLoading: false });
            } else {
                set({ token: null, user: null, isLoading: false });
            }
        } catch (e) {
            // Token invalid or network error
            set({ token: null, user: null, isLoading: false });
        }
    },
}));
