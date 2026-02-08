import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Provider as PaperProvider, MD3LightTheme, MD3DarkTheme } from 'react-native-paper';
import { useThemeStore } from '../store/useThemeStore';
import { LightTheme, DarkTheme } from '../theme/theme';

import MainMenuScreen from '../screens/MainMenuScreen';
import LoginScreen from '../screens/LoginScreen';
import SessionScreen from '../screens/SessionScreen';
import GamesListScreen from '../screens/GamesListScreen';
import GameDetailScreen from '../screens/GameDetailScreen';
import SettingsScreen from '../screens/SettingsScreen';
import i18n from '../i18n';

const Stack = createNativeStackNavigator();

export default function RootNavigator() {
    const isDark = useThemeStore((state) => state.isDark);

    // Merge custom theme with Paper theme
    const paperTheme = isDark ? { ...MD3DarkTheme, colors: { ...MD3DarkTheme.colors, ...DarkTheme.colors } }
        : { ...MD3LightTheme, colors: { ...MD3LightTheme.colors, ...LightTheme.colors } };

    const navTheme = {
        ...(isDark ? DarkTheme : LightTheme),
        fonts: isDark ? MD3DarkTheme.fonts : MD3LightTheme.fonts, // Hack to satisfy NavigationContainer theme type
    };

    return (
        <PaperProvider theme={paperTheme}>
            <NavigationContainer theme={navTheme as any}>
                <Stack.Navigator initialRouteName="MainMenu">
                    <Stack.Screen name="MainMenu" component={MainMenuScreen} options={{ headerShown: false }} />
                    <Stack.Screen name="Login" component={LoginScreen} options={{ title: i18n.t('login') }} />
                    <Stack.Screen name="Session" component={SessionScreen} options={{ title: 'Session' }} />
                    <Stack.Screen name="GamesToPlay" component={GamesListScreen} initialParams={{ mode: 'backlog' }} options={{ title: i18n.t('gamesToPlay') }} />
                    <Stack.Screen name="GamesFinished" component={GamesListScreen} initialParams={{ mode: 'finished' }} options={{ title: i18n.t('gamesFinished') }} />
                    <Stack.Screen name="GameDetail" component={GameDetailScreen} options={{ title: 'Game Details' }} />
                    <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: i18n.t('settings') }} />
                </Stack.Navigator>
            </NavigationContainer>
        </PaperProvider>
    );
}
