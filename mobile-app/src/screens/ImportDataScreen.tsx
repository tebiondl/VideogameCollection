import React, { useState, useEffect } from 'react';
import { View, ScrollView, StyleSheet, Alert, Platform } from 'react-native';
import { Button, Text, Card, ActivityIndicator, RadioButton, TextInput, Modal, Portal, List, IconButton } from 'react-native-paper';
import * as DocumentPicker from 'expo-document-picker';
import client from '../api/client';
import { useAuthStore } from '../store/useAuthStore';
import i18n from '../i18n';

// Types matches backend
type MappingProposal = {
    selected: string | null;
    score: number;
    alternatives: string[];
};

type SheetAnalysis = {
    sheet_name: string;
    headers: string[];
    row_count: number;
    mapping_proposal: Record<string, MappingProposal>;
};

const DB_COLUMNS = [
    { key: "title", label: "Title" },
    { key: "status", label: "Status" },
    { key: "hype_score", label: "Hype Score" },
    { key: "rating", label: "Rating" },
    { key: "progress", label: "Progress" },
    { key: "playtime_hours", label: "Playtime" },
    { key: "finish_year", label: "Finish Year" },
    { key: "release_year", label: "Release Year" },
    { key: "price", label: "Price" },
    { key: "platform", label: "Platform" },
    { key: "steam_deck", label: "Steam Deck" },
    { key: "notes", label: "Notes" },
];

