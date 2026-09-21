import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import './BackToTopButton.css';

const ENABLED_ROUTES = new Set([
  '/dashboard/videogames/collection',
  '/dashboard/videogames/settings',
  '/dashboard/admin',
  '/dashboard/boardgames',
  '/dashboard/boardgames/admin',
]);

export function BackToTopButton() {
  const { pathname } = useLocation();
  const [pastThreshold, setPastThreshold] = useState(() => window.scrollY > 320);
  const enabled = ENABLED_ROUTES.has(pathname);
  const visible = enabled && pastThreshold;

  useEffect(() => {
    if (!enabled) return;
    const updateVisibility = () => setPastThreshold(window.scrollY > 320);
    const animationFrame = window.requestAnimationFrame(updateVisibility);
    window.addEventListener('scroll', updateVisibility, { passive: true });
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('scroll', updateVisibility);
    };
  }, [enabled, pathname]);

  if (!enabled) return null;

  return (
    <button
      type="button"
      className={`back-to-top${visible ? ' visible' : ''}`}
      aria-label="Back to top"
      title="Back to top"
      tabIndex={visible ? 0 : -1}
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
    >
      <ArrowUp aria-hidden="true" size={22} strokeWidth={2.4} />
    </button>
  );
}
