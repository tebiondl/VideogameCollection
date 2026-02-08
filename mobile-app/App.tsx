import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import RootNavigator from './src/navigation';
import { useAuthStore } from './src/store/useAuthStore';
import { StatusBar } from 'expo-status-bar';
import { useThemeStore } from './src/store/useThemeStore';


export default function App() {
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const isDark = useThemeStore((state) => state.isDark);

  useEffect(() => {
    checkAuth();
  }, []);

  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      <RootNavigator />
    </>
  );
}
