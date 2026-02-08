import React, { useState } from 'react';
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
    const [mergeStrategy, setMergeStrategy] = useState('fill'); // 'fill' or 'overwrite'
    const [sheetData, setSheetData] = useState<any[]>([]); // Need to store file content potentially or re-upload? 
    // Re-uploading is inefficient. Ideally backend keeps state or we send file every time.
    // Better: We send file once, backend returns analysis AND ID to cache it? 
    // Or we just send file content again. For mobile, holding big file in memory is bad.
    // For now, I will implement re-upload logic or assume small files.
    // WAIT, `analyze_file` returned headers but not data content reference.
    // I need to send the DATA to `execute`.
    // The previous implementation of `analyze` logic parsed data but didn't return it full to frontend (good).
    // The `execute` endpoint expects `data: List[Dict]`.
    // This means frontend MUST parse the excel file? Or backend should return the data content?
    // If backend returns data content, it's heavy JSON.
    // Best approach for valid JSON API: Backend returns a temporary ID or frontend sends file twice.
    // Frontend sending file twice is safer for stateless backend.

    // BUT, `react-native` `DocumentPicker` gives a URI.
    // We can't easily "Read" the file in JS without extra native modules (expo-file-system).
    // `expo-document-picker` result has `file` object on web, implies `uri` on native.
    // To send file content to backend, we used `FormData`.
    // To send `data` list to `execute` endpoint, frontend needs to READ valid rows.
    // This is tricky: Frontend has no excel parser installed.
    // SOLUTION: Backend `analyze` endpoint should probably return the `data` (rows) too, 
    // or store it temporarily. Storing is complex (need redis/db).
    // Returning it: If file is < 5MB, returning JSON array of rows is fine.
    // Let's modify Backend `analyze` to return `data` rows so frontend can pass them back to `execute`.

    const [fileUri, setFileUri] = useState<any>(null);

    // We store the data returned by analyze to pass it back
    const [sheetRows, setSheetRows] = useState<Record<string, any[]>>({});

    const pickFile = async () => {
        try {
            const res = await DocumentPicker.getDocumentAsync({
                type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv'],
                copyToCacheDirectory: true
            });

            if (!res.canceled) {
                setFileUri(res.assets[0]);
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
            // Ops, I need to update backend to return data.
            // Assuming backend response structure matches SheetAnalysis[] but I need to add `rows` to it.
            // I will update backend model first.
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

    const executeImport = async () => {
        if (!selectedSheet) return;
        setLoading(true);
        try {
            const payload = {
                sheet_name: selectedSheet.sheet_name,
                column_mapping: mapping,
                merge_strategy: mergeStrategy,
                data: sheetRows[selectedSheet.sheet_name] || []
            };

            const res = await client.post('/import/execute', payload);
            Alert.alert("Success", `Created: ${res.data.created}, Updated: ${res.data.updated}`);
            setStep(1);
        } catch (e) {
            Alert.alert("Error", "Import failed");
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    // Render Steps
    // ... Simplified render logic for brevity

    return (
        <ScrollView contentContainerStyle={styles.container}>
            {loading && <ActivityIndicator animating={true} style={styles.loader} />}

            {step === 1 && (
                <View>
                    <Button icon="file" mode="contained" onPress={pickFile}>
                        Select Excel File
                    </Button>
                    {/* Add URL input later */}
                </View>
            )}

            {step === 2 && (
                <View>
                    <Text variant="titleMedium">Select Sheet</Text>
                    {analysis.map(sheet => (
                        <Card key={sheet.sheet_name} style={styles.card} onPress={() => handleSheetSelect(sheet)}>
                            <Card.Title title={sheet.sheet_name} subtitle={`${sheet.row_count} rows`} />
                        </Card>
                    ))}
                </View>
            )}

            {step === 3 && selectedSheet && (
                <View>
                    <Text variant="headlineSmall">Map Columns</Text>
                    <Text variant="bodySmall" style={{ marginBottom: 10 }}>Sheet: {selectedSheet.sheet_name}</Text>

                    {DB_COLUMNS.map(col => {
                        const proposal = selectedSheet.mapping_proposal[col.key];
                        const currentVal = mapping[col.key];

                        return (
                            <View key={col.key} style={styles.mappingRow}>
                                <Text style={styles.colName}>{col.label}</Text>
                                <View style={styles.mappingControl}>
                                    <Text>{currentVal || "Skip"}</Text>
                                    {/* Simple implementation: Cycle through alternatives or clear */}
                                    {/* For full implementation, need a Picker/Dropdown */}
                                    <View style={{ flexDirection: 'row' }}>
                                        {proposal?.alternatives?.map(alt => (
                                            <Button key={alt} compact onPress={() => setMapping({ ...mapping, [col.key]: alt })}>
                                                {alt}
                                            </Button>
                                        ))}
                                        <Button compact textColor="red" onPress={() => setMapping({ ...mapping, [col.key]: null })}>Clear</Button>
                                    </View>
                                </View>
                            </View>
                        );
                    })}

                    <View style={styles.actions}>
                        <Text>Merge Strategy:</Text>
                        <RadioButton.Group onValueChange={setMergeStrategy} value={mergeStrategy}>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <RadioButton value="fill" /><Text>Fill Empty</Text>
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <RadioButton value="overwrite" /><Text>Overwrite</Text>
                            </View>
                        </RadioButton.Group>

                        <Button mode="contained" onPress={executeImport} style={{ marginTop: 20 }}>
                            Import Data
                        </Button>
                    </View>
                </View>
            )}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { padding: 20 },
    loader: { marginBottom: 20 },
    card: { marginBottom: 10 },
    mappingRow: { marginBottom: 15, borderBottomWidth: 1, borderColor: '#eee', paddingBottom: 5 },
    colName: { fontWeight: 'bold' },
    mappingControl: { marginTop: 5 },
    actions: { marginTop: 30 }
});
