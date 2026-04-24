import { useState, useEffect } from 'react';

type Granularity = 'year' | 'month' | 'day';

interface Props {
  value: string; // stored as "YYYY" | "YYYY-MM" | "YYYY-MM-DD"
  onChange: (val: string) => void;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function parseValue(val: string): { granularity: Granularity; year: number; month: number; day: number } {
  const now = new Date().getFullYear();
  if (!val) return { granularity: 'year', year: now, month: 1, day: 1 };
  const parts = val.split('-');
  if (parts.length === 3) return { granularity: 'day', year: Number(parts[0]), month: Number(parts[1]), day: Number(parts[2]) };
  if (parts.length === 2) return { granularity: 'month', year: Number(parts[0]), month: Number(parts[1]), day: 1 };
  return { granularity: 'year', year: Number(parts[0]) || now, month: 1, day: 1 };
}

export function CompletionDatePicker({ value, onChange }: Props) {
  const parsed = parseValue(value);
  const [granularity, setGranularity] = useState<Granularity>(parsed.granularity);
  const [year, setYear] = useState<number>(parsed.year);
  const [month, setMonth] = useState<number>(parsed.month); // 1-12
  const [day, setDay] = useState<number>(parsed.day);

  // Sync outward whenever pieces change
  useEffect(() => {
    if (!year) return;
    if (granularity === 'year') {
      onChange(String(year));
    } else if (granularity === 'month') {
      onChange(`${year}-${String(month).padStart(2, '0')}`);
    } else {
      onChange(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }, [granularity, year, month, day]);

  // Clamp day when month/year changes
  useEffect(() => {
    if (granularity === 'day' && year && month) {
      const maxDay = daysInMonth(year, month);
      if (day > maxDay) setDay(maxDay);
    }
  }, [month, year, granularity]);

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: currentYear - 1970 + 2 }, (_, i) => currentYear + 1 - i); // newest first
  const maxDay = year && month ? daysInMonth(year, month) : 31;

  const selectStyle: React.CSSProperties = { flex: 1, minWidth: 0 };

  return (
    <div className="completion-date-picker">
      {/* Granularity toggle */}
      <div className="cdp-granularity-bar">
        {(['year', 'month', 'day'] as Granularity[]).map(g => (
          <button
            key={g}
            type="button"
            className={`cdp-gran-btn ${granularity === g ? 'active' : ''}`}
            onClick={() => setGranularity(g)}
          >
            {g === 'year' ? 'Year' : g === 'month' ? 'Month + Year' : 'Full Date'}
          </button>
        ))}
      </div>

      {/* Pickers */}
      <div className="cdp-inputs">
        {granularity === 'day' && (
          <select
            className="form-input"
            style={selectStyle}
            value={day}
            onChange={e => setDay(Number(e.target.value))}
          >
            {Array.from({ length: maxDay }, (_, i) => i + 1).map(d => (
              <option key={d} value={d}>{String(d).padStart(2, '0')}</option>
            ))}
          </select>
        )}
        {(granularity === 'month' || granularity === 'day') && (
          <select
            className="form-input"
            style={selectStyle}
            value={month}
            onChange={e => setMonth(Number(e.target.value))}
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
          </select>
        )}
        <select
          className="form-input"
          style={selectStyle}
          value={year}
          onChange={e => setYear(Number(e.target.value))}
        >
          {years.map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
