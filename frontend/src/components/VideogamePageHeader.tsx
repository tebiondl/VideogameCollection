import type { ReactNode } from 'react';
import './VideogamePageHeader.css';

interface VideogamePageHeaderProps {
  eyebrow: string;
  icon: ReactNode;
  title: string;
  description: string;
  actions?: ReactNode;
  compact?: boolean;
}

export function VideogamePageHeader({ eyebrow, icon, title, description, actions, compact = false }: VideogamePageHeaderProps) {
  return <header className={`vg-page-hero${compact ? ' compact' : ''}`}>
    <div className="vg-page-hero-copy">
      <p className="vg-page-eyebrow">{icon}<span>{eyebrow}</span></p>
      <h1>{title}</h1>
      <p className="vg-page-description">{description}</p>
    </div>
    {actions && <div className="vg-page-actions">{actions}</div>}
  </header>;
}
