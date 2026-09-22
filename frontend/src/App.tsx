import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Navbar } from './components/Navbar';
import { CollectionNavigation, VideogameEntry } from './components/CollectionNavigation';
import { BackToTopButton } from './components/BackToTopButton';

const HomePage = lazy(() => import('./pages/HomePage').then(({ HomePage }) => ({ default: HomePage })));
const AuthPage = lazy(() => import('./pages/AuthPage').then(({ AuthPage }) => ({ default: AuthPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then(({ DashboardPage }) => ({ default: DashboardPage })));
const AnalyticsDashboard = lazy(() => import('./pages/AnalyticsDashboard').then(({ AnalyticsDashboard }) => ({ default: AnalyticsDashboard })));
const VideogamesDashboard = lazy(() => import('./pages/VideogamesDashboard').then(({ VideogamesDashboard }) => ({ default: VideogamesDashboard })));
const AddGamePage = lazy(() => import('./pages/AddGamePage').then(({ AddGamePage }) => ({ default: AddGamePage })));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard').then(({ AdminDashboard }) => ({ default: AdminDashboard })));
const UserSettings = lazy(() => import('./pages/UserSettings').then(({ UserSettings }) => ({ default: UserSettings })));
const BoardgamesDashboard = lazy(() => import('./pages/BoardgamesDashboard').then(({ BoardgamesDashboard }) => ({ default: BoardgamesDashboard })));
const AddBoardgamePage = lazy(() => import('./pages/AddBoardgamePage').then(({ AddBoardgamePage }) => ({ default: AddBoardgamePage })));
const BoardgameAnalyticsDashboard = lazy(() => import('./pages/BoardgameAnalyticsDashboard').then(({ BoardgameAnalyticsDashboard }) => ({ default: BoardgameAnalyticsDashboard })));
const AdminBoardgamesDashboard = lazy(() => import('./pages/AdminBoardgamesDashboard').then(({ AdminBoardgamesDashboard }) => ({ default: AdminBoardgamesDashboard })));
const DiscoveryDashboard = lazy(() => import('./pages/DiscoveryDashboard').then(({ DiscoveryDashboard }) => ({ default: DiscoveryDashboard })));
const DiscoveryAnalytics = lazy(() => import('./pages/DiscoveryAnalytics').then(({ DiscoveryAnalytics }) => ({ default: DiscoveryAnalytics })));
const DiscoverySmartAdd = lazy(() => import('./pages/DiscoverySmartAdd').then(({ DiscoverySmartAdd }) => ({ default: DiscoverySmartAdd })));
const WantedGames = lazy(() => import('./pages/WantedGames').then(({ WantedGames }) => ({ default: WantedGames })));
const SteamTrash = lazy(() => import('./pages/SteamTrash').then(({ SteamTrash }) => ({ default: SteamTrash })));

// Protected Route wrapper component
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, isLoading } = useAuth();
  
  if (isLoading) {
    return <div className="app-container" style={{ justifyContent: 'center', alignItems: 'center' }}>Loading...</div>;
  }
  
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  
  return <>{children}</>;
};

function AppRoutes() {
  const { user, isLoading } = useAuth();
  return (
    <div className="app-container">
      <Navbar />
      <main className="main-content">
        <CollectionNavigation />
        <Suspense fallback={<div className="page-loading">Loading...</div>}>
          <Routes>
          <Route path="/dashboard/videogames/collection" element={<ProtectedRoute><VideogamesDashboard /></ProtectedRoute>} />
          <Route path="/dashboard/videogames/trash" element={<ProtectedRoute><SteamTrash /></ProtectedRoute>} />
          <Route path="/dashboard/videogames/smart" element={<ProtectedRoute><AddGamePage key="smart" initialTab="smart" /></ProtectedRoute>} />
          <Route path="/dashboard/videogames/discovery" element={<ProtectedRoute><DiscoveryDashboard /></ProtectedRoute>} />
          <Route path="/dashboard/videogames/wanted" element={<ProtectedRoute><WantedGames /></ProtectedRoute>} />
          <Route path="/dashboard/videogames/wanted/admin" element={<Navigate to="/dashboard/videogames/settings#steam" replace />} />
          <Route path="/dashboard/videogames/wanted/analytics" element={<ProtectedRoute><DiscoveryAnalytics /></ProtectedRoute>} />
          <Route path="/dashboard/videogames/wanted/smart" element={<ProtectedRoute><DiscoverySmartAdd /></ProtectedRoute>} />
          <Route path="/dashboard/videogames/discovery/admin" element={<Navigate to="/dashboard/videogames/settings#steam" replace />} />
          <Route path="/dashboard/videogames/discovery/analytics" element={<Navigate to="/dashboard/videogames/wanted/analytics" replace />} />
          <Route path="/dashboard/videogames/discovery/smart" element={<Navigate to="/dashboard/videogames/wanted/smart" replace />} />
          <Route path="/" element={user && !isLoading ? <Navigate to="/dashboard" replace /> : <HomePage />} />
          <Route path="/login" element={user && !isLoading ? <Navigate to="/dashboard" replace /> : <AuthPage />} />
          <Route 
            path="/dashboard" 
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/dashboard/videogames" 
            element={
              <ProtectedRoute>
                <VideogameEntry />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/dashboard/videogames/add" 
            element={
              <ProtectedRoute>
                <AddGamePage key="manual" />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/dashboard/boardgames" 
            element={
              <ProtectedRoute>
                <BoardgamesDashboard />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/dashboard/boardgames/add" 
            element={
              <ProtectedRoute>
                <AddBoardgamePage />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/dashboard/boardgames/admin" 
            element={
              <ProtectedRoute>
                <AdminBoardgamesDashboard />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/dashboard/boardgames/analytics" 
            element={
              <ProtectedRoute>
                <BoardgameAnalyticsDashboard />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/dashboard/admin" 
            element={
              <ProtectedRoute>
                <AdminDashboard />
              </ProtectedRoute>
            } 
          />
          <Route
            path="/dashboard/videogames/settings"
            element={
              <ProtectedRoute>
                <UserSettings />
              </ProtectedRoute>
            }
          />
          <Route 
            path="/dashboard/videogames/analytics" 
            element={
              <ProtectedRoute>
                <AnalyticsDashboard />
              </ProtectedRoute>
            } 
          />
          </Routes>
        </Suspense>
        <BackToTopButton />
      </main>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
