import axios from 'axios';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

// Auto-detect the dev machine IP from Expo's host URI
const getBaseUrl = () => {
    const hostUri = Constants.expoConfig?.hostUri; // e.g. "192.168.1.59:8081"
    if (hostUri) {
        const ip = hostUri.split(':')[0];
        return `http://${ip}:8000`;
    }
    // Fallback
    return 'http://192.168.1.59:8000';
};

const BASE_URL = getBaseUrl();

const client = axios.create({
    baseURL: BASE_URL,
    headers: {
        'Content-Type': 'application/json',
    },
});

// Add a request interceptor to attach the token
client.interceptors.request.use(
    async (config) => {
        const isLoginRequest = config.url?.includes('/users/token');
        if (!isLoginRequest) {
            const token = await AsyncStorage.getItem('user-token');
            if (token) {
                config.headers.Authorization = `Bearer ${token}`;
            }
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

export default client;
