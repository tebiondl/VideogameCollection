import { Link } from 'react-router-dom';
import { Gamepad2, Tv, Library, BookOpen } from 'lucide-react';
import './HomePage.css';

export function HomePage() {
  return (
    <div className="home-container">
      <section className="hero-section text-center">
        <div className="container">
          <h1 className="hero-title">
            Your Ultimate Media <span className="text-gradient">Tracker</span>
          </h1>
          <p className="hero-subtitle">
            Keep track of the games you play, the anime you watch, and the manga you read. All in one beautifully designed space.
          </p>
          <div className="hero-actions">
            <Link to="/login" className="btn btn-primary btn-lg">
              Get Started Now
            </Link>
          </div>
        </div>
      </section>

      <section className="features-section container">
        <h2 className="text-center section-title">Currently Supporting</h2>
        <div className="features-grid">
          
          <div className="glass-card feature-card">
            <div className="feature-icon-wrapper pg-games">
              <Gamepad2 size={32} />
            </div>
            <h3>Video Games</h3>
            <p className="text-secondary">Log your backlog, rate your favorites, and track your in-game completion progress seamlessly.</p>
          </div>

          <div className="glass-card feature-card hidden-future">
            <div className="feature-icon-wrapper pg-anime">
              <Tv size={32} />
            </div>
            <h3>Anime (Coming Soon)</h3>
            <p className="text-secondary">Keep up with the latest seasons and log every episode so you never lose your spot.</p>
          </div>

          <div className="glass-card feature-card hidden-future">
            <div className="feature-icon-wrapper pg-boardgames">
              <Library size={32} />
            </div>
            <h3>Board Games (Coming Soon)</h3>
            <p className="text-secondary">Track your physical collection and log game nights with friends.</p>
          </div>

          <div className="glass-card feature-card hidden-future">
            <div className="feature-icon-wrapper pg-manga">
              <BookOpen size={32} />
            </div>
            <h3>Manga (Coming Soon)</h3>
            <p className="text-secondary">Track volumes collected and chapters read with precise visual progress tracking.</p>
          </div>

        </div>
      </section>
    </div>
  );
}
