export function getUtcDateInputValue(date = new Date()): string {
  return new Date(date.getTime()).toISOString().slice(0, 10);
}

export function validateOptionalTargetDeadline(value: string, today = getUtcDateInputValue()): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Choose a valid target deadline.';

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return 'Choose a valid target deadline.';
  }
  if (value < today) return 'Target deadline cannot be in the past.';
  return undefined;
}

export function formatDateOnly(value: string | null | undefined, locale?: string): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function dateOnlyEndOfDay(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
}
