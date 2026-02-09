import React from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { Text, Switch, List, RadioButton, Button } from 'react-native-paper';
import { useThemeStore } from '../store/useThemeStore';
import i18n from '../i18n';
import client from '../api/client';

export default function SettingsScreen() {
    const { isDark, toggleTheme } = useThemeStore();
    const [expanded, setExpanded] = React.useState(true);

    // Note: changing language dynamically requires app reload or deep reactive state for i18n
    // For simplicity we just show the UI part, functionality might need a restart or context wrapper
    const [lang, setLang] = React.useState(i18n.locale);

    const changeLang = (l: string) => {
        i18n.locale = l;
        setLang(l);
    };

    return (
        <View style={styles.container}>
            <View style={styles.row}>
                <Text variant="bodyLarge">{i18n.t('theme')} ({isDark ? i18n.t('dark') : i18n.t('light')})</Text>
                <Switch value={isDark} onValueChange={toggleTheme} />
            </View>

            <List.Section title={i18n.t('language')}>
                <List.Accordion
                    title={lang === 'en' ? 'English' : 'Español'}
                    expanded={expanded}
                    onPress={() => setExpanded(!expanded)}>
                    <List.Item title="English" onPress={() => changeLang('en')} />
                    <List.Item title="Español" onPress={() => changeLang('es')} />
                </List.Accordion>
            </List.Section>

            <View style={{ marginTop: 30 }}>
                <Button
                    mode="contained"
                    buttonColor="red"
                    onPress={() => {
                        Alert.alert(
                            "Borrar Todos los Juegos",
                            "¿Estás seguro? Esta acción borrará TODOS los juegos de tu colección y no se puede deshacer.",
                            [
                                { text: "Cancelar", style: "cancel" },
                                {
                                    text: "Borrar Todo",
                                    style: "destructive",
                                    onPress: async () => {
                                        try {
                                            await client.delete('/games/');
                                            Alert.alert("Éxito", "Colección borrada correctamente.");
                                        } catch (e) {
                                            Alert.alert("Error", "No se pudo borrar la colección.");
                                        }
                                    }
                                }
                            ]
                        );
                    }}
                >
                    Borrar Todos los Datos
                </Button>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 20,
    },
    row: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 20,
    },
});
