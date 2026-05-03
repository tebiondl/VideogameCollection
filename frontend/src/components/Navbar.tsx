import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Gamepad2, UserCircle, LogOut } from 'lucide-react';
import './Navbar.css';

export function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/');
    setMenuOpen(false);
  };

  return (
    <nav className="navbar">
      <div className="container nav-container">
        <Link to={user ? "/dashboard" : "/"} className="nav-logo">
          <Gamepad2 className="logo-icon" />
          <span className="logo-text">Epici <span className="text-gradient">Tracker</span></span>
        </Link>
        
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              {location.pathname !== '/dashboard' && location.pathname.startsWith('/dashboard') && (
                <Link to="/dashboard" className="btn btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.85rem' }}>
                  Back to Hub
                </Link>
              )}
              
              <div className="user-menu-wrapper">
                <button 
                  className="user-menu-btn" 
                  onClick={() => setMenuOpen(!menuOpen)}
                  aria-expanded={menuOpen}
                >
                  {user.avatar_url ? (
                    <img src={user.avatar_url} alt={user.username} className="avatar-img" />
                  ) : (
                    <UserCircle className="avatar-icon" />
                  )}
                  <span className="username">{user.username}</span>
                </button>
              
              {menuOpen && (
                <div className="dropdown-menu">
                  <div className="dropdown-header">
                    <p className="dropdown-name">{user.username}</p>
                    <p className="dropdown-id">User #{user.id}</p>
                  </div>
                  <div className="dropdown-divider"></div>
                  <button className="dropdown-item danger" onClick={handleLogout}>
                    <LogOut size={16} />
                    Log out
                  </button>
                </div>
              )}
              </div>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
