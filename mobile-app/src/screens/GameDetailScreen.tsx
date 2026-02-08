import React, { useEffect, useState } from 'react';
import { View, ScrollView, StyleSheet, Alert } from 'react-native';
import { TextInput, Button, HelperText, SegmentedButtons, Switch, Text } from 'react-native-paper';
import { useNavigation, useRoute } from '@react-navigation/native';
import client from '../api/client';
import i18n from '../i18n';
// Remove dropdown import if not installed, or use native picker or menu.
// For simplicity using TextInput for numeric fields and Segment Buttons for progress.

export default function GameDetailScreen() {
    const route = useRoute<any>();
    const navigation = useNavigation<any>();
    const gameId = route.params?.gameId;
    const initialMode = route.params?.mode || 'backlog';

    const [loading, setLoading] = useState(false);
    const [data, setData] = useState({
        title: '',
        status: initialMode,
        hype_score: '',
        rating: '',
        progress: 'Empezado',
        playtime_hours: '',
        finish_year: '',
        release_year: '',
        price: '',
        platform: '',
        steam_deck: false,
        notes: '',
    });

    const isBacklog = data.status === 'backlog';

    useEffect(() => {
        if (gameId) {
            fetchGame();
        }
    }, [gameId]);

    const fetchGame = async () => {
        try {
            setLoading(true);
            const detailRes = await client.get(`/games/${gameId}`);
            const game = detailRes.data;
            if (game) {
                setData({
                    ...game,
                    hype_score: game.hype_score?.toString() || '',
                    rating: game.rating?.toString() || '',
                    playtime_hours: game.playtime_hours?.toString() || '',
                    finish_year: game.finish_year?.toString() || '',
                    release_year: game.release_year?.toString() || '',
                    price: game.price?.toString() || '',
                });
            }
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        setLoading(true);
        try {
            const payload = {
                ...data,
                hype_score: data.hype_score ? parseInt(data.hype_score) : null,
                rating: data.rating ? parseFloat(data.rating) : null,
                playtime_hours: data.playtime_hours ? parseFloat(data.playtime_hours) : null,
                finish_year: data.finish_year ? parseInt(data.finish_year) : null,
                release_year: data.release_year ? parseInt(data.release_year) : null,
                price: data.price ? parseFloat(data.price) : null,
            };

            if (gameId) {
                await client.put(`/games/${gameId}`, payload);
            } else {
                await client.post('/games/', payload);
            }
            navigation.goBack();
        } catch (error) {
            console.error(error)
            Alert.alert('Error', 'Could not save game');
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async () => {
        if (!gameId) return;
        try {
            await client.delete(`/games/${gameId}`);
            navigation.goBack();
        } catch (e) {
            Alert.alert('Error', 'Could not delete');
        }
    };

    return (
        <ScrollView contentContainerStyle={styles.container}>
            <TextInput
                label="Title"
                value={data.title}
                onChangeText={(t) => setData({ ...data, title: t })}
                style={styles.input}
            />

            <View style={styles.row}>
                <Text>Status</Text>
                <SegmentedButtons
                    value={data.status}
                    onValueChange={val => setData({ ...data, status: val })}
                    buttons={[
                        { value: 'backlog', label: 'Backlog' },
                        { value: 'finished', label: 'Finished' },
                    ]}
                    style={styles.segment}
                />
            </View>

            {isBacklog ? (
                <TextInput
                    label="Ganas (Hype 0-10)"
                    value={data.hype_score}
                    onChangeText={(t) => setData({ ...data, hype_score: t })}
                    keyboardType="numeric"
                    style={styles.input}
                />
            ) : (
                <>
                    <TextInput
                        label="Nota (Rating 0-10)"
                        value={data.rating}
                        onChangeText={(t) => setData({ ...data, rating: t })}
                        keyboardType="numeric"
                        style={styles.input}
                    />
                    <View style={styles.row}>
                        <Text>Progreso</Text>
                        {/* Simple selection for progress */}
                        {/* If too many options, use menu, for now simplified */}
                    </View>
                    <SegmentedButtons
                        value={data.progress}
                        onValueChange={val => setData({ ...data, progress: val })}
                        buttons={[
                            { value: 'Empezado', label: 'Start' },
                            { value: 'Terminado', label: 'End' }
                        ]}
                        style={styles.segment}
                    />

                    <TextInput
                        label="Playtime (Hours)"
                        value={data.playtime_hours}
                        onChangeText={(t) => setData({ ...data, playtime_hours: t })}
                        keyboardType="numeric"
                        style={styles.input}
                    />
                    <TextInput
                        label="Finish Year"
                        value={data.finish_year}
                        onChangeText={(t) => setData({ ...data, finish_year: t })}
                        keyboardType="numeric"
                        style={styles.input}
                    />
                </>
            )}

            <TextInput
                label="Release Year"
                value={data.release_year}
                onChangeText={(t) => setData({ ...data, release_year: t })}
                keyboardType="numeric"
                style={styles.input}
            />
            <TextInput
                label="Price"
                value={data.price}
                onChangeText={(t) => setData({ ...data, price: t })}
                keyboardType="numeric"
                style={styles.input}
            />
            <TextInput
                label="Platform"
                value={data.platform}
                onChangeText={(t) => setData({ ...data, platform: t })}
                style={styles.input}
            />

            <View style={styles.row}>
                <Text>Steam Deck Compatible</Text>
                <Switch value={data.steam_deck} onValueChange={val => setData({ ...data, steam_deck: val })} />
            </View>

            <TextInput
                label="Notes"
                value={data.notes}
                onChangeText={(t) => setData({ ...data, notes: t })}
                multiline
                numberOfLines={3}
                style={styles.input}
            />

            <Button mode="contained" onPress={handleSave} style={styles.button} loading={loading}>
                {i18n.t('save')}
            </Button>

            {gameId && (
                <Button mode="outlined" onPress={handleDelete} style={styles.button} textColor="red">
                    Delete
                </Button>
            )}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        padding: 20,
        paddingBottom: 50,
    },
    input: {
        marginBottom: 15,
    },
    row: {
        marginBottom: 15,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between'
    },
    segment: {
        marginBottom: 15,
    },
    button: {
        marginTop: 10,
        marginBottom: 10,
    },
});
