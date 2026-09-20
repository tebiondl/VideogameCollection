import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Navbar } from './components/Navbar';
import { HomePage } from './pages/HomePage';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { AnalyticsDashboard } from './pages/AnalyticsDashboard';
import { VideogamesDashboard } from './pages/VideogamesDashboard';
import { AddGamePage } from './pages/AddGamePage';
import { AdminDashboard } from './pages/AdminDashboard';
import { UserSettings } from './pages/UserSettings';
import { BoardgamesDashboard } from './pages/BoardgamesDashboard';
import { AddBoardgamePage } from './pages/AddBoardgamePage';
import { BoardgameAnalyticsDashboard } from './pages/BoardgameAnalyticsDashboard';
import { AdminBoardgamesDashboard } from './pages/AdminBoardgamesDashboard';
import { CollectionNavigation, VideogameEntry } from './components/CollectionNavigation';
import { DiscoveryDashboard } from './pages/DiscoveryDashboard';
import { DiscoveryAnalytics } from './pages/DiscoveryAnalytics';
import { DiscoverySmartAdd } from './pages/DiscoverySmartAdd';
import { WantedGames } from './pages/WantedGames';
import { SteamTrash } from './pages/SteamTrash';

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
