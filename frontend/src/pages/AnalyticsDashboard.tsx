import { useState, useEffect, useMemo } from 'react';
import { fetchWithAuth } from '../lib/api';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, Target, Clock, Trophy, Gamepad2 } from 'lucide-react';
import {
  PieChart, Pie, Cell, Tooltip as RechartsTooltip, Legend, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid
} from 'recharts';

export function AnalyticsDashboard() {
  const [games, setGames] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadGames = async () => {
      try {
        const res = await fetchWithAuth('/videogames/');
        if (res.ok) setGames(await res.json());
      } catch (e) {
        console.error(e);
      } finally {
        setIsLoading(false);
      }
    };
    loadGames();
  }, []);

  const stats = useMemo(() => {
    let totalGames = games.length;
    let totalPlaytime = 0;
    let totalScore = 0;
    let scoredGamesCount = 0;
    let beatenThisYear = 0;
    const currentYear = new Date().getFullYear();

    const statusCounts: Record<string, number> = {
      'Not Started': 0, 'Playing': 0, 'Finished': 0, 'Stopped': 0, 'Infinite': 0
    };
    const ratingCounts: Record<number, number> = {
      1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0, 9:0, 10:0
    };

    games.forEach(g => {
      if (g.playtime_hours) totalPlaytime += g.playtime_hours;
      
      if (g.mark) {
        totalScore += g.mark;
        scoredGamesCount++;
        if (g.mark >= 1 && g.mark <= 10) ratingCounts[g.mark]++;
      }
      
      if (g.status) {
        if (statusCounts[g.status] !== undefined) statusCounts[g.status]++;
      }

      if (g.status === 'Finished') {
        if (g.completion_date && g.completion_date.startsWith(currentYear.toString())) {
          beatenThisYear++;
        }
      }
    });

    const statusData = Object.keys(statusCounts).map(k => ({ name: k, value: statusCounts[k] })).filter(d => d.value > 0);
    const ratingData = Object.keys(ratingCounts).map(k => ({ rating: k, count: ratingCounts[Number(k)] }));
    const avgScore = scoredGamesCount > 0 ? (totalScore / scoredGamesCount).toFixed(1) : 'N/A';

    return { totalGames, totalPlaytime, avgScore, beatenThisYear, statusData, ratingData };
  }, [games]);

  const COLORS = ['#8884d8', '#82ca9d', '#ffc658', '#ff7300', '#d0ed57'];

  return (
    <div className="container dashboard-hub">
      <div style={{ marginBottom: '1.5rem' }}>
        <Link to="/dashboard/videogames" className="btn btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem' }}>
          <ArrowLeft size={18} />
          Back to Tracker
        </Link>
      </div>

      <header className="hub-header" style={{ marginBottom: '2rem' }}>
        <h1 className="text-gradient">Analytics Dashboard</h1>
        <p className="text-secondary">Visualize your tracking data</p>
      </header>

      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
          <Loader2 className="spinner" size={32} />
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.5rem', marginBottom: '3rem' }}>
            <div className="glass-card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ padding: '1rem', background: 'rgba(136, 132, 216, 0.2)', borderRadius: 'var(--radius-md)', color: '#8884d8' }}><Gamepad2 size={24}/></div>
              <div><p className="text-muted" style={{ fontSize: '0.9rem', marginBottom: '0.2rem' }}>Total Games</p><h2 style={{ margin: 0 }}>{stats.totalGames}</h2></div>
            </div>
            <div className="glass-card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ padding: '1rem', background: 'rgba(130, 202, 157, 0.2)', borderRadius: 'var(--radius-md)', color: '#82ca9d' }}><Clock size={24}/></div>
              <div><p className="text-muted" style={{ fontSize: '0.9rem', marginBottom: '0.2rem' }}>Total Playtime</p><h2 style={{ margin: 0 }}>{stats.totalPlaytime.toFixed(1)} hrs</h2></div>
            </div>
            <div className="glass-card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ padding: '1rem', background: 'rgba(255, 198, 88, 0.2)', borderRadius: 'var(--radius-md)', color: '#ffc658' }}><Trophy size={24}/></div>
              <div><p className="text-muted" style={{ fontSize: '0.9rem', marginBottom: '0.2rem' }}>Average Rating</p><h2 style={{ margin: 0 }}>{stats.avgScore}</h2></div>
            </div>
            <div className="glass-card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ padding: '1rem', background: 'rgba(255, 115, 0, 0.2)', borderRadius: 'var(--radius-md)', color: '#ff7300' }}><Target size={24}/></div>
              <div><p className="text-muted" style={{ fontSize: '0.9rem', marginBottom: '0.2rem' }}>Beaten This Year</p><h2 style={{ margin: 0 }}>{stats.beatenThisYear}</h2></div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '1.5rem' }}>
            <div className="glass-card" style={{ padding: '1.5rem' }}>
              <h3 style={{ marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>Status Breakdown</h3>
              <div style={{ width: '100%', height: 300 }}>
                {stats.statusData.length > 0 ? (
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={stats.statusData} cx="50%" cy="50%" labelLine={false} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} outerRadius={100} fill="#8884d8" dataKey="value">
                        {stats.statusData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <RechartsTooltip contentStyle={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: '8px' }} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                ) : <p className="text-muted">Not enough data to display.</p>}
              </div>
            </div>

            <div className="glass-card" style={{ padding: '1.5rem' }}>
              <h3 style={{ marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>Rating Distribution</h3>
              <div style={{ width: '100%', height: 300 }}>
                <ResponsiveContainer>
                  <BarChart data={stats.ratingData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                    <XAxis dataKey="rating" stroke="var(--text-muted)" />
                    <YAxis allowDecimals={false} stroke="var(--text-muted)" />
                    <RechartsTooltip cursor={{fill: 'rgba(255,255,255,0.05)'}} contentStyle={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: '8px' }} />
                    <Bar dataKey="count" fill="var(--accent-primary)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