export default function ImportDataScreen() {
    const [step, setStep] = useState(1); // 1: Select File, 2: Select Sheet, 3: Map Columns, 4: Execute/Result
    const [loading, setLoading] = useState(false);
    const [analysis, setAnalysis] = useState<SheetAnalysis[]>([]);
    const [selectedSheet, setSelectedSheet] = useState<SheetAnalysis | null>(null);
    const [mapping, setMapping] = useState<Record<string, string | null>>({});
    const [mergeStrategy, setMergeStrategy] = useState('fill');
    const [sheetRows, setSheetRows] = useState<Record<string, any[]>>({});
    const [valueMapping, setValueMapping] = useState<Record<string, Record<string, any>>>({});
    const [mappingModalVisible, setMappingModalVisible] = useState(false);
    const [headerModalVisible, setHeaderModalVisible] = useState(false);
    const [activeColKey, setActiveColKey] = useState<string | null>(null);

    const pickFile = async () => {
        try {
            const res = await DocumentPicker.getDocumentAsync({
                type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv'],
                copyToCacheDirectory: true
            });

            if (!res.canceled) {
                // setFileUri(res.assets[0]); // Not used currently
                analyze(res.assets[0]);
            }
        } catch (err) {
            console.error(err);
        }
    };

    const analyze = async (fileAsset: any) => {
        setLoading(true);
        try {
            const formData = new FormData();
            formData.append('file', {
                uri: fileAsset.uri,
                name: fileAsset.name,
                type: fileAsset.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            } as any);

            const res = await client.post('/import/analyze', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });

            setAnalysis(res.data.results);
            setSheetRows(res.data.rows_map);
            setStep(2);
        } catch (e) {
            Alert.alert("Error", "Could not analyze file");
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const handleSheetSelect = (sheet: SheetAnalysis) => {
        setSelectedSheet(sheet);
        // Initialize mapping from proposal
        const initialMap: Record<string, string | null> = {};
        DB_COLUMNS.forEach(col => {
            if (sheet.mapping_proposal[col.key]?.selected) {
                initialMap[col.key] = sheet.mapping_proposal[col.key].selected;
            } else {
                initialMap[col.key] = null;
            }
        });
        setMapping(initialMap);
        setStep(3);
    };

    // Helper to get unique values and colors for a selected header
    const getUniqueValues = (header: string) => {
        if (!selectedSheet) return [];
        const rows = sheetRows[selectedSheet.sheet_name] || [];
        const unique = new Set<string>();
        const values: { type: 'value' | 'color', val: string, count: number }[] = [];

        // Count frequencies
        const counts: Record<string, number> = {};

        rows.forEach(row => {
            const cell = row[header];
            if (!cell) return;

            // Value
            if (cell.v !== null && cell.v !== "") {
                const k = `value:${cell.v}`;
                counts[k] = (counts[k] || 0) + 1;
            }
            // Color
            if (cell.c !== null) {
                const k = `color:${cell.c}`;
                counts[k] = (counts[k] || 0) + 1;
            }
        });

        Object.keys(counts).forEach(k => {
            const [type, ...rest] = k.split(':');
            const val = rest.join(':');
            values.push({ type: type as 'value' | 'color', val, count: counts[k] });
        });

        // Sort by frequency
        return values.sort((a, b) => b.count - a.count);
    };

    const openValueMapping = (colKey: string) => {
        // Only if a header is selected for this column
        if (!mapping[colKey]) {
            Alert.alert("Referencia perdida", "Primero selecciona una columna del Excel.");
            return;
        }
        setActiveColKey(colKey);
        setMappingModalVisible(true);
    };

    const openHeaderSelection = (colKey: string) => {
        setActiveColKey(colKey);
        setHeaderModalVisible(true);
    };

    const updateValueMapping = (dbCol: string, rawKey: string, targetVal: string) => {
        setValueMapping(prev => ({
            ...prev,
            [dbCol]: {
                ...(prev[dbCol] || {}),
                [rawKey]: targetVal
            }
        }));
    };

    const executeImport = async () => {
        if (!selectedSheet) return;
        setLoading(true);
        try {
            const payload = {
                sheet_name: selectedSheet.sheet_name,
                column_mapping: mapping,
                value_mapping: valueMapping,
                constants: constants,
                merge_strategy: mergeStrategy,
                data: sheetRows[selectedSheet.sheet_name] || []
            };

            const res = await client.post('/import/execute', payload);
            Alert.alert("Éxito", `Creados: ${res.data.created}, Actualizados: ${res.data.updated}`);
            setStep(1);
            setMapping({});
            setValueMapping({});
            setConstants({});
            setAnalysis([]);
        } catch (e) {
            Alert.alert("Error", "Import failed");
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const renderHeaderModal = () => (
        <Portal>
            <Modal visible={headerModalVisible} onDismiss={() => setHeaderModalVisible(false)} contentContainerStyle={styles.modalContent}>
                <Text variant="titleMedium" style={{ marginBottom: 10 }}>Configurar Columna: {DB_COLUMNS.find(c => c.key === activeColKey)?.label}</Text>
                <ScrollView style={{ maxHeight: 400 }}>
                    <Text variant="titleSmall" style={{ marginTop: 10 }}>Asignar Columna Excel:</Text>
                    {selectedSheet?.headers.map(header => (
                        <Button
                            key={header}
                            mode={mapping[activeColKey!] === header ? "contained" : "outlined"}
                            onPress={() => {
                                setMapping({ ...mapping, [activeColKey!]: header });
                                // Clear constant if setting mapping
                                const newConst = { ...constants };
                                delete newConst[activeColKey!];
                                setConstants(newConst);
                                setHeaderModalVisible(false);
                            }}
                            style={{ marginBottom: 5, justifyContent: 'flex-start' }}
                        >
                            {header}
                        </Button>
                    ))}
                    <Button
                        mode="text" textColor="red"
                        onPress={() => {
                            setMapping({ ...mapping, [activeColKey!]: null });
                            setHeaderModalVisible(false);
                        }}
                    >
                        Desasignar (Limpiar)
                    </Button>

                    <Text variant="titleSmall" style={{ marginTop: 20 }}>O usar Valor Constante:</Text>
                    <Button
                        mode={constants[activeColKey!] !== undefined ? "contained" : "outlined"}
                        icon="form-textbox"
                        onPress={() => {
                            // Enable constant mode with empty/default value
                            setMapping({ ...mapping, [activeColKey!]: null }); // Clear mapping
                            setConstants({ ...constants, [activeColKey!]: constants[activeColKey!] || "" });
                            setHeaderModalVisible(false);
                        }}
                    >
                        Establecer Valor Fijo
                    </Button>

                </ScrollView>
            </Modal>
        </Portal>
    );

    const [constants, setConstants] = useState<Record<string, any>>({});
    const [config, setConfig] = useState<{
        valid_statuses: string[];
        valid_progress: string[];
        valid_platforms: string[];
    }>({ valid_statuses: [], valid_progress: [], valid_platforms: [] });

    // Years range (1980 - 2030)
    const YEARS = Array.from({ length: 51 }, (_, i) => String(2030 - i));

    useEffect(() => {
        // Fetch config
        client.get('/import/config').then(res => {
            setConfig(res.data);
        }).catch(err => console.error("Error fetching config", err));
    }, []);

    const renderValueMappingModal = () => {
        if (!activeColKey || !mapping[activeColKey]) return null;
        const header = mapping[activeColKey]!;
        const uniqueValues = getUniqueValues(header);
        const currentMap = valueMapping[activeColKey] || {};
        const isStatusColumn = activeColKey === "status";
        const isProgressColumn = activeColKey === "progress";

        return (
            <Portal>
                <Modal visible={mappingModalVisible} onDismiss={() => setMappingModalVisible(false)} contentContainerStyle={styles.modalContent}>
                    <Text variant="titleMedium">Mapeo de Valores: {DB_COLUMNS.find(c => c.key === activeColKey)?.label}</Text>
                    <Text variant="bodySmall">Excel: "{header}"</Text>
                    <ScrollView style={{ maxHeight: 400, marginTop: 10 }}>
                        {uniqueValues.map((item, idx) => {
                            const rawKey = item.val;
                            const mappedVal = currentMap[rawKey] || "";

                            return (
                                <View key={idx} style={styles.valueRow}>
                                    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                                        {item.type === 'color' ? (
                                            <View style={{ width: 20, height: 20, backgroundColor: `#${item.val}`, marginRight: 10, borderWidth: 1, borderColor: '#ccc' }} />
                                        ) : (
                                            <Text style={{ fontWeight: 'bold', marginRight: 5 }}>"{item.val}"</Text>
                                        )}
                                        <Text variant="bodySmall">({item.count})</Text>
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        {isStatusColumn ? (
                                            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                                                {config.valid_statuses.map(status => (
                                                    <Button
                                                        key={status}
                                                        mode={mappedVal === status ? "contained" : "outlined"}
                                                        compact
                                                        onPress={() => updateValueMapping(activeColKey, rawKey, status)}
                                                        style={{ marginRight: 5 }}
                                                        labelStyle={{ fontSize: 10 }}
                                                    >
                                                        {status}
                                                    </Button>
                                                ))}
                                                <IconButton icon="close" size={16} onPress={() => updateValueMapping(activeColKey, rawKey, "")} />
                                            </ScrollView>
                                        ) : isProgressColumn ? (
                                            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                                                {config.valid_progress.map(prog => (
                                                    <Button
                                                        key={prog}
                                                        mode={mappedVal === prog ? "contained" : "outlined"}
                                                        compact
                                                        onPress={() => updateValueMapping(activeColKey, rawKey, prog)}
                                                        style={{ marginRight: 5 }}
                                                        labelStyle={{ fontSize: 10 }}
                                                    >
                                                        {prog}
                                                    </Button>
                                                ))}
                                                <IconButton icon="close" size={16} onPress={() => updateValueMapping(activeColKey, rawKey, "")} />
                                            </ScrollView>
                                        ) : (
                                            <TextInput
                                                mode="outlined"
                                                dense
                                                placeholder="Valor DB..."
                                                value={mappedVal}
                                                onChangeText={(text) => updateValueMapping(activeColKey, rawKey, text)}
                                                style={{ fontSize: 12, height: 35 }}
                                            />
                                        )}
                                    </View>
                                </View>
                            )
                        })}
                    </ScrollView>
                    <Button onPress={() => setMappingModalVisible(false)} style={{ marginTop: 10 }}>Listo</Button>
                </Modal>
            </Portal>
        );
    };

    return (
        <ScrollView contentContainerStyle={styles.container}>
            {loading && <ActivityIndicator animating={true} style={styles.loader} />}

            {step === 1 && (
                <View>
                    <Button icon="file" mode="contained" onPress={pickFile}>
                        Seleccionar Excel
                    </Button>
                </View>
            )}

            {step === 2 && (
                <View>
                    <Text variant="titleMedium">Selecciona Hoja</Text>
                    {analysis.map(sheet => (
                        <Card key={sheet.sheet_name} style={styles.card} onPress={() => handleSheetSelect(sheet)}>
                            <Card.Title title={sheet.sheet_name} subtitle={`${sheet.row_count} filas`} />
                        </Card>
                    ))}
                </View>
            )}

            {step === 3 && selectedSheet && (
                <View>
                    <Text variant="headlineSmall">Mapeo de Columnas</Text>
                    <Text variant="bodySmall" style={{ marginBottom: 10 }}>Hoja: {selectedSheet.sheet_name}</Text>

                    {DB_COLUMNS.map(col => {
                        const currentVal = mapping[col.key];

                        return (
                            <View key={col.key} style={styles.mappingRow}>
                                <Text style={styles.colName}>{col.label}</Text>
                                <View style={styles.mappingControl}>
                                    <Button mode="outlined" onPress={() => openHeaderSelection(col.key)}>
                                        {currentVal || (constants[col.key] !== undefined ? "Valor Fijo" : "Seleccionar...")}
                                    </Button>

                                    {constants[col.key] !== undefined && (
                                        <TextInput
                                            mode="outlined"
                                            dense
                                            placeholder="Valor"
                                            value={constants[col.key]}
                                            onChangeText={(text) => setConstants({ ...constants, [col.key]: text })}
                                            style={{ minWidth: 100, fontSize: 13, height: 40 }}
                                        />
                                    )}

                                    {currentVal && (
                                        <Button compact mode="text" onPress={() => openValueMapping(col.key)}>
                                            Mapear Valores
                                        </Button>
                                    )}
                                </View>
                            </View>
                        );
                    })}

                    <View style={styles.actions}>
                        <Text>Estrategia de Fusión:</Text>
                        <RadioButton.Group onValueChange={setMergeStrategy} value={mergeStrategy}>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <RadioButton value="fill" /><Text>Rellenar vacíos</Text>
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <RadioButton value="overwrite" /><Text>Sobreescribir</Text>
                            </View>
                        </RadioButton.Group>

                        <Button mode="contained" onPress={executeImport} style={{ marginTop: 20 }}>
                            Importar Datos
                        </Button>
                    </View>
                </View>
            )}

            {renderHeaderModal()}
            {renderValueMappingModal()}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { padding: 20, paddingBottom: 50 },
    loader: { marginBottom: 20 },
    card: { marginBottom: 10 },
    mappingRow: { marginBottom: 15, borderBottomWidth: 1, borderColor: '#eee', paddingBottom: 5 },
    colName: { fontWeight: 'bold', marginBottom: 5 },
    mappingControl: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
    actions: { marginTop: 30 },
    modalContent: { backgroundColor: 'white', padding: 20, margin: 20, borderRadius: 8, maxHeight: '80%' },
    valueRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, borderBottomWidth: 0.5, borderColor: '#eee', paddingBottom: 5 }
});
