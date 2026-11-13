import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Gamepad2, UserCircle, LogOut, ChevronDown, Dices, Settings2, Shield, LayoutGrid } from 'lucide-react';
import './Navbar.css';

export function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [menuOpen]);

  const handleLogout = () => {
    logout();
    navigate('/');
    setMenuOpen(false);
  };
  const inVideogames = location.pathname.includes('videogames') || location.pathname === '/dashboard/admin';
  const inBoardgames = location.pathname.includes('boardgames');

  return (
    <nav className="navbar">
      <div className="container nav-container">
        <Link to={user ? "/dashboard" : "/"} className="nav-logo" title={user ? 'Back to the hub' : undefined}>
          <span className="logo-mark"><Gamepad2 className="logo-icon" /></span>
          <span className="logo-text">Epic <span className="text-gradient">Tracker</span></span>
        </Link>

        {user && <div className="nav-collections">
          <div className="nav-collection">
            <Link to="/dashboard/videogames" aria-current={inVideogames ? 'page' : undefined}><Gamepad2 size={17} /> Videogames <ChevronDown size={14} /></Link>
            <div className="nav-collection-menu"><Link to="/dashboard/videogames/collection">Collection</Link><Link to="/dashboard/videogames/wanted">Games I want</Link><Link to="/dashboard/videogames/discovery">Discovery</Link><hr /><Link to="/dashboard/videogames/analytics">Statistics</Link><Link to="/dashboard/videogames/ranking">Ranking</Link></div>
          </div>
          <div className="nav-collection">
            <Link to="/dashboard/boardgames" aria-current={inBoardgames ? 'page' : undefined}><Dices size={17} /> Board games <ChevronDown size={14} /></Link>
            <div className="nav-collection-menu"><Link to="/dashboard/boardgames?tab=owned">Collection</Link><Link to="/dashboard/boardgames?tab=wishlist">Want to buy</Link><Link to="/dashboard/boardgames?tab=matches">Matches</Link><hr /><Link to="/dashboard/boardgames/analytics">Statistics</Link></div>
          </div>
        </div>}
        <div className="nav-actions">
          {!user ? (
            location.pathname === '/login' ? (
              <Link to="/" className="btn btn-secondary">
                Go Back
              </Link>
            ) : (
              <Link to="/login" className="btn btn-primary">
                Login
              </Link>
            )
          ) : (
            <div className="user-menu-wrapper" ref={menu}>
              <button
                className="user-menu-btn"
                onClick={() => setMenuOpen(!menuOpen)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                {user.avatar_url ? (
                  <img src={user.avatar_url} alt="" className="avatar-img" />
                ) : (
                  <UserCircle className="avatar-icon" />
                )}
                <span className="username">{user.username}</span>
                <ChevronDown size={14} className="user-menu-caret" />
              </button>

              {menuOpen && (
                <div className="dropdown-menu" role="menu" onClick={() => setMenuOpen(false)}>
                  <div className="dropdown-header">
                    <p className="dropdown-name">{user.username}</p>
                    <p className="dropdown-id">{user.is_admin ? 'Administrator' : 'Member'} · User #{user.id}</p>
                  </div>
                  <div className="dropdown-divider"></div>
                  <Link className="dropdown-item" role="menuitem" to="/dashboard"><LayoutGrid size={16} /> Hub</Link>
                  <Link className="dropdown-item" role="menuitem" to="/dashboard/videogames/settings"><Settings2 size={16} /> Settings</Link>
                  {user.is_admin && <Link className="dropdown-item" role="menuitem" to="/dashboard/admin"><Shield size={16} /> Videogame admin</Link>}
                  {user.is_admin && <Link className="dropdown-item" role="menuitem" to="/dashboard/boardgames/admin"><Shield size={16} /> Board game admin</Link>}
                  <div className="dropdown-divider"></div>
                  <button className="dropdown-item danger" role="menuitem" onClick={handleLogout}>
                    <LogOut size={16} />
                    Log out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
