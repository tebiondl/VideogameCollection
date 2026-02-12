import React, { useState } from 'react';
import { View, ScrollView, StyleSheet, Alert } from 'react-native';
import { Button, Text, Card, ActivityIndicator, RadioButton, ProgressBar, useTheme, Surface } from 'react-native-paper';
import * as DocumentPicker from 'expo-document-picker';
import client from '../api/client';
import i18n from '../i18n';
import { useNavigation } from '@react-navigation/native';

type SheetInfo = {
    sheet_name: string;
    row_count: number;
    headers: string[];
};

type ConflictItem = {
    row_index: number;
    game_id: number;
    existing: any;
    new_data: any;
};

type ResolutionItem = {
    game_id: number;
    choice: 'new' | 'existing';
    new_data?: any;
};

export default function ImportAIScreen() {
    const theme = useTheme();
    const navigation = useNavigation();
    const [step, setStep] = useState(1); // 1: File, 2: Sheet, 3: Status, 4: Processing, 5: Conflicts, 6: Done
    const [loading, setLoading] = useState(false);

    // File & Sheet Data
    const [fileAsset, setFileAsset] = useState<any>(null);
    const [sheets, setSheets] = useState<SheetInfo[]>([]);
    const [selectedSheet, setSelectedSheet] = useState<string | null>(null);

    // Configuration
    const [statusChoice, setStatusChoice] = useState<'backlog' | 'finished'>('backlog');
    const [strategy, setStrategy] = useState<'update' | 'skip'>('update');
    const [titleColumn, setTitleColumn] = useState<string | null>(null);

    // Results
    const [results, setResults] = useState<{
        processed: number;
        created: number;
        updated: number;
        skipped: number;
        conflicts: ConflictItem[];
    } | null>(null);

    // Conflict Resolution
    const [resolutions, setResolutions] = useState<Record<number, 'new' | 'existing'>>({});

    const pickFile = async () => {
        try {
            const res = await DocumentPicker.getDocumentAsync({
                type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
                copyToCacheDirectory: true
            });

            if (!res.canceled) {
                setFileAsset(res.assets[0]);
                analyzeFile(res.assets[0]);
            }
        } catch (err) {
            console.error(err);
        }
    };

    const analyzeFile = async (asset: any) => {
        setLoading(true);
        try {
            const formData = new FormData();
            formData.append('file', {
                uri: asset.uri,
                name: asset.name,
                type: asset.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            } as any);

            const res = await client.post('/import/ai/analyze', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });

            setSheets(res.data.sheets);
            setStep(2);
        } catch (e) {
            Alert.alert("Error", "Could not analyze file");
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const handleProcess = async () => {
        if (!selectedSheet || !fileAsset) return;

        setLoading(true);
        setStep(4); // Processing UI

        try {
            const formData = new FormData();
            formData.append('file', {
                uri: fileAsset.uri,
                name: fileAsset.name,
                type: fileAsset.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            } as any);
            formData.append('sheet_name', selectedSheet);
            formData.append('status_choice', statusChoice);
            formData.append('processing_strategy', strategy);
            if (titleColumn) formData.append('title_column', titleColumn);

            // Using standard HTTP request - for long files this might verify timeout vs sockets
            // But for reasonable sizes it works.
            const res = await client.post('/import/ai/upload', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
                timeout: 3600000, // 1 hour
            });

            const data = res.data;
            setResults(data);

            if (data.conflicts && data.conflicts.length > 0) {
                // Pre-fill resolutions with 'existing' (safe default)
                const initialResolutions: Record<number, 'new' | 'existing'> = {};
                data.conflicts.forEach((c: ConflictItem) => {
                    initialResolutions[c.game_id] = 'existing';
                });
                setResolutions(initialResolutions);
                setStep(5);
            } else {
                setStep(6);
            }
        } catch (e) {
            Alert.alert("Error", "AI processing failed");
            console.error(e);
            setStep(3); // Go back
        } finally {
            setLoading(false);
        }
    };

    const handleResolve = async () => {
        if (!results) return;

        setLoading(true);
        try {
            const resolutionList: ResolutionItem[] = results.conflicts.map(c => ({
                game_id: c.game_id,
                choice: resolutions[c.game_id],
                new_data: resolutions[c.game_id] === 'new' ? c.new_data : undefined
            }));

            const res = await client.post('/import/ai/resolve', { resolutions: resolutionList });

            // Update counts locally for final summary
            const resolvedCount = res.data.resolved;
            setResults(prev => prev ? {
                ...prev,
                updated: prev.updated + resolvedCount,
                conflicts: [] // Clear conflicts as they are resolved
            } : null);

            setStep(6);
        } catch (e) {
            Alert.alert("Error", "Could not submit resolutions");
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const renderConflict = (conflict: ConflictItem) => {
        const resolution = resolutions[conflict.game_id];
        const isNew = resolution === 'new';

        // Helper to compare fields
        const renderFieldDiff = (label: string, oldVal: any, newVal: any) => {
            if (oldVal === newVal || (oldVal === null && newVal === null)) return null;

            // Format descriptive values
            const format = (v: any) => v === null ? 'Empty' : String(v);

            return (
                <View style={styles.diffRow} key={label}>
                    <Text variant="bodySmall" style={{ width: 80, fontWeight: 'bold' }}>{label}</Text>
                    <Text variant="bodySmall" style={{ flex: 1, color: theme.colors.outline }}>{format(oldVal)}</Text>
                    <Text variant="bodySmall" style={{ marginHorizontal: 5 }}>→</Text>
                    <Text variant="bodySmall" style={{ flex: 1, color: theme.colors.primary }}>{format(newVal)}</Text>
                </View>
            );
        };

        return (
            <Card key={conflict.game_id} style={[styles.card, { borderColor: isNew ? theme.colors.primary : theme.colors.outline }]}>
                <Card.Content>
                    <Text variant="titleMedium" style={{ marginBottom: 10 }}>{conflict.existing.title}</Text>

                    <View style={{ marginBottom: 15 }}>
                        {Object.keys(conflict.new_data).map(key => {
                            if (key === 'title') return null;
                            return renderFieldDiff(key, conflict.existing[key], conflict.new_data[key]);
                        })}
                    </View>

                    <View style={styles.resolutionActions}>
                        <Button
                            mode={!isNew ? "contained" : "outlined"}
                            onPress={() => setResolutions({ ...resolutions, [conflict.game_id]: 'existing' })}
                            style={{ marginRight: 10, flex: 1 }}
                            icon="history"
                        >
                            Mantener ({conflict.existing.status || '?'})
                        </Button>
                        <Button
                            mode={isNew ? "contained" : "outlined"}
                            onPress={() => setResolutions({ ...resolutions, [conflict.game_id]: 'new' })}
                            style={{ flex: 1 }}
                            icon="creation"
                        >
                            Usar Nuevo
                        </Button>
                    </View>
                </Card.Content>
            </Card>
        );
    };

    return (
        <ScrollView contentContainerStyle={styles.container}>
            {loading && step !== 4 && <ActivityIndicator animating={true} style={styles.loader} />}

            {/* STEP 1: SELECT FILE */}
            {step === 1 && (
                <View style={styles.centerContainer}>
                    <Text variant="headlineMedium" style={{ marginBottom: 20, textAlign: 'center' }}>
                        Importación con IA
                    </Text>
                    <Text style={{ marginBottom: 30, textAlign: 'center', color: theme.colors.secondary }}>
                        Selecciona un archivo Excel. La IA analizará cada fila para extraer la información automáticamente.
                    </Text>
                    <Button icon="file-excel" mode="contained" onPress={pickFile} contentStyle={{ height: 60 }}>
                        Seleccionar Excel
                    </Button>
                </View>
            )}

            {/* STEP 2: SELECT SHEET */}
            {step === 2 && (
                <View>
                    <Text variant="titleLarge" style={{ marginBottom: 20 }}>Selecciona la Hoja</Text>
                    {sheets.map(sheet => (
                        <Card key={sheet.sheet_name} style={styles.card} onPress={() => {
                            setSelectedSheet(sheet.sheet_name);
                            setStep(3);
                        }}>
                            <Card.Title
                                title={sheet.sheet_name}
                                subtitle={`${sheet.row_count} filas detected`}
                                left={(props) => <Text {...props} variant="titleLarge">📄</Text>}
                            />
                        </Card>
                    ))}
                </View>
            )}

            {/* STEP 3: SET STATUS CONFIG */}
            {step === 3 && (
                <View>
                    <Text variant="titleLarge" style={{ marginBottom: 20 }}>Configuración</Text>

                    <Card style={styles.card}>
                        <Card.Content>
                            <Text variant="titleMedium">Estado por defecto</Text>
                            <Text variant="bodySmall" style={{ marginBottom: 10, color: theme.colors.secondary }}>
                                Forzará este estado para los nuevos juegos.
                            </Text>

                            <RadioButton.Group onValueChange={val => setStatusChoice(val as any)} value={statusChoice}>
                                <View style={styles.radioRow}>
                                    <RadioButton value="backlog" />
                                    <Text>Empezados / Backlog</Text>
                                </View>
                                <View style={styles.radioRow}>
                                    <RadioButton value="finished" />
                                    <Text>Terminados</Text>
                                </View>
                            </RadioButton.Group>
                        </Card.Content>
                    </Card>

                    <Card style={styles.card}>
                        <Card.Content>
                            <Text variant="titleMedium">Estrategia de Proceso</Text>
                            <RadioButton.Group onValueChange={val => setStrategy(val as any)} value={strategy}>
                                <View style={styles.radioRow}>
                                    <RadioButton value="update" />
                                    <Text>Analizar Todo (Actualizar)</Text>
                                </View>
                                <View style={styles.radioRow}>
                                    <RadioButton value="skip" />
                                    <Text>Saltar Existentes (Ahorrar llamadas)</Text>
                                </View>
                            </RadioButton.Group>

                            {strategy === 'skip' && (
                                <View style={{ marginTop: 15 }}>
                                    <Text variant="bodyMedium" style={{ marginBottom: 5 }}>¿Qué columna tiene el Título?</Text>
                                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                                        {sheets.find(s => s.sheet_name === selectedSheet)?.headers.map(h => (
                                            <Button
                                                key={h}
                                                mode={titleColumn === h ? 'contained' : 'outlined'}
                                                onPress={() => setTitleColumn(h)}
                                                compact
                                                style={{ marginRight: 5 }}
                                            >
                                                {h}
                                            </Button>
                                        ))}
                                    </ScrollView>
                                    {!titleColumn && <Text style={{ color: theme.colors.error, marginTop: 5 }}>Selecciona una columna para poder saltar.</Text>}
                                </View>
                            )}
                        </Card.Content>
                    </Card>

                    <Button
                        mode="contained"
                        onPress={handleProcess}
                        style={{ marginTop: 20 }}
                        contentStyle={{ height: 50 }}
                        disabled={strategy === 'skip' && !titleColumn}
                    >
                        Comenzar Procesamiento con IA
                    </Button>
                </View>
            )}

            {/* STEP 4: PROCESSING */}
            {step === 4 && (
                <View style={styles.centerContainer}>
                    <ActivityIndicator size="large" animating={true} style={{ marginBottom: 30 }} />
                    <Text variant="titleLarge" style={{ marginBottom: 10 }}>Analizando Juegos...</Text>
                    <Text style={{ textAlign: 'center', color: theme.colors.secondary, marginBottom: 20 }}>
                        Esto puede tomar unos minutos dependiendo del número de filas.
                        La IA está leyendo tu Excel...
                    </Text>
                    <ProgressBar indeterminate visible={true} style={{ width: 200 }} />
                </View>
            )}

            {/* STEP 5: CONFLICTS */}
            {step === 5 && results && (
                <View>
                    <Text variant="headlineSmall" style={{ marginBottom: 10 }}>Conflictos Detectados</Text>
                    <Text style={{ marginBottom: 20, color: theme.colors.secondary }}>
                        Se encontraron {results.conflicts.length} juegos que ya existen con datos diferentes.
                        Elige qué versión guardar.
                    </Text>

                    {results.conflicts.map(renderConflict)}

                    <Button mode="contained" onPress={handleResolve} style={{ marginTop: 20, marginBottom: 40 }}>
                        Confirmar Resoluciones
                    </Button>
                </View>
            )}

            {/* STEP 6: SUMMARY */}
            {step === 6 && results && (
                <View style={[styles.centerContainer, { justifyContent: 'flex-start' }]}>
                    <Text variant="displaySmall" style={{ color: theme.colors.primary, marginBottom: 20 }}>¡Importación Completada!</Text>

                    <Surface style={styles.statsContainer} elevation={2}>
                        <View style={styles.statItem}>
                            <Text variant="displayMedium">{results.created}</Text>
                            <Text>Nuevos</Text>
                        </View>
                        <View style={styles.statItem}>
                            <Text variant="displayMedium">{results.updated}</Text>
                            <Text>Actualizados</Text>
                        </View>
                        <View style={styles.statItem}>
                            <Text variant="displayMedium">{results.skipped}</Text>
                            <Text>Saltados</Text>
                        </View>
                    </Surface>

                    <Button mode="contained" onPress={() => navigation.navigate('MainMenu' as never)} style={{ marginTop: 40, width: '100%' }}>
                        Volver al Menú
                    </Button>
                </View>
            )}

        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { padding: 20, flexGrow: 1 },
    centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    loader: { marginBottom: 20 },
    card: { marginBottom: 15 },
    radioRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
    diffRow: { flexDirection: 'row', marginBottom: 5, paddingVertical: 2, borderBottomWidth: 0.5, borderColor: '#eee' },
    resolutionActions: { flexDirection: 'row', marginTop: 15 },
    statsContainer: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', padding: 20, borderRadius: 10, backgroundColor: 'white' },
    statItem: { alignItems: 'center' }
});
