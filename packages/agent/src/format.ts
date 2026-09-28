/**
 * Number formatting that records what it prints. Every number a tool writes into its summary goes
 * through a FactBook, so the summary can never assert a number that is missing from `facts`
 * (grounding.ts checks answers against exactly these facts).
 */

/** A number a tool asserts: the value as displayed and its unit ('' = dimensionless). */
export interface Fact {
  label: string;
  value: number;
  unit: string;
}

/** Fixed decimals with thousands separators for 4+ digit integer parts ("1,053", "1.857"). */
export function fmtNumber(value: number, digits = 0, trim = false): string {
  let fixed = Math.abs(value).toFixed(digits);
  if (trim && fixed.includes('.')) fixed = fixed.replace(/\.?0+$/, '');
  const [int = '0', frac] = fixed.split('.');
  const grouped = int.length > 3 ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : int;
  const sign = value < 0 && Number(fixed) !== 0 ? '-' : '';
  return sign + grouped + (frac ? `.${frac}` : '');
}

/** "2 个", "1,053 m", "80%": a space before every unit except % and the empty unit. */
export function withUnit(num: string, unit: string): string {
  if (!unit) return num;
  if (unit === '%' || unit === '°') return num + unit;
  return `${num} ${unit}`;
}

export interface FactOptions {
  /** Decimals shown (default 0). */
  digits?: number;
  /** Drop trailing zeros ("309.6" stays, "900.0" → "900"). */
  trim?: boolean;
}

export class FactBook {
  readonly facts: Fact[] = [];

  /** Records the fact and returns the number with its unit, e.g. "1.88 倍". */
  add(label: string, value: number, unit = '', opts: FactOptions = {}): string {
    return withUnit(this.num(label, value, unit, opts), unit);
  }

  /** Records the fact and returns the number alone, e.g. "1,053". */
  num(label: string, value: number, unit = '', opts: FactOptions = {}): string {
    const text = fmtNumber(value, opts.digits ?? 0, opts.trim ?? false);
    const shown = Number(text.replace(/,/g, ''));
    if (!this.facts.some((f) => f.label === label && f.value === shown && f.unit === unit)) {
      this.facts.push({ label, value: shown, unit });
    }
    return text;
  }

  /** Records a date (YYYY-MM-DD) as a fact whose label carries it; returns the date. */
  date(label: string, iso: string): string {
    const entry = { label: `${label}：${iso}`, value: Number(iso.replace(/-/g, '')), unit: 'date' };
    if (!this.facts.some((f) => f.label === entry.label)) this.facts.push(entry);
    return iso;
  }

  /** Adds facts of another book (e.g. a nested summary). */
  merge(other: FactBook | readonly Fact[]): void {
    const list = other instanceof FactBook ? other.facts : other;
    for (const f of list) {
      if (!this.facts.some((g) => g.label === f.label && g.value === f.value && g.unit === f.unit))
        this.facts.push(f);
    }
  }
}

/** Rounds to `digits` decimals (half away from zero on the decimal string, like toFixed). */
export function round(value: number, digits = 0): number {
  return Number(value.toFixed(digits));
}

/** Beijing calendar date (YYYY-MM-DD) of an ISO timestamp: the day Baidu's quotas and the data belong to. */
export function beijingDate(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return /^\d{4}-\d{2}-\d{2}/.exec(iso)?.[0] ?? null;
  return new Date(t + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** Chinese list: "A、B 和 C". */
export function joinZh(items: readonly string[], last = '和'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join('、')}${last}${items[items.length - 1]}`;
}
