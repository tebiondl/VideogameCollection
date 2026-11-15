/**
 * Only games that were taken to the end have a completion date that means anything.
 * The stored value is kept untouched for every status (so switching back to Finished
 * restores it), but it is hidden and ignored while the game is not complete.
 * Stopped games carry their own date instead: the day they were last stopped.
 */
export const COMPLETED_STATUSES = new Set(['Finished', 'Viewed']);
export const STOPPED_STATUS = 'Stopped';

export function isCompletedStatus(status?: string | null): boolean {
  return !!status && COMPLETED_STATUSES.has(status);
}

/** The completion date to show or count, or null when the game is not complete. */
export function effectiveCompletionDate(game: { status?: string | null; completion_date?: string | null }): string | null {
  return isCompletedStatus(game.status) ? game.completion_date || null : null;
}

/** The day the game was last stopped, or null when it is not stopped right now. */
export function effectiveStoppedDate(game: { status?: string | null; stopped_date?: string | null }): string | null {
  return game.status === STOPPED_STATUS ? game.stopped_date || null : null;
}

function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Changes a game's status in an editor, logging today as the stop date when it becomes Stopped. */
export function withStatus<T extends { status?: string | null; stopped_date?: string | null }>(game: T, status: string, now = new Date()): T {
  if (status === STOPPED_STATUS && game.status !== STOPPED_STATUS) return { ...game, status, stopped_date: localToday(now) };
  return { ...game, status };
}
