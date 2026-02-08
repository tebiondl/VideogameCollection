import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Text, Avatar, Button, Card } from 'react-native-paper';
import { useAuthStore } from '../store/useAuthStore';
import { useNavigation } from '@react-navigation/native';
import { useThemeStore } from '../store/useThemeStore';
import i18n from '../i18n';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function MainMenuScreen() {
    const { user, logout } = useAuthStore();
    const navigation = useNavigation<any>();
    const isDark = useThemeStore((state) => state.isDark);

    const handleSessionPress = () => {
        if (user) {
            // Go to profile? For now just show logout option or alert
            // User requested: "al apartado de cuenta" -> Which just has logout
            navigation.navigate('Session');
        } else {
            navigation.navigate('Login');
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            {/* Session Button (Top Left) */}
            <View style={styles.header}>
                <TouchableOpacity style={styles.sessionButton} onPress={handleSessionPress}>
                    <Avatar.Icon size={40} icon="account" />
                    <Text style={styles.sessionText}>
                        {user ? user.username : i18n.t('login')}
                    </Text>
                </TouchableOpacity>
            </View>

            <View style={styles.grid}>
                <Card style={styles.card} onPress={() => navigation.navigate('GamesToPlay')}>
                    <Card.Content>
                        <Text variant="titleLarge">{i18n.t('gamesToPlay')}</Text>
                    </Card.Content>
                </Card>

                <Card style={styles.card} onPress={() => navigation.navigate('GamesFinished')}>
                    <Card.Content>
                        <Text variant="titleLarge">{i18n.t('gamesFinished')}</Text>
                    </Card.Content>
                </Card>

                <Card style={styles.card} onPress={() => navigation.navigate('Settings')}>
                    <Card.Content>
                        <Text variant="titleLarge">{i18n.t('settings')}</Text>
                    </Card.Content>
                </Card>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 10,
    },
    header: {
        flexDirection: 'row',
        marginBottom: 20,
    },
    sessionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(0,0,0,0.05)',
        padding: 5,
        borderRadius: 20,
    },
    sessionText: {
        marginLeft: 10,
        fontWeight: 'bold',
    },
    grid: {
        flex: 1,
        flexDirection: 'column',
        gap: 20,
    },
    card: {
        padding: 20,
        justifyContent: 'center',
        alignItems: 'center',
    },
});
