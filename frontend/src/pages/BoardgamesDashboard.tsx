import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Archive, ArrowLeft, BarChart3, CalendarDays, Check, ChevronDown, ChevronRight, CircleDollarSign,
  Crown, Dices, Edit2, ExternalLink, Filter, Gamepad2, Grid2X2, Heart, History,
  LayoutList, Loader2, Medal, PackageCheck, Plus, RefreshCw, Search, Shield,
  ShoppingBag, Sparkles, Swords, Tag as TagIcon, Trash2, Trophy, Upload, UserRound,
  UsersRound, X
} from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { TagMultiSelect } from '../components/TagMultiSelect';
import { BoardgameExcelImportModal } from '../components/BoardgameExcelImportModal';
import { PaginationControls } from '../components/PaginationControls';
import { parseStoredPageSize, type PageSize } from '../lib/pagination';
import { useAuth } from '../context/AuthContext';
import './BoardgamesDashboard.css';

type BoardgameTab = 'wishlist' | 'owned' | 'matches';
type LibrarySection = 'wishlist' | 'owned' | 'external';
type LibraryView = 'grid' | 'list';
type MatchView = 'list' | 'games';
type MatchMode = 'cooperative' | 'competitive' | 'solo';

interface Tag { id: number; name: string; }
interface BoardgamePlayer { id: number; name: string; normalized_name: string; }

interface Boardgame {
  id: number;
  name: string;
  description: string | null;
  comments: string | null;
  image_url: string | null;
  status: string;
  mark: number | null;
  hype: number | null;
  publication_year: number | null;
  tags: string | null;
  game_type: string | null;
  bgg_link: string | null;
  library_section: LibrarySection;
  bgg_id: number | null;
  bgg_rank: number | null;
  price: number | null;
  expansions: string | null;
  is_expansion: boolean;
  parent_game_name: string | null;
}

interface BoardgameMatch {
  id: number;
  boardgame_id: number;
  game_name: string;
  game_image_url: string | null;
  game_tags: string | null;
  played_with: string | null;
  player_ids: number[];
  players: BoardgamePlayer[];
  mode: MatchMode;
  result: 'victory' | 'defeat' | 'winner' | 'incomplete' | null;
  winner_name: string | null;
  comments: string | null;
  played_date: string | null;
}

interface BggSearchResult { id: number; name: string; year_published: number | null; item_type: string | null; }
interface BggMetadata { id: number; name: string; description: string | null; image_url: string | null; year_published: number | null; rank: number | null; bgg_link: string; is_expansion: boolean; }
type GameDraft = Omit<Boardgame, 'id'>;

interface MatchDraft {
  boardgame_id: number | null;
  player_ids: number[];
  mode: MatchMode;
  result: 'victory' | 'defeat';
  winner_name: string;
  comments: string;
  played_date: string;
}

interface CollectionLinkPrompt {
  action: 'create' | 'move';
  draft: GameDraft;
  targetGameId: number | null;
  sources: Boardgame[];
}

const today = () => new Date().toISOString().slice(0, 10);
const newGameDraft = (section: LibrarySection): GameDraft => ({
  name: '', description: null, comments: null, image_url: null, status: 'Not Started', mark: null,
  hype: null, publication_year: null, tags: null, game_type: null, bgg_link: null,
  library_section: section, bgg_id: null, bgg_rank: null, price: null, expansions: null,
  is_expansion: false, parent_game_name: null,
});
const newMatchDraft = (gameId?: number): MatchDraft => ({
  boardgame_id: gameId || null, player_ids: [], mode: 'competitive', result: 'victory',
  winner_name: '', comments: '', played_date: today(),
});

