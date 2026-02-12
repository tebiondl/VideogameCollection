import React, { useState } from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { TextInput, Button, Text, ActivityIndicator } from 'react-native-paper';
import { useAuthStore } from '../store/useAuthStore';
import { useNavigation } from '@react-navigation/native';
import { useThemeStore } from '../store/useThemeStore';
import i18n from '../i18n';
import client from '../api/client';

export default function LoginScreen() {
    const [username, setUserName] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const login = useAuthStore((state) => state.login);
    const navigation = useNavigation<any>();
    const isDark = useThemeStore((state) => state.isDark);

    const handleLogin = async () => {
        if (!username || !password) return;
        setLoading(true);
        try {
            const formData = new FormData();
            formData.append('username', username);
            formData.append('password', password);

            const response = await client.post('/users/token', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });

            const { access_token } = response.data;
            await login(access_token, username);
            navigation.goBack();
        } catch (error: any) {
            console.error('Login error details:', {
                message: error?.message,
                status: error?.response?.status,
                data: error?.response?.data,
                code: error?.code,
            });
            const detail = error?.response?.data?.detail || error?.message || 'Unknown error';
            Alert.alert('Error', `Login failed: ${detail}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <View style={styles.container}>
            <Text variant="headlineMedium" style={styles.title}>{i18n.t('login')}</Text>
            <TextInput
                label={i18n.t('username')}
                value={username}
                onChangeText={setUserName}
                style={styles.input}
                autoCapitalize="none"
            />
            <TextInput
                label={i18n.t('password')}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                style={styles.input}
            />
            {loading ? (
                <ActivityIndicator animating={true} />
            ) : (
                <Button mode="contained" onPress={handleLogin} style={styles.button}>
                    {i18n.t('login')}
                </Button>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 20,
        justifyContent: 'center',
    },
    title: {
        textAlign: 'center',
        marginBottom: 20,
    },
    input: {
        marginBottom: 10,
    },
    button: {
        marginTop: 10,
    },
});
