import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, StyleSheet } from 'react-native';
import { Text, Card, FAB, ActivityIndicator } from 'react-native-paper';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import client from '../api/client';
import i18n from '../i18n';
import { useAuthStore } from '../store/useAuthStore';

type Game = {
    id: number;
    title: string;
    status: string;
    hype_score?: number;
    rating?: number;
};

export default function GamesListScreen() {
    const route = useRoute<any>();
    const navigation = useNavigation<any>();
    const mode = route.params?.mode || 'backlog'; // 'backlog' or 'finished'
    const [games, setGames] = useState<Game[]>([]);
    const [loading, setLoading] = useState(true);
    const { user } = useAuthStore();

    const fetchGames = async () => {
        if (!user) return;
        setLoading(true);
        try {
            const statusParam = mode === 'backlog' ? 'backlog' : 'finished';
            const res = await client.get(`/games/?status=${statusParam}`);
            setGames(res.data);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    useFocusEffect(
        useCallback(() => {
            fetchGames();
        }, [mode, user])
    );

    const renderItem = ({ item }: { item: Game }) => (
        <Card style={styles.card} onPress={() => navigation.navigate('GameDetail', { gameId: item.id })}>
            <Card.Title
                title={item.title}
                right={(props) => (
                    <View {...props} style={styles.scoreContainer}>
                        <Text variant="titleMedium">
                            {mode === 'backlog'
                                ? `${i18n.t('ganas')}: ${item.hype_score ?? '-'}`
                                : `${i18n.t('nota')}: ${item.rating ?? '-'}`}
                        </Text>
                    </View>
                )}
            />
        </Card>
    );

    return (
        <View style={styles.container}>
            {loading ? (
                <ActivityIndicator animating={true} style={styles.loading} />
            ) : (
                <FlatList
                    data={games}
                    keyExtractor={(item) => item.id.toString()}
                    renderItem={renderItem}
                    ListEmptyComponent={<Text style={styles.empty}>{i18n.t('noGames')}</Text>}
                />
            )}
            <FAB
                icon="plus"
                style={styles.fab}
                onPress={() => navigation.navigate('GameDetail', { mode })}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 10,
    },
    loading: {
        marginTop: 20,
    },
    empty: {
        textAlign: 'center',
        marginTop: 20,
        opacity: 0.6,
    },
    card: {
        marginBottom: 10,
    },
    scoreContainer: {
        marginRight: 16,
        justifyContent: 'center',
    },
    fab: {
        position: 'absolute',
        margin: 16,
        right: 0,
        bottom: 0,
    },
});