function parseStringList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean);
  } catch { /* Legacy values use comma-separated text. */ }
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function formatPrice(value: number | null): string {
  return value === null || value === undefined ? 'No price' : new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' }).format(value);
}
function normalizedGameName(value: string | null | undefined): string {
  return (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}
function fuzzyNameScore(value: string, rawQuery: string): number | null {
  const candidate = normalizedGameName(value);
  const query = normalizedGameName(rawQuery);
  if (!query) return 0;
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 1;
  if (candidate.includes(query)) return 2;
  if (query.includes(candidate)) return 3;
  if (query.split(' ').every(word => candidate.includes(word))) return 4;
  const distance = editDistance(candidate, query);
  return distance <= Math.max(1, Math.floor(query.length * .25)) ? 5 + distance : null;
}
function matchPlayerNames(match: BoardgameMatch): string[] {
  return match.players?.length ? match.players.map(player => player.name) : parseStringList(match.played_with);
}
function modeLabel(mode: MatchMode): string { return mode === 'cooperative' ? 'Co-op' : mode.charAt(0).toUpperCase() + mode.slice(1); }
function resultLabel(match: BoardgameMatch): string {
  if (match.result === 'incomplete') return 'Not finished';
  if (match.mode === 'competitive') return match.winner_name ? `${match.winner_name} won` : 'Winner not set';
  return match.result === 'victory' ? 'Victory' : 'Defeat';
}
function matchDateLabel(value: string | null): string { return value || 'Date unknown'; }
function gameTitleClass(name: string): string {
  if (name.length >= 42) return 'very-long';
  if (name.length >= 29) return 'long';
  return '';
}
function GameArtwork({ game, compact = false }: { game: Pick<Boardgame, 'name' | 'image_url'>; compact?: boolean }) {
  return game.image_url ? <img className={compact ? 'bg-artwork compact' : 'bg-artwork'} src={game.image_url} alt={`${game.name} cover`} /> : <div className={compact ? 'bg-artwork-placeholder compact' : 'bg-artwork-placeholder'}><Dices size={compact ? 22 : 36} /></div>;
}

export function BoardgamesDashboard() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<BoardgameTab>(() => (sessionStorage.getItem('bg_active_tab') as BoardgameTab) || 'owned');
  const [games, setGames] = useState<Boardgame[]>([]);
  const [matches, setMatches] = useState<BoardgameMatch[]>([]);
  const [players, setPlayers] = useState<BoardgamePlayer[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [libraryView, setLibraryView] = useState<LibraryView>('grid');
  const [pageSizeOptions, setPageSizeOptions] = useState([5, 10, 20, 50]);
  const [pageSize, setPageSize] = useState<PageSize>(() => parseStoredPageSize(sessionStorage.getItem('bg_page_size')));
  const [currentPage, setCurrentPage] = useState(1);
  const [matchView, setMatchView] = useState<MatchView>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [maxRank, setMaxRank] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minHype, setMinHype] = useState('');
  const [minRating, setMinRating] = useState('');
  const [expansionFilter, setExpansionFilter] = useState<'all' | 'with' | 'without'>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [matchSearch, setMatchSearch] = useState('');
  const [matchFriendFilter, setMatchFriendFilter] = useState('');
  const [isFriendMenuOpen, setIsFriendMenuOpen] = useState(false);
  const [matchModeFilter, setMatchModeFilter] = useState('');
  const [matchResultFilter, setMatchResultFilter] = useState('');
  const [matchTagFilter, setMatchTagFilter] = useState('');
  const [matchDateFrom, setMatchDateFrom] = useState('');
  const [matchDateTo, setMatchDateTo] = useState('');
  const [selectedMatchGameId, setSelectedMatchGameId] = useState<number | null>(null);
  const [gameDraft, setGameDraft] = useState<GameDraft | null>(null);
  const [editingGameId, setEditingGameId] = useState<number | null>(null);
  const [isSavingGame, setIsSavingGame] = useState(false);
  const [collectionLinkPrompt, setCollectionLinkPrompt] = useState<CollectionLinkPrompt | null>(null);
  const [selectedMatchSourceIds, setSelectedMatchSourceIds] = useState<number[]>([]);
  const [isLinkingCollection, setIsLinkingCollection] = useState(false);
  const [expansionName, setExpansionName] = useState('');
  const [bggQuery, setBggQuery] = useState('');
  const [bggResults, setBggResults] = useState<BggSearchResult[]>([]);
  const [isSearchingBgg, setIsSearchingBgg] = useState(false);
  const [isSyncingBgg, setIsSyncingBgg] = useState(false);
  const [matchDraft, setMatchDraft] = useState<MatchDraft | null>(null);
  const [editingMatchId, setEditingMatchId] = useState<number | null>(null);
  const [isSavingMatch, setIsSavingMatch] = useState(false);
  const [matchGameQuery, setMatchGameQuery] = useState('');
  const [showGameSuggestions, setShowGameSuggestions] = useState(false);
  const [playerQuery, setPlayerQuery] = useState('');
  const [showPlayerSuggestions, setShowPlayerSuggestions] = useState(false);
  const [isCreatingPlayer, setIsCreatingPlayer] = useState(false);
  const [showExcelImport, setShowExcelImport] = useState(false);
  const [movingExpansion, setMovingExpansion] = useState<Boardgame | null>(null);
  const [selectedParentGameId, setSelectedParentGameId] = useState<number | null>(null);
  const [parentGameSearch, setParentGameSearch] = useState('');
  const [isAttachingExpansion, setIsAttachingExpansion] = useState(false);

  useEffect(() => {
    sessionStorage.setItem('bg_active_tab', activeTab);
  }, [activeTab]);
  useEffect(() => {
    sessionStorage.setItem('bg_page_size', String(pageSize));
  }, [pageSize]);

  function changeTab(tab: BoardgameTab) {
    setActiveTab(tab);
    setSearchQuery(''); setSelectedTag(''); setShowFilters(false); setSelectedMatchGameId(null); setCurrentPage(1);
  }

  async function loadDashboard(showLoader = true) {
    if (showLoader) setIsLoading(true); setLoadError('');
    try {
      const [gamesResponse, matchesResponse, tagsResponse, playersResponse, paginationResponse] = await Promise.all([
        fetchWithAuth('/boardgames/'), fetchWithAuth('/boardgames/matches'), fetchWithAuth('/boardgames/tags'), fetchWithAuth('/boardgames/players'), fetchWithAuth('/settings/pagination')
      ]);
      if (!gamesResponse.ok || !matchesResponse.ok || !tagsResponse.ok || !playersResponse.ok) throw new Error('The board-game data could not be loaded.');
      setGames(await gamesResponse.json()); setMatches(await matchesResponse.json()); setAvailableTags(await tagsResponse.json()); setPlayers(await playersResponse.json());
      if (paginationResponse.ok) {
        const settings: { page_sizes: number[] } = await paginationResponse.json();
        setPageSizeOptions(settings.page_sizes);
        setPageSize(current => current === 'infinite' || settings.page_sizes.includes(current) ? current : settings.page_sizes[0]);
      }
    } catch (error) {
      console.error(error); setLoadError('Could not load the board-game vault. Please try again.');
    } finally { if (showLoader) setIsLoading(false); }
  }
  useEffect(() => {
    const loadTimer = window.setTimeout(() => { void loadDashboard(); }, 0);
    return () => window.clearTimeout(loadTimer);
  }, []);

  const wishlistGames = useMemo(() => games.filter(game => game.library_section === 'wishlist'), [games]);
  const ownedGames = useMemo(() => games.filter(game => game.library_section === 'owned'), [games]);
  const externalGames = useMemo(() => games.filter(game => game.library_section === 'external'), [games]);
  const matchGameSuggestions = useMemo(() => {
    if (!normalizedGameName(matchGameQuery)) return [];
    return ownedGames
      .filter(game => fuzzyNameScore(game.name, matchGameQuery) !== null)
      .sort((a, b) => (fuzzyNameScore(a.name, matchGameQuery) ?? 99) - (fuzzyNameScore(b.name, matchGameQuery) ?? 99) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [matchGameQuery, ownedGames]);
  const playerSuggestions = useMemo(() => {
    return players
      .filter(player => !matchDraft?.player_ids.includes(player.id) && fuzzyNameScore(player.name, playerQuery) !== null)
      .sort((a, b) => (fuzzyNameScore(a.name, playerQuery) ?? 99) - (fuzzyNameScore(b.name, playerQuery) ?? 99) || a.name.localeCompare(b.name));
  }, [matchDraft?.player_ids, playerQuery, players]);
  const selectedMatchGame = matchDraft ? games.find(game => game.id === matchDraft.boardgame_id) : undefined;
  const exactPlayerSuggestion = players.find(player => normalizedGameName(player.name) === normalizedGameName(playerQuery));
  const expansionParentGames = useMemo(() => {
    const query = normalizedGameName(parentGameSearch);
    return ownedGames
      .filter(game => !game.is_expansion && (!query || normalizedGameName(game.name).includes(query)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [ownedGames, parentGameSearch]);
  const visibleGames = useMemo(() => {
    const source = activeTab === 'wishlist' ? wishlistGames : ownedGames;
    const query = searchQuery.trim().toLocaleLowerCase();
    const filtered = source.filter(game => {
      const tags = parseStringList(game.tags), expansions = parseStringList(game.expansions);
      if (query && ![game.name, game.description, game.parent_game_name, ...tags, ...expansions].some(value => value?.toLocaleLowerCase().includes(query))) return false;
      if (selectedTag && !tags.includes(selectedTag)) return false;
      if (activeTab === 'wishlist') {
        if (maxRank && (!game.bgg_rank || game.bgg_rank > Number(maxRank))) return false;
        if (maxPrice && (game.price === null || game.price > Number(maxPrice))) return false;
        if (minHype && (game.hype === null || game.hype < Number(minHype))) return false;
      } else {
        if (minRating && (game.mark === null || game.mark < Number(minRating))) return false;
        if (expansionFilter === 'with' && expansions.length === 0) return false;
        if (expansionFilter === 'without' && expansions.length > 0) return false;
      }
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (sortBy === 'rank') return (a.bgg_rank ?? Number.MAX_SAFE_INTEGER) - (b.bgg_rank ?? Number.MAX_SAFE_INTEGER);
      if (sortBy === 'price-low') return (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER);
      if (sortBy === 'price-high') return (b.price ?? -1) - (a.price ?? -1);
      if (sortBy === 'hype') return (b.hype ?? -1) - (a.hype ?? -1);
      if (sortBy === 'rating') return (b.mark ?? -1) - (a.mark ?? -1);
      return a.name.localeCompare(b.name);
    });
  }, [activeTab, expansionFilter, maxPrice, maxRank, minHype, minRating, ownedGames, searchQuery, selectedTag, sortBy, wishlistGames]);
  const totalLibraryPages = pageSize === 'infinite' ? 1 : Math.max(1, Math.ceil(visibleGames.length / pageSize));
  const visibleLibraryPage = Math.min(currentPage, totalLibraryPages);
  const pagedVisibleGames = pageSize === 'infinite'
    ? visibleGames
    : visibleGames.slice((visibleLibraryPage - 1) * pageSize, visibleLibraryPage * pageSize);

  const friendOptions = useMemo(() => {
    const friends = new Map<string, { name: string; plays: number }>();
    matches.forEach(match => matchPlayerNames(match).forEach(friend => {
      const key = normalizedGameName(friend);
      const entry = friends.get(key) || { name: friend, plays: 0 };
      entry.plays += 1;
      friends.set(key, entry);
    }));
    return [...friends.values()].sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
  }, [matches]);

  const filteredMatches = useMemo(() => {
    const query = matchSearch.trim().toLocaleLowerCase();
    return matches.filter(match => {
      const players = matchPlayerNames(match), tags = parseStringList(match.game_tags);
      if (query && ![match.game_name, match.comments, match.winner_name, ...players].some(value => value?.toLocaleLowerCase().includes(query))) return false;
      if (matchFriendFilter && !players.some(player => normalizedGameName(player) === matchFriendFilter)) return false;
      if (matchModeFilter && match.mode !== matchModeFilter) return false;
      if (matchResultFilter === 'victory' && match.result !== 'victory') return false;
      if (matchResultFilter === 'defeat' && match.result !== 'defeat') return false;
      if (matchResultFilter === 'incomplete' && match.result !== 'incomplete') return false;
      if (matchResultFilter === 'competitive' && match.mode !== 'competitive') return false;
      if (matchTagFilter && !tags.includes(matchTagFilter)) return false;
      if (matchDateFrom && (!match.played_date || match.played_date < matchDateFrom)) return false;
      if (matchDateTo && (!match.played_date || match.played_date > matchDateTo)) return false;
      if (selectedMatchGameId && match.boardgame_id !== selectedMatchGameId) return false;
      return true;
    }).sort((a, b) => (b.played_date || '').localeCompare(a.played_date || ''));
  }, [matchDateFrom, matchDateTo, matchFriendFilter, matchModeFilter, matchResultFilter, matchSearch, matchTagFilter, matches, selectedMatchGameId]);

  const selectedFriend = friendOptions.find(option => normalizedGameName(option.name) === matchFriendFilter);
  const selectedFriendStats = useMemo(() => {
    if (!matchFriendFilter) return null;
    const gameCounts = new Map<string, number>();
    filteredMatches.forEach(match => gameCounts.set(match.game_name, (gameCounts.get(match.game_name) || 0) + 1));
    const favoriteGame = [...gameCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return {
      name: selectedFriend?.name || matchFriendFilter,
      plays: filteredMatches.length,
      games: new Set(filteredMatches.map(match => match.boardgame_id)).size,
      favoriteGame: favoriteGame?.[0] || '—',
      cooperativeWins: filteredMatches.filter(match => match.mode === 'cooperative' && match.result === 'victory').length,
    };
  }, [filteredMatches, matchFriendFilter, selectedFriend?.name]);

  const matchGameGroups = useMemo(() => {
    const groups = new Map<number, { game: Boardgame | undefined; matches: BoardgameMatch[] }>();
    filteredMatches.forEach(match => {
      const group = groups.get(match.boardgame_id) || { game: games.find(game => game.id === match.boardgame_id), matches: [] };
      group.matches.push(match); groups.set(match.boardgame_id, group);
    });
    return [...groups.entries()].map(([gameId, group]) => ({ gameId, ...group })).sort((a, b) => b.matches.length - a.matches.length);
  }, [filteredMatches, games]);

  const openNewGame = (section: LibrarySection) => { setEditingGameId(null); setGameDraft(newGameDraft(section)); setExpansionName(''); setBggQuery(''); setBggResults([]); };
  const openEditGame = (game: Boardgame) => { setEditingGameId(game.id); setGameDraft({ ...game }); setExpansionName(''); setBggQuery(game.name); setBggResults([]); };
  const externalMatchCandidates = (name: string, excludeGameId?: number) => externalGames
    .filter(game => game.id !== excludeGameId && matches.some(match => match.boardgame_id === game.id) && fuzzyNameScore(game.name, name) !== null)
    .sort((a, b) => (fuzzyNameScore(a.name, name) ?? 99) - (fuzzyNameScore(b.name, name) ?? 99) || a.name.localeCompare(b.name));
  const openCollectionLinkPrompt = (action: CollectionLinkPrompt['action'], draft: GameDraft, targetGameId: number | null, sources: Boardgame[]) => {
    setSelectedMatchSourceIds(sources.filter(source => normalizedGameName(source.name) === normalizedGameName(draft.name)).map(source => source.id));
    setCollectionLinkPrompt({ action, draft: { ...draft }, targetGameId, sources });
  };
  const persistGame = async (draft: GameDraft, targetId: number | null, sourceGameIds: number[] = []) => {
    if (!draft.name.trim()) return;
    setIsSavingGame(true);
    try {
      const cleanedDraft = { ...draft, name: draft.name.trim() };
      const useLinkedCreate = !targetId && cleanedDraft.library_section === 'owned' && sourceGameIds.length > 0;
      const response = await fetchWithAuth(useLinkedCreate ? '/boardgames/collection' : targetId ? `/boardgames/${targetId}` : '/boardgames/', {
        method: targetId ? 'PUT' : 'POST',
        body: JSON.stringify(useLinkedCreate ? { game: cleanedDraft, source_game_ids: sourceGameIds } : cleanedDraft),
      });
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.detail || 'Could not save this game.'); }
      await loadDashboard(false);
      setGameDraft(null); setCollectionLinkPrompt(null); setSelectedMatchSourceIds([]);
    } catch (error) { alert(error instanceof Error ? error.message : 'Could not save this game.'); } finally { setIsSavingGame(false); }
  };
  const saveGame = () => {
    if (!gameDraft?.name.trim()) return;
    if (!editingGameId && gameDraft.library_section === 'owned') {
      const sources = externalMatchCandidates(gameDraft.name);
      if (sources.length) { openCollectionLinkPrompt('create', gameDraft, null, sources); return; }
    }
    void persistGame(gameDraft, editingGameId);
  };
  const deleteGame = async (game: Boardgame) => {
    const matchCount = matches.filter(match => match.boardgame_id === game.id).length;
    const confirmation = matchCount
      ? `Remove “${game.name}” from ${game.library_section === 'owned' ? 'your collection' : 'your wishlist'}? Its ${matchCount} ${matchCount === 1 ? 'match' : 'matches'} will stay in your history and the game will be marked Not in collection.`
      : `Delete “${game.name}”?`;
    if (!window.confirm(confirmation)) return;
    const response = await fetchWithAuth(`/boardgames/${game.id}`, { method: 'DELETE' });
    if (!response.ok) { const data = await response.json().catch(() => null); alert(data?.detail || 'Could not remove this game.'); return; }
    const result: { status: string; game?: Boardgame } = await response.json();
    if (result.status === 'converted_to_external' && result.game) setGames(current => current.map(item => item.id === game.id ? result.game! : item));
    else setGames(current => current.filter(item => item.id !== game.id));
  };
  const moveGameToCollection = async (game: Boardgame, sourceGameIds: number[] = []) => {
    setIsLinkingCollection(true);
    try {
      const response = await fetchWithAuth(sourceGameIds.length ? `/boardgames/${game.id}/move-to-collection` : `/boardgames/${game.id}`, {
        method: sourceGameIds.length ? 'POST' : 'PUT',
        body: JSON.stringify(sourceGameIds.length ? { game: { ...game, library_section: 'owned' }, source_game_ids: sourceGameIds } : { ...game, library_section: 'owned' }),
      });
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.detail || 'Could not move this game to your collection.'); }
      await loadDashboard(false);
      setCollectionLinkPrompt(null); setSelectedMatchSourceIds([]);
    } catch (error) { alert(error instanceof Error ? error.message : 'Could not move this game to your collection.'); } finally { setIsLinkingCollection(false); }
  };
  const markAsOwned = async (game: Boardgame) => {
    if (game.is_expansion) {
      const requestedParent = normalizedGameName(game.parent_game_name);
      const suggestedParent = requestedParent
        ? ownedGames.find(candidate => {
            const candidateName = normalizedGameName(candidate.name);
            return candidateName === requestedParent || candidateName.includes(requestedParent) || requestedParent.includes(candidateName);
          })
        : undefined;
      setMovingExpansion(game); setSelectedParentGameId(suggestedParent?.id || null); setParentGameSearch('');
      return;
    }
    const sources = externalMatchCandidates(game.name, game.id);
    if (sources.length) { openCollectionLinkPrompt('move', { ...game, library_section: 'owned' }, game.id, sources); return; }
    await moveGameToCollection(game);
  };
  const attachExpansion = async () => {
    if (!movingExpansion || !selectedParentGameId) return;
    setIsAttachingExpansion(true);
    try {
      const response = await fetchWithAuth(`/boardgames/${movingExpansion.id}/attach`, {
        method: 'POST',
        body: JSON.stringify({ parent_game_id: selectedParentGameId }),
      });
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.detail || 'Could not attach this expansion.'); }
      const updatedParent: Boardgame = await response.json();
      setGames(current => current.filter(game => game.id !== movingExpansion.id).map(game => game.id === updatedParent.id ? updatedParent : game));
      setMovingExpansion(null); setSelectedParentGameId(null); setParentGameSearch('');
      setActiveTab('owned'); setSearchQuery(updatedParent.name); setSelectedTag(''); setShowFilters(false);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not attach this expansion.');
    } finally { setIsAttachingExpansion(false); }
  };
  const searchBgg = async () => {
    if (bggQuery.trim().length < 2) return; setIsSearchingBgg(true);
    try {
      const response = await fetchWithAuth(`/boardgames/bgg/search?q=${encodeURIComponent(bggQuery.trim())}`);
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.detail || 'BGG search failed.'); }
      setBggResults(await response.json());
    } catch (error) { alert(error instanceof Error ? error.message : 'BGG search failed.'); } finally { setIsSearchingBgg(false); }
  };
  const syncBgg = async (bggId?: number) => {
    const id = bggId || gameDraft?.bgg_id; if (!id || !gameDraft) return; setIsSyncingBgg(true);
    try {
      const response = await fetchWithAuth(`/boardgames/bgg/${id}`);
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.detail || 'Could not sync this BGG game.'); }
      const metadata: BggMetadata = await response.json();
      setGameDraft(current => current ? ({ ...current, bgg_id: metadata.id, bgg_rank: metadata.rank, name: metadata.name || current.name, description: metadata.description || current.description, image_url: metadata.image_url || current.image_url, publication_year: metadata.year_published || current.publication_year, bgg_link: metadata.bgg_link, is_expansion: metadata.is_expansion }) : null);
      setBggResults([]); setBggQuery(metadata.name);
    } catch (error) { alert(error instanceof Error ? error.message : 'BGG sync failed. You can still edit every field manually.'); } finally { setIsSyncingBgg(false); }
  };
  const addExpansion = () => {
    if (!gameDraft || !expansionName.trim()) return; const expansions = parseStringList(gameDraft.expansions);
    if (!expansions.some(item => item.toLocaleLowerCase() === expansionName.trim().toLocaleLowerCase())) setGameDraft({ ...gameDraft, expansions: JSON.stringify([...expansions, expansionName.trim()]) });
    setExpansionName('');
  };
  const removeExpansion = (name: string) => { if (!gameDraft) return; const expansions = parseStringList(gameDraft.expansions).filter(item => item !== name); setGameDraft({ ...gameDraft, expansions: expansions.length ? JSON.stringify(expansions) : null }); };
  const openNewMatch = (gameId?: number) => {
    const initialId = gameId || (ownedGames.length === 1 && !externalGames.length ? ownedGames[0].id : undefined);
    setEditingMatchId(null); setPlayerQuery(''); setShowPlayerSuggestions(false); setShowGameSuggestions(false); setMatchGameQuery(games.find(game => game.id === initialId)?.name || ''); setMatchDraft(newMatchDraft(initialId));
  };
  const openEditMatch = (match: BoardgameMatch) => {
    const legacyPlayerIds = match.player_ids?.length ? match.player_ids : players.filter(player => matchPlayerNames(match).some(name => normalizedGameName(name) === normalizedGameName(player.name))).map(player => player.id);
    setPlayerQuery(''); setShowPlayerSuggestions(false); setShowGameSuggestions(false); setMatchGameQuery(match.game_name);
    setEditingMatchId(match.id); setMatchDraft({ boardgame_id: match.boardgame_id, player_ids: legacyPlayerIds, mode: match.mode, result: match.result === 'defeat' ? 'defeat' : 'victory', winner_name: match.winner_name || '', comments: match.comments || '', played_date: match.played_date || '' });
  };
  const ensureExternalGame = async (name: string): Promise<Boardgame> => {
    const existing = externalGames.find(game => normalizedGameName(game.name) === normalizedGameName(name));
    if (existing) return existing;
    const response = await fetchWithAuth('/boardgames/', { method: 'POST', body: JSON.stringify({ ...newGameDraft('external'), name: name.trim() }) });
    if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.detail || 'Could not add this game.'); }
    const saved: Boardgame = await response.json(); setGames(current => [...current, saved]); return saved;
  };
  const toggleDraftPlayer = (playerId: number) => {
    if (!matchDraft) return;
    const selected = matchDraft.player_ids.includes(playerId);
    setMatchDraft({ ...matchDraft, player_ids: selected ? matchDraft.player_ids.filter(id => id !== playerId) : [...matchDraft.player_ids, playerId] });
    setPlayerQuery(''); setShowPlayerSuggestions(false);
  };
  const createPlayer = async () => {
    if (!matchDraft || !playerQuery.trim()) return;
    const existing = players.find(player => normalizedGameName(player.name) === normalizedGameName(playerQuery));
    if (existing) { toggleDraftPlayer(existing.id); return; }
    setIsCreatingPlayer(true);
    try {
      const response = await fetchWithAuth('/boardgames/players', { method: 'POST', body: JSON.stringify({ name: playerQuery.trim() }) });
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.detail || 'Could not add this player.'); }
      const saved: BoardgamePlayer = await response.json();
      setPlayers(current => current.some(player => player.id === saved.id) ? current : [...current, saved]);
      setMatchDraft(current => current ? { ...current, player_ids: current.player_ids.includes(saved.id) ? current.player_ids : [...current.player_ids, saved.id] } : null); setPlayerQuery(''); setShowPlayerSuggestions(false);
    } catch (error) { alert(error instanceof Error ? error.message : 'Could not add this player.'); } finally { setIsCreatingPlayer(false); }
  };
  const saveMatch = async () => {
    if (!matchDraft || (!matchDraft.boardgame_id && !matchGameQuery.trim()) || !matchDraft.played_date || (matchDraft.mode === 'competitive' && !matchDraft.winner_name.trim())) return;
    setIsSavingMatch(true);
    try {
      const game = matchDraft.boardgame_id ? games.find(item => item.id === matchDraft.boardgame_id) : await ensureExternalGame(matchGameQuery);
      if (!game) throw new Error('Choose a matching game or enter a new game name.');
      const payload = { ...matchDraft, boardgame_id: game.id, played_with: null, result: matchDraft.mode === 'competitive' ? 'winner' : matchDraft.result, winner_name: matchDraft.mode === 'competitive' ? matchDraft.winner_name.trim() : null, comments: matchDraft.comments.trim() || null };
      const response = await fetchWithAuth(editingMatchId ? `/boardgames/matches/${editingMatchId}` : '/boardgames/matches', { method: editingMatchId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.detail || 'Could not save this match.'); }
      const saved: BoardgameMatch = await response.json(); setMatches(current => editingMatchId ? current.map(match => match.id === saved.id ? saved : match) : [saved, ...current]); setMatchDraft(null);
    } catch (error) { alert(error instanceof Error ? error.message : 'Could not save this match.'); } finally { setIsSavingMatch(false); }
  };
  const deleteMatch = async (match: BoardgameMatch) => { if (!window.confirm(`Delete the ${matchDateLabel(match.played_date)} match of “${match.game_name}”?`)) return; const response = await fetchWithAuth(`/boardgames/matches/${match.id}`, { method: 'DELETE' }); if (response.ok) setMatches(current => current.filter(item => item.id !== match.id)); };
  const clearLibraryFilters = () => { setSearchQuery(''); setSelectedTag(''); setMaxRank(''); setMaxPrice(''); setMinHype(''); setMinRating(''); setExpansionFilter('all'); setCurrentPage(1); };
  const clearMatchFilters = () => { setMatchSearch(''); setMatchFriendFilter(''); setMatchModeFilter(''); setMatchResultFilter(''); setMatchTagFilter(''); setMatchDateFrom(''); setMatchDateTo(''); };
  const toggleMatchSource = (gameId: number) => setSelectedMatchSourceIds(current => current.includes(gameId) ? current.filter(id => id !== gameId) : [...current, gameId]);
  const completeCollectionLink = (linkMatches: boolean) => {
    if (!collectionLinkPrompt) return;
    const sourceIds = linkMatches ? selectedMatchSourceIds : [];
    if (collectionLinkPrompt.action === 'create') {
      void persistGame(collectionLinkPrompt.draft, null, sourceIds);
      return;
    }
    if (collectionLinkPrompt.targetGameId) {
      void moveGameToCollection({ ...collectionLinkPrompt.draft, id: collectionLinkPrompt.targetGameId }, sourceIds);
    }
  };

  if (isLoading) return <div className="bg-loading"><Loader2 className="spinner" size={34} /><p>Opening your board-game vault…</p></div>;

  return <div className="container bg-dashboard">
    <header className="bg-main-header"><div><div className="bg-header-kicker"><Dices size={16} /> Tabletop collection</div><h1>Board Game Vault</h1><p>Plan the next purchase, curate the shelf, and remember every game night.</p></div><div className="bg-header-actions"><button className="btn btn-secondary" onClick={() => setShowExcelImport(true)}><Upload size={18} /> Smart Add</button>{user?.is_admin && <Link to="/dashboard/boardgames/admin" className="btn btn-secondary"><Shield size={18} /> Admin</Link>}<Link to="/dashboard/boardgames/analytics" className="btn btn-secondary"><BarChart3 size={18} /> Analytics</Link></div></header>
    {loadError && <div className="bg-error-banner">{loadError}<button onClick={() => loadDashboard()}>Retry</button></div>}
    <nav className="bg-section-tabs" aria-label="Board game sections">
      <button className={activeTab === 'wishlist' ? 'active' : ''} onClick={() => changeTab('wishlist')}><span><ShoppingBag /><i>{wishlistGames.length}</i></span><strong>Want to buy</strong><small>Wishlist, ranks and prices</small></button>
      <button className={activeTab === 'owned' ? 'active' : ''} onClick={() => changeTab('owned')}><span><Archive /><i>{ownedGames.length}</i></span><strong>My collection</strong><small>Owned games and expansions</small></button>
      <button className={activeTab === 'matches' ? 'active' : ''} onClick={() => changeTab('matches')}><span><History /><i>{matches.length}</i></span><strong>Match history</strong><small>Every table, player and result</small></button>
    </nav>

    {activeTab !== 'matches' ? <>
      <section className="bg-section-intro"><div className={activeTab === 'wishlist' ? 'bg-intro-icon wishlist' : 'bg-intro-icon owned'}>{activeTab === 'wishlist' ? <Heart /> : <PackageCheck />}</div><div><h2>{activeTab === 'wishlist' ? 'Your next shelf candidates' : 'The games you own'}</h2><p>{activeTab === 'wishlist' ? 'Keep an eye on BGG rank, price and how excited you are.' : 'Rate your collection and keep every expansion attached to its base game.'}</p></div><button className="btn btn-primary" onClick={() => openNewGame(activeTab)}><Plus size={18} /> {activeTab === 'wishlist' ? 'Add wishlist game' : 'Add owned game'}</button></section>
      <section className="bg-toolbar"><div className="bg-search"><Search size={18} /><input value={searchQuery} onChange={event => { setSearchQuery(event.target.value); setCurrentPage(1); }} placeholder={`Search ${activeTab === 'wishlist' ? 'wishlist' : 'collection'}…`} /></div><select value={selectedTag} onChange={event => { setSelectedTag(event.target.value); setCurrentPage(1); }} aria-label="Filter by tag"><option value="">All tags</option>{availableTags.map(tag => <option key={tag.id} value={tag.name}>{tag.name}</option>)}</select><select value={sortBy} onChange={event => { setSortBy(event.target.value); setCurrentPage(1); }} aria-label="Sort board games"><option value="name">Name A–Z</option><option value="rank">Best BGG rank</option>{activeTab === 'wishlist' ? <><option value="hype">Highest anticipation</option><option value="price-low">Lowest price</option><option value="price-high">Highest price</option></> : <option value="rating">Highest rating</option>}</select><button className={showFilters ? 'bg-tool-button active' : 'bg-tool-button'} onClick={() => setShowFilters(value => !value)}><Filter size={17} /> Filters</button><div className="bg-view-toggle"><button className={libraryView === 'grid' ? 'active' : ''} onClick={() => setLibraryView('grid')} aria-label="Grid view"><Grid2X2 size={17} /></button><button className={libraryView === 'list' ? 'active' : ''} onClick={() => setLibraryView('list')} aria-label="List view"><LayoutList size={18} /></button></div></section>
      {showFilters && <section className="bg-filter-drawer">{activeTab === 'wishlist' ? <><label>Maximum BGG rank<input type="number" min="1" value={maxRank} onChange={event => setMaxRank(event.target.value)} placeholder="e.g. 500" /></label><label>Maximum price (€)<input type="number" min="0" step="0.01" value={maxPrice} onChange={event => setMaxPrice(event.target.value)} placeholder="e.g. 60" /></label><label>Minimum anticipation<select value={minHype} onChange={event => setMinHype(event.target.value)}><option value="">Any</option>{[5,6,7,8,9,10].map(score => <option key={score} value={score}>{score}+</option>)}</select></label></> : <><label>Minimum rating<select value={minRating} onChange={event => setMinRating(event.target.value)}><option value="">Any</option>{[5,6,7,8,9,10].map(score => <option key={score} value={score}>{score}+</option>)}</select></label><label>Expansions<select value={expansionFilter} onChange={event => setExpansionFilter(event.target.value as typeof expansionFilter)}><option value="all">All games</option><option value="with">Has expansions</option><option value="without">No expansions</option></select></label></>}<button onClick={clearLibraryFilters}><X size={16} /> Clear filters</button></section>}
      <div className="bg-results-line"><span>{visibleGames.length} {visibleGames.length === 1 ? 'game' : 'games'}</span>{(searchQuery || selectedTag || maxRank || maxPrice || minHype || minRating || expansionFilter !== 'all') && <button onClick={clearLibraryFilters}>Reset all</button>}</div>
      {visibleGames.length ? <><section className={`bg-library ${libraryView}`}>{pagedVisibleGames.map(game => {
        const expansions = parseStringList(game.expansions), tags = parseStringList(game.tags);
        return <article className="bg-game-card" key={game.id}><div className="bg-card-art"><GameArtwork game={game} /><div className="bg-card-badges">{game.is_expansion && <span className="expansion">Expansion</span>}{game.bgg_rank ? <span className="rank"><Medal size={13} /> #{game.bgg_rank}</span> : <span className="unranked">Unranked</span>}</div><div className="bg-card-actions"><button onClick={() => openEditGame(game)} aria-label={`Edit ${game.name}`}><Edit2 size={16} /></button><button onClick={() => deleteGame(game)} aria-label={`Delete ${game.name}`}><Trash2 size={16} /></button></div></div><div className="bg-card-body"><div className="bg-card-title"><div><h3 className={gameTitleClass(game.name)} title={game.name}>{game.name}</h3>{game.publication_year && <small>{game.publication_year}</small>}</div>{game.bgg_link && <a href={game.bgg_link} target="_blank" rel="noreferrer" title="Open on BoardGameGeek"><ExternalLink size={16} /></a>}</div>{game.is_expansion && game.parent_game_name && <p className="bg-parent-game">For {game.parent_game_name}</p>}{activeTab === 'wishlist' ? <><div className="bg-wishlist-metrics"><div><CircleDollarSign /><span>{formatPrice(game.price)}</span></div><div><Sparkles /><span>{game.hype ? `${game.hype}/10` : 'No anticipation'}</span></div></div><button className="bg-owned-action" onClick={() => markAsOwned(game)}><PackageCheck size={16} /> Move to collection</button></> : <><div className="bg-owned-metrics"><div><Trophy /><span>{game.mark ? `${game.mark}/10` : 'Not rated'}</span></div><div><Gamepad2 /><span>{game.bgg_id ? `BGG ${game.bgg_id}` : 'No BGG ID'}</span></div></div><div className="bg-expansion-summary"><PackageCheck size={16} /><span>{expansions.length ? `${expansions.length} expansion${expansions.length === 1 ? '' : 's'}` : 'No expansions added'}</span></div>{expansions.length > 0 && <div className="bg-expansion-chips">{expansions.slice(0, 3).map(item => <span key={item}>{item}</span>)}{expansions.length > 3 && <span>+{expansions.length - 3}</span>}</div>}</>}{tags.length > 0 && <div className="bg-tag-row">{tags.slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}</div>}</div></article>;
      })}</section><PaginationControls page={visibleLibraryPage} pageSize={pageSize} pageSizeOptions={pageSizeOptions} totalItems={visibleGames.length} onPageChange={setCurrentPage} onPageSizeChange={value => { setPageSize(value); setCurrentPage(1); }} /></> : <section className="bg-empty-state"><div>{activeTab === 'wishlist' ? <ShoppingBag /> : <Archive />}</div><h2>{searchQuery || selectedTag ? 'No games match these filters' : activeTab === 'wishlist' ? 'Your wishlist is ready for its first game' : 'Your collection is waiting'}</h2><p>{searchQuery || selectedTag ? 'Try clearing one or more filters.' : 'Add a game to start building this section.'}</p><button className="btn btn-primary" onClick={() => openNewGame(activeTab)}><Plus size={18} /> Add a game</button></section>}
    </> : <>
      <section className="bg-section-intro matches"><div className="bg-intro-icon matches"><History /></div><div><h2>Your table, remembered</h2><p>Log every group, mode, result and story from game night—even when the game belongs to someone else.</p></div><button className="btn btn-primary" onClick={() => openNewMatch()}><Plus size={18} /> Log a match</button></section>
      <section className="bg-toolbar match-toolbar"><div className="bg-search"><Search size={18} /><input value={matchSearch} onChange={event => setMatchSearch(event.target.value)} placeholder="Search games, players or comments…" /></div><div className="bg-friend-dropdown" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsFriendMenuOpen(false); }}><button type="button" className={matchFriendFilter ? 'bg-friend-trigger active' : 'bg-friend-trigger'} onClick={() => setIsFriendMenuOpen(value => !value)} aria-label="Filter by friend" aria-haspopup="listbox" aria-expanded={isFriendMenuOpen}><UserRound size={16} /><span>{selectedFriend ? `${selectedFriend.name} · ${selectedFriend.plays}` : `All friends (${friendOptions.length})`}</span><ChevronDown size={15} /></button>{isFriendMenuOpen && <div className="bg-friend-menu" role="listbox" aria-label="Friends"><button type="button" role="option" aria-selected={!matchFriendFilter} className={!matchFriendFilter ? 'selected' : ''} onClick={() => { setMatchFriendFilter(''); setIsFriendMenuOpen(false); }}><span>All friends</span><small>{friendOptions.length}</small></button>{friendOptions.map(friend => { const key = normalizedGameName(friend.name); return <button type="button" role="option" aria-selected={matchFriendFilter === key} className={matchFriendFilter === key ? 'selected' : ''} key={key} onClick={() => { setMatchFriendFilter(key); setIsFriendMenuOpen(false); }}><span>{friend.name}</span><small>{friend.plays} {friend.plays === 1 ? 'play' : 'plays'}</small></button>; })}</div>}</div><select value={matchModeFilter} onChange={event => setMatchModeFilter(event.target.value)} aria-label="Filter by match mode"><option value="">All modes</option><option value="competitive">Competitive</option><option value="cooperative">Co-op</option><option value="solo">Solo</option></select><select value={matchResultFilter} onChange={event => setMatchResultFilter(event.target.value)} aria-label="Filter by result"><option value="">All outcomes</option><option value="victory">Victories</option><option value="defeat">Defeats</option><option value="incomplete">Not finished</option><option value="competitive">Competitive winners</option></select><button className={showFilters ? 'bg-tool-button active' : 'bg-tool-button'} onClick={() => setShowFilters(value => !value)}><Filter size={17} /> More</button><div className="bg-view-toggle"><button className={matchView === 'list' ? 'active' : ''} onClick={() => { setMatchView('list'); setSelectedMatchGameId(null); }} aria-label="Match list view"><LayoutList size={18} /></button><button className={matchView === 'games' ? 'active' : ''} onClick={() => setMatchView('games')} aria-label="Matches by game"><Grid2X2 size={17} /></button></div></section>
      {showFilters && <section className="bg-filter-drawer match-filters"><label>From<input type="date" value={matchDateFrom} onChange={event => setMatchDateFrom(event.target.value)} /></label><label>To<input type="date" value={matchDateTo} onChange={event => setMatchDateTo(event.target.value)} /></label><label>Game tag<select value={matchTagFilter} onChange={event => setMatchTagFilter(event.target.value)}><option value="">Any tag</option>{availableTags.map(tag => <option key={tag.id} value={tag.name}>{tag.name}</option>)}</select></label><button onClick={clearMatchFilters}><X size={16} /> Clear filters</button></section>}
      {selectedFriendStats && <section className="bg-friend-summary"><div className="bg-friend-summary-avatar">{selectedFriendStats.name.charAt(0).toUpperCase()}</div><div className="bg-friend-summary-name"><small>Games with</small><strong>{selectedFriendStats.name}</strong></div><div><strong>{selectedFriendStats.plays}</strong><span>shared plays</span></div><div><strong>{selectedFriendStats.games}</strong><span>different games</span></div><div className="favorite"><strong>{selectedFriendStats.favoriteGame}</strong><span>most played together</span></div><div><strong>{selectedFriendStats.cooperativeWins}</strong><span>co-op victories</span></div><button onClick={() => setMatchFriendFilter('')} aria-label="Clear friend filter"><X size={16} /></button></section>}
      <div className="bg-match-summary-bar"><div><strong>{filteredMatches.length}</strong><span>matches</span></div><div><strong>{new Set(filteredMatches.map(match => match.boardgame_id)).size}</strong><span>games played</span></div><div><strong>{filteredMatches.filter(match => match.result === 'victory').length}</strong><span>co-op / solo wins</span></div><div><strong>{new Set(filteredMatches.flatMap(match => matchPlayerNames(match))).size}</strong><span>tablemates</span></div></div>
      {matchView === 'games' && !selectedMatchGameId ? (matchGameGroups.length ? <section className="bg-match-game-grid">{matchGameGroups.map(group => {
        const latest = group.matches[0], players = [...new Set(group.matches.flatMap(match => matchPlayerNames(match)))];
        return <button key={group.gameId} className="bg-match-game-card" onClick={() => setSelectedMatchGameId(group.gameId)}><div className="bg-match-game-art">{group.game ? <GameArtwork game={group.game} /> : <div className="bg-artwork-placeholder"><Dices /></div>}<span>{group.matches.length} {group.matches.length === 1 ? 'play' : 'plays'}</span></div><div><h3>{latest.game_name}</h3><p><CalendarDays size={15} /> Last played {matchDateLabel(latest.played_date)}</p><p><UsersRound size={15} /> {players.length ? players.slice(0, 3).join(', ') : 'Solo table'}</p><span className="bg-open-history">Open history <ChevronRight size={16} /></span></div></button>;
      })}</section> : <section className="bg-empty-state"><div><History /></div><h2>No matches found</h2><p>Log your first game night or clear the active filters.</p><button className="btn btn-primary" onClick={() => openNewMatch()}><Plus size={18} /> Log a match</button></section>) : <section className="bg-match-list-section">{selectedMatchGameId && <div className="bg-selected-game-header"><button onClick={() => setSelectedMatchGameId(null)}><ArrowLeft size={17} /> All games</button><div><h2>{games.find(game => game.id === selectedMatchGameId)?.name}</h2><p>{filteredMatches.length} recorded matches</p></div><button className="btn btn-primary" onClick={() => openNewMatch(selectedMatchGameId)}><Plus size={17} /> Add match</button></div>}{filteredMatches.length ? <div className="bg-match-list">{filteredMatches.map(match => {
        const playerNames = matchPlayerNames(match), isUnownedGame = games.find(game => game.id === match.boardgame_id)?.library_section !== 'owned';
        return <article key={match.id} className="bg-match-row"><div className={`bg-match-date ${match.played_date ? '' : 'unknown'}`}>{match.played_date ? <><strong>{new Date(`${match.played_date}T12:00:00`).toLocaleDateString(undefined, { day: '2-digit' })}</strong><span>{new Date(`${match.played_date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span></> : <><strong>?</strong><span>Unknown</span></>}</div><div className="bg-match-cover">{match.game_image_url ? <img src={match.game_image_url} alt="" /> : <Dices />}</div><div className="bg-match-main"><h3>{match.game_name}{isUnownedGame && <small className="bg-external-game-badge">Not in collection</small>}</h3><div><span className={`mode ${match.mode}`}>{match.mode === 'competitive' ? <Swords /> : match.mode === 'cooperative' ? <UsersRound /> : <UserRound />}{modeLabel(match.mode)}</span><span className={`result ${match.result}`}>{match.result === 'victory' ? <Trophy /> : match.result === 'defeat' ? <X /> : match.result === 'incomplete' ? <AlertTriangle /> : <Crown />}{resultLabel(match)}</span></div></div><div className="bg-match-players"><small>Played with</small><span>{playerNames.length ? playerNames.join(', ') : match.mode === 'solo' ? 'Solo' : 'Not recorded'}</span></div><div className="bg-match-comment"><small>Memory</small><span>{match.comments || 'No comments'}</span></div><div className="bg-match-actions"><button onClick={() => openEditMatch(match)} aria-label={`Edit ${match.game_name} match`}><Edit2 size={16} /></button><button onClick={() => deleteMatch(match)} aria-label={`Delete ${match.game_name} match`}><Trash2 size={16} /></button></div></article>;
      })}</div> : <section className="bg-empty-state compact"><div><History /></div><h2>No matches found</h2><p>Try clearing filters or log a new match.</p><button className="btn btn-primary" onClick={() => openNewMatch(selectedMatchGameId || undefined)}><Plus size={18} /> Log a match</button></section>}</section>}
    </>}

    {showExcelImport && <BoardgameExcelImportModal onClose={() => setShowExcelImport(false)} onImported={() => loadDashboard(false)} />}

    {movingExpansion && createPortal(<div className="bg-modal-backdrop" onMouseDown={() => !isAttachingExpansion && setMovingExpansion(null)}><section className="bg-modal bg-attach-modal" role="dialog" aria-modal="true" aria-labelledby="attach-expansion-title" onMouseDown={event => event.stopPropagation()}><header><div className="wishlist"><PackageCheck /></div><div><span>Move expansion</span><h2 id="attach-expansion-title">Choose its base game</h2></div><button onClick={() => setMovingExpansion(null)} disabled={isAttachingExpansion} aria-label="Close"><X /></button></header><div className="bg-modal-scroll"><div className="bg-attach-intro"><strong>{movingExpansion.name}</strong><span>This wishlist entry will be removed and added to the selected game’s expansion list.</span>{movingExpansion.parent_game_name && <small>Wishlist base game: {movingExpansion.parent_game_name}</small>}</div><div className="bg-search bg-parent-search"><Search size={18} /><input value={parentGameSearch} onChange={event => setParentGameSearch(event.target.value)} placeholder="Search your collection…" autoFocus /></div>{expansionParentGames.length ? <div className="bg-parent-picker">{expansionParentGames.map(game => { const count = parseStringList(game.expansions).length; const isSuggested = movingExpansion.parent_game_name && normalizedGameName(game.name) === normalizedGameName(movingExpansion.parent_game_name); return <button key={game.id} className={selectedParentGameId === game.id ? 'selected' : ''} onClick={() => setSelectedParentGameId(game.id)}><span className="bg-parent-radio">{selectedParentGameId === game.id && <Check />}</span><div><strong>{game.name}</strong><small>{count ? `${count} expansion${count === 1 ? '' : 's'} already attached` : 'No expansions attached yet'}</small></div>{isSuggested && <em>Suggested</em>}</button>; })}</div> : <div className="bg-parent-empty"><Archive /><strong>No matching collection games</strong><span>Add the base game to your collection first, or try another search.</span></div>}</div><footer><button className="btn btn-secondary" onClick={() => setMovingExpansion(null)} disabled={isAttachingExpansion}>Cancel</button><button className="btn btn-primary" onClick={attachExpansion} disabled={!selectedParentGameId || isAttachingExpansion}>{isAttachingExpansion ? <Loader2 className="spinner" /> : <PackageCheck />} Add to selected game</button></footer></section></div>, document.body)}

    {gameDraft && createPortal(<div className="bg-modal-backdrop" onMouseDown={() => !isSavingGame && setGameDraft(null)}><section className="bg-modal bg-game-modal" role="dialog" aria-modal="true" aria-labelledby="game-modal-title" onMouseDown={event => event.stopPropagation()}><header><div className={gameDraft.library_section === 'wishlist' ? 'wishlist' : 'owned'}>{gameDraft.library_section === 'wishlist' ? <ShoppingBag /> : <Archive />}</div><div><span>{editingGameId ? 'Edit entry' : 'New entry'}</span><h2 id="game-modal-title">{editingGameId ? gameDraft.name : gameDraft.library_section === 'wishlist' ? 'Add to wishlist' : 'Add to collection'}</h2></div><button onClick={() => setGameDraft(null)} aria-label="Close"><X /></button></header><div className="bg-modal-scroll">
      <section className="bg-bgg-panel"><div className="bg-bgg-heading"><div><strong>BoardGameGeek sync</strong><span>Search BGG to fill the name, image, year and current rank. Every field stays editable.</span></div><a href="https://boardgamegeek.com" target="_blank" rel="noreferrer">Powered by BGG</a></div><div className="bg-bgg-search"><input value={bggQuery} onChange={event => setBggQuery(event.target.value)} onKeyDown={event => event.key === 'Enter' && searchBgg()} placeholder="Search BoardGameGeek…" /><button onClick={searchBgg} disabled={isSearchingBgg || bggQuery.trim().length < 2}>{isSearchingBgg ? <Loader2 className="spinner" /> : <Search />}</button></div>{bggResults.length > 0 && <div className="bg-bgg-results">{bggResults.map(result => <button key={result.id} onClick={() => syncBgg(result.id)}><div><strong>{result.name}</strong><span>{result.year_published || 'Unknown year'} · {result.item_type === 'boardgameexpansion' ? 'Expansion' : 'Board game'}</span></div><small>BGG {result.id}</small><ChevronRight /></button>)}</div>}<div className="bg-bgg-id-row"><label>BGG ID<input type="number" min="1" value={gameDraft.bgg_id ?? ''} onChange={event => setGameDraft({ ...gameDraft, bgg_id: event.target.value ? Number(event.target.value) : null })} placeholder="e.g. 174430" /></label><button onClick={() => syncBgg()} disabled={!gameDraft.bgg_id || isSyncingBgg}>{isSyncingBgg ? <Loader2 className="spinner" /> : <RefreshCw />} Sync now</button></div></section>
      <div className="bg-form-grid"><label className="wide">Game name<input value={gameDraft.name} onChange={event => setGameDraft({ ...gameDraft, name: event.target.value })} placeholder="Board game title" autoFocus /></label><label>Publication year<input type="number" value={gameDraft.publication_year ?? ''} onChange={event => setGameDraft({ ...gameDraft, publication_year: event.target.value ? Number(event.target.value) : null })} /></label><label>Current BGG rank<input type="number" min="1" value={gameDraft.bgg_rank ?? ''} onChange={event => setGameDraft({ ...gameDraft, bgg_rank: event.target.value ? Number(event.target.value) : null })} placeholder="Editable fallback" /></label><label className="wide">Cover image URL<input type="url" value={gameDraft.image_url ?? ''} onChange={event => setGameDraft({ ...gameDraft, image_url: event.target.value || null })} placeholder="https://…" /></label><label className="wide">Description<textarea value={gameDraft.description ?? ''} onChange={event => setGameDraft({ ...gameDraft, description: event.target.value || null })} rows={3} placeholder="What is the game about?" /></label></div>
      {gameDraft.library_section === 'wishlist' ? <section className="bg-form-section"><h3><ShoppingBag /> Wishlist details</h3><div className="bg-form-grid"><label>Price (€)<input type="number" min="0" step="0.01" value={gameDraft.price ?? ''} onChange={event => setGameDraft({ ...gameDraft, price: event.target.value ? Number(event.target.value) : null })} placeholder="Editable price" /></label><label>Anticipation<select value={gameDraft.hype ?? ''} onChange={event => setGameDraft({ ...gameDraft, hype: event.target.value ? Number(event.target.value) : null })}><option value="">Not rated</option>{Array.from({ length: 10 }, (_, index) => index + 1).map(score => <option key={score} value={score}>{score}/10</option>)}</select></label><label className="bg-checkbox-label wide"><input type="checkbox" checked={gameDraft.is_expansion} onChange={event => setGameDraft({ ...gameDraft, is_expansion: event.target.checked })} /><span><strong>This entry is an expansion</strong><small>Expansions can live independently in the wishlist.</small></span></label>{gameDraft.is_expansion && <label className="wide">Base game<input value={gameDraft.parent_game_name ?? ''} onChange={event => setGameDraft({ ...gameDraft, parent_game_name: event.target.value || null })} placeholder="Which game is it for?" /></label>}</div></section> : <section className="bg-form-section"><h3><Archive /> Collection details</h3><div className="bg-form-grid"><label>Your rating<select value={gameDraft.mark ?? ''} onChange={event => setGameDraft({ ...gameDraft, mark: event.target.value ? Number(event.target.value) : null })}><option value="">Not rated</option>{Array.from({ length: 10 }, (_, index) => index + 1).map(score => <option key={score} value={score}>{score}/10</option>)}</select></label><label>BGG link<input type="url" value={gameDraft.bgg_link ?? ''} onChange={event => setGameDraft({ ...gameDraft, bgg_link: event.target.value || null })} placeholder="https://boardgamegeek.com/…" /></label></div><div className="bg-expansion-editor"><div><strong>Expansions you own</strong><span>Add them manually and keep them grouped with this game.</span></div><div className="bg-expansion-input"><input value={expansionName} onChange={event => setExpansionName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addExpansion(); } }} placeholder="Expansion name" /><button onClick={addExpansion} disabled={!expansionName.trim()}><Plus /> Add</button></div>{parseStringList(gameDraft.expansions).length > 0 ? <div className="bg-expansion-edit-list">{parseStringList(gameDraft.expansions).map(name => <span key={name}><PackageCheck />{name}<button onClick={() => removeExpansion(name)} aria-label={`Remove ${name}`}><X /></button></span>)}</div> : <p>No expansions added yet.</p>}</div></section>}
      <section className="bg-form-section"><h3><TagIcon /> Tags and notes</h3><label className="bg-field-label">Tags<TagMultiSelect availableTags={availableTags} selectedTagsString={gameDraft.tags || ''} onChange={tags => setGameDraft({ ...gameDraft, tags: tags || null })} /></label><label className="bg-field-label">Private notes<textarea value={gameDraft.comments ?? ''} onChange={event => setGameDraft({ ...gameDraft, comments: event.target.value || null })} rows={3} placeholder="Edition, shop, language, reminders…" /></label></section>
    </div><footer><button className="btn btn-secondary" onClick={() => setGameDraft(null)} disabled={isSavingGame}>Cancel</button><button className="btn btn-primary" onClick={saveGame} disabled={isSavingGame || !gameDraft.name.trim()}>{isSavingGame ? <Loader2 className="spinner" /> : <Check />} {editingGameId ? 'Save changes' : 'Add game'}</button></footer></section></div>, document.body)}

    {collectionLinkPrompt && createPortal(
      <div className="bg-modal-backdrop bg-link-modal-backdrop" onMouseDown={() => !isSavingGame && !isLinkingCollection && setCollectionLinkPrompt(null)}>
        <section className="bg-modal bg-link-modal" role="dialog" aria-modal="true" aria-labelledby="link-match-history-title" onMouseDown={event => event.stopPropagation()}>
          <header><div className="matches"><History /></div><div><span>Similar match history found</span><h2 id="link-match-history-title">Link matches to “{collectionLinkPrompt.draft.name}”?</h2></div><button onClick={() => setCollectionLinkPrompt(null)} disabled={isSavingGame || isLinkingCollection} aria-label="Close"><X /></button></header>
          <div className="bg-modal-scroll">
            <p className="bg-link-intro">These Not in collection records have similar names. Select the ones that refer to this game; their matches will move to the collection entry.</p>
            <div className="bg-link-source-list">{collectionLinkPrompt.sources.map(source => {
              const sourceMatches = matches.filter(match => match.boardgame_id === source.id);
              const selected = selectedMatchSourceIds.includes(source.id);
              return <button type="button" key={source.id} className={selected ? 'selected' : ''} onClick={() => toggleMatchSource(source.id)}><span className="bg-link-checkbox">{selected && <Check size={15} />}</span><GameArtwork game={source} compact /><span><strong>{source.name}</strong><small>{sourceMatches.length} {sourceMatches.length === 1 ? 'match' : 'matches'} · Last played {sourceMatches.map(match => match.played_date || '').sort().at(-1) || 'unknown'}</small></span></button>;
            })}</div>
            <p className="bg-link-note"><AlertTriangle size={16} /> Only link records that are truly the same game. Selected Not in collection records will be removed after their matches transfer.</p>
          </div>
          <footer><button className="btn btn-secondary" onClick={() => setCollectionLinkPrompt(null)} disabled={isSavingGame || isLinkingCollection}>Cancel</button><button className="btn btn-secondary" onClick={() => completeCollectionLink(false)} disabled={isSavingGame || isLinkingCollection}>{collectionLinkPrompt.action === 'create' ? 'Add without linking' : 'Move without linking'}</button><button className="btn btn-primary" onClick={() => completeCollectionLink(true)} disabled={!selectedMatchSourceIds.length || isSavingGame || isLinkingCollection}>{isSavingGame || isLinkingCollection ? <Loader2 className="spinner" /> : <History />} Link selected matches</button></footer>
        </section>
      </div>, document.body
    )}

    {matchDraft && createPortal(
      <div className="bg-modal-backdrop" onMouseDown={() => !isSavingMatch && !isCreatingPlayer && setMatchDraft(null)}>
        <section className="bg-modal bg-match-modal" role="dialog" aria-modal="true" aria-labelledby="match-modal-title" onMouseDown={event => event.stopPropagation()}>
          <header><div className="matches"><History /></div><div><span>{editingMatchId ? 'Edit match' : 'New game night'}</span><h2 id="match-modal-title">{editingMatchId ? 'Update match details' : 'Log a match'}</h2></div><button onClick={() => setMatchDraft(null)} aria-label="Close"><X /></button></header>
          <div className="bg-modal-scroll">
            <div className="bg-form-grid">
              <div className="wide bg-match-game-field">
                <label>Board game</label>
                <div className="bg-game-combobox" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setShowGameSuggestions(false); }}>
                  <div className={selectedMatchGame ? 'bg-game-query selected' : 'bg-game-query'}><Search size={17} /><input value={matchGameQuery} onFocus={() => setShowGameSuggestions(true)} onChange={event => { setMatchGameQuery(event.target.value); setMatchDraft({ ...matchDraft, boardgame_id: null }); setShowGameSuggestions(true); }} placeholder="Type a board game name…" autoFocus={!editingMatchId} />{selectedMatchGame && <Check size={17} />}</div>
                  {showGameSuggestions && matchGameQuery.trim() && <div className="bg-game-suggestions" role="listbox" aria-label="Matching board games">
                    {matchGameSuggestions.map(game => <button type="button" role="option" aria-selected={matchDraft.boardgame_id === game.id} key={game.id} onClick={() => { setMatchDraft({ ...matchDraft, boardgame_id: game.id }); setMatchGameQuery(game.name); setShowGameSuggestions(false); }}><GameArtwork game={game} compact /><span><strong>{game.name}</strong><small>In my collection</small></span><Check size={16} /></button>)}
                    {matchGameSuggestions.length === 0 && <p>No similar games in your collection.</p>}
                    <div className="bg-game-new-hint"><Plus size={15} /><span>Don’t select a result to log <strong>{matchGameQuery.trim()}</strong> as a game you do not own.</span></div>
                  </div>}
                </div>
                <p className={selectedMatchGame ? 'bg-game-choice selected' : 'bg-game-choice'}>{selectedMatchGame ? <><Check size={14} /> Using {selectedMatchGame.name} · {selectedMatchGame.library_section === 'owned' ? 'your collection copy' : 'not owned'}</> : matchGameQuery.trim() ? <><Plus size={14} /> Will create a non-owned game when this match is saved</> : 'Start typing to find a saved game or enter a new one.'}</p>
              </div>
              <label>Date<input type="date" value={matchDraft.played_date} onChange={event => setMatchDraft({ ...matchDraft, played_date: event.target.value })} /></label>
              <div className="bg-player-field"><label>Played with</label><div className="bg-player-picker" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setShowPlayerSuggestions(false); }}>{matchDraft.player_ids.length > 0 && <div className="bg-selected-players">{matchDraft.player_ids.map(playerId => { const player = players.find(item => item.id === playerId); return player && <span key={player.id}>{player.name}<button type="button" onClick={() => toggleDraftPlayer(player.id)} aria-label={`Remove ${player.name}`}><X size={12} /></button></span>; })}</div>}<div className="bg-player-query"><Search size={16} /><input value={playerQuery} onFocus={() => setShowPlayerSuggestions(true)} onChange={event => { setPlayerQuery(event.target.value); setShowPlayerSuggestions(true); }} onKeyDown={event => { if (event.key === 'Enter' && playerQuery.trim()) { event.preventDefault(); createPlayer(); } }} placeholder="Search or add a player…" /></div>{showPlayerSuggestions && <div className="bg-player-suggestions" role="listbox" aria-label="Saved players">{playerSuggestions.map(player => <button type="button" role="option" aria-selected={false} key={player.id} onClick={() => toggleDraftPlayer(player.id)}><span className="bg-player-option-avatar">{player.name.charAt(0).toUpperCase()}</span><strong>{player.name}</strong><Plus size={14} /></button>)}{playerQuery.trim() && !exactPlayerSuggestion && <button type="button" className="create" onClick={createPlayer} disabled={isCreatingPlayer}>{isCreatingPlayer ? <Loader2 className="spinner" /> : <Plus size={14} />}<span>Create player</span><strong>{playerQuery.trim()}</strong></button>}{playerSuggestions.length === 0 && (!playerQuery.trim() || exactPlayerSuggestion) && <p>No more matching players.</p>}</div>}</div></div>
            </div>
            <section className="bg-form-section"><h3><Swords /> Match type</h3><div className="bg-mode-picker">{(['competitive', 'cooperative', 'solo'] as MatchMode[]).map(mode => <button key={mode} className={matchDraft.mode === mode ? `active ${mode}` : ''} onClick={() => setMatchDraft({ ...matchDraft, mode })}>{mode === 'competitive' ? <Swords /> : mode === 'cooperative' ? <UsersRound /> : <UserRound />}<strong>{modeLabel(mode)}</strong><small>{mode === 'competitive' ? 'One named winner' : mode === 'cooperative' ? 'Win or lose together' : 'A solo challenge'}</small></button>)}</div></section>
            <section className="bg-form-section"><h3><Trophy /> Outcome</h3>{matchDraft.mode === 'competitive' ? <label className="bg-field-label">Who won?<select value={matchDraft.winner_name} onChange={event => setMatchDraft({ ...matchDraft, winner_name: event.target.value })}><option value="">Choose the winner…</option><option value="Yo">Me</option>{matchDraft.player_ids.map(playerId => players.find(player => player.id === playerId)).filter((player): player is BoardgamePlayer => Boolean(player) && normalizedGameName(player?.name) !== 'yo').map(player => <option key={player.id} value={player.name}>{player.name}</option>)}{matchDraft.winner_name && matchDraft.winner_name !== 'Yo' && !matchDraft.player_ids.some(playerId => players.find(player => player.id === playerId)?.name === matchDraft.winner_name) && <option value={matchDraft.winner_name}>{matchDraft.winner_name} (legacy)</option>}</select></label> : <div className="bg-result-picker"><button className={matchDraft.result === 'victory' ? 'active victory' : ''} onClick={() => setMatchDraft({ ...matchDraft, result: 'victory' })}><Trophy /> Victory</button><button className={matchDraft.result === 'defeat' ? 'active defeat' : ''} onClick={() => setMatchDraft({ ...matchDraft, result: 'defeat' })}><X /> Defeat</button></div>}</section>
            <label className="bg-field-label">Comments<textarea rows={4} value={matchDraft.comments} onChange={event => setMatchDraft({ ...matchDraft, comments: event.target.value })} placeholder="Memorable moments, close calls, strategies…" /></label>
          </div>
          <footer><button className="btn btn-secondary" onClick={() => setMatchDraft(null)} disabled={isSavingMatch || isCreatingPlayer}>Cancel</button><button className="btn btn-primary" onClick={saveMatch} disabled={isSavingMatch || isCreatingPlayer || (!matchDraft.boardgame_id && !matchGameQuery.trim()) || !matchDraft.played_date || (matchDraft.mode === 'competitive' && !matchDraft.winner_name.trim())}>{isSavingMatch ? <Loader2 className="spinner" /> : <Check />} {editingMatchId ? 'Save changes' : 'Log match'}</button></footer>
        </section>
      </div>, document.body
    )}
  </div>;
}
