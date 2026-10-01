import { fetchWithAuth } from './api';

export async function saveCollectionGame(payload: object): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithAuth('/videogames/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error('Could not reach the server. Your game has not been saved. Please try again.');
  }
  if (response.ok) return;
  const problem: { detail?: unknown } | null = await response.json().catch(() => null);
  if (typeof problem?.detail === 'string' && problem.detail.trim()) {
    throw new Error(problem.detail);
  }
  if (Array.isArray(problem?.detail)) {
    const messages = problem.detail.flatMap((issue: { loc?: unknown[]; msg?: unknown }) => {
      if (!issue || typeof issue.msg !== 'string') return [];
      const field = Array.isArray(issue.loc) ? issue.loc.filter(part => part !== 'body').join('.') : '';
      return [`${field ? `${field}: ` : ''}${issue.msg}`];
    });
    if (messages.length) throw new Error(messages.join('; '));
  }
  throw new Error(`Could not save the game (HTTP ${response.status}). Please try again.`);
}
