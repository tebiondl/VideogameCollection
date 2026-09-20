import { useEffect } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Compass, Heart, Library, Sparkles, BarChart3, Settings2, Shield, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './CollectionNavigation.css';

function savedVideogameTab(userId: number) {
  try { const value = localStorage.getItem(`videogame-tab:${userId}`); return value === 'discovery' || value === 'wanted' ? value : 'collection'; }
  catch { return 'collection'; }
}

export function VideogameEntry() {
  const { user } = useAuth();
  return <Navigate to={`/dashboard/videogames/${savedVideogameTab(user!.id)}`} replace />;
}

export function CollectionNavigation() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const isVideogame = pathname.startsWith('/dashboard/videogames/') || pathname === '/dashboard/admin';
  const discovery = pathname.includes('/discovery');
  const wanted = pathname.includes('/wanted');
  const tab = discovery ? 'discovery' : wanted ? 'wanted' : 'collection';
  const context = pathname.endsWith('/analytics') ? 'analytics' : pathname.endsWith('/admin') ? 'admin' : pathname.endsWith('/settings') ? 'settings' : pathname.endsWith('/smart') ? 'smart' : '';
  const base = '/dashboard/videogames';
  const destination = (target: string) => target === 'discovery' ? `${base}/discovery`
    : target === 'wanted' ? `${base}/wanted${context ? `/${context}` : ''}`
    : context === 'admin' ? '/dashboard/admin' : context ? `${base}/${context}` : `${base}/collection`;
  useEffect(() => {
    if (isVideogame && user) {
      try { localStorage.setItem(`videogame-tab:${user.id}`, tab); } catch { /* private storage */ }
    }
  }, [isVideogame, tab, user]);
  if (!isVideogame || !user || context === 'admin' || context === 'settings') return null;
  const toolsBase = wanted ? `${base}/wanted` : base;
  return <div className="container collection-navigation">
    <nav className="collection-tabs" aria-label="Videogame sections">
      <Link className={tab === 'collection' ? 'selected' : ''} aria-current={tab === 'collection' ? 'page' : undefined} to={destination('collection')}><Library size={18} /> Collection</Link>
      <Link className={wanted ? 'selected' : ''} aria-current={wanted ? 'page' : undefined} to={destination('wanted')}><Heart size={18} /> Games I want</Link>
      <Link className={discovery ? 'selected' : ''} aria-current={discovery ? 'page' : undefined} to={destination('discovery')}><Compass size={18} /> Discovery</Link>
    </nav>
    {!discovery && <nav className="collection-tools" aria-label={`${tab} tools`}>
      <Link to={`${toolsBase}/smart`} aria-current={context === 'smart' ? 'page' : undefined}><Sparkles size={16} /> Smart Add</Link>
      {!wanted && <Link to={`${base}/trash`} aria-current={pathname.endsWith('/trash') ? 'page' : undefined}><Trash2 size={16} /> Trash</Link>}
      <Link to={`${toolsBase}/analytics`} aria-current={context === 'analytics' ? 'page' : undefined}><BarChart3 size={16} /> Analytics</Link>
      <Link to={`${base}/settings`}><Settings2 size={16} /> User Settings</Link>
      {user.is_admin && <Link to="/dashboard/admin"><Shield size={16} /> Admin</Link>}
    </nav>}
  </div>;
}
