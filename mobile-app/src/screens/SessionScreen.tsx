import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, Button, Avatar } from 'react-native-paper';
import { useAuthStore } from '../store/useAuthStore';
import i18n from '../i18n';

export default function SessionScreen() {
    const { user, logout } = useAuthStore();

    if (!user) {
        return (
            <View style={styles.container}>
                <Text>Not logged in</Text>
            </View>
        )
    }

    return (
        <View style={styles.container}>
            <Avatar.Text size={80} label={user.username.substring(0, 2).toUpperCase()} />
            <Text variant="headlineMedium" style={styles.name}>{user.username}</Text>

            <Button mode="outlined" onPress={logout} style={styles.button} textColor="red">
                {i18n.t('logout')}
            </Button>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    name: {
        marginTop: 10,
        marginBottom: 30,
    },
    button: {
        marginTop: 20,
    },
});
