export type DailyProgressItem = {
  id: string;
  label: string;
  target: number;
  current: number;
  unit: string;
};

export type DailyProgressPlan = {
  date: string;
  title: string;
  note: string;
  items: DailyProgressItem[];
};

export type DailyProgressUpdate = {
  id: string;
  current?: number;
  increment?: number;
  complete?: boolean;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export function localDateKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function normalizeDailyDate(value?: string, now = new Date()): string {
  const date = String(value ?? "").trim() || localDateKey(now);
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00`))) throw new Error("Daily progress date must use YYYY-MM-DD.");
  return date;
}

function boundedText(value: unknown, max: number, name: string, allowEmpty = false): string {
  const text = String(value ?? "").trim();
  if ((!allowEmpty && !text) || text.length > max) throw new Error(`${name} is empty or exceeds ${max} characters.`);
  return text;
}

function boundedNumber(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000) throw new Error(`${name} must be between 0 and 1,000,000.`);
  return Math.round(number * 1000) / 1000;
}

export function normalizeDailyPlan(input: { date?: string; title: string; note?: string; items: Array<Partial<DailyProgressItem> & { id: string; label: string; target: number }> }, now = new Date()): DailyProgressPlan {
  const date = normalizeDailyDate(input.date, now);
  const title = boundedText(input.title, 500, "daily plan title");
  const note = boundedText(input.note ?? "", 1600, "daily plan note", true);
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 30) throw new Error("Daily plan must contain 1-30 items.");
  const seen = new Set<string>();
  const items = input.items.map((item, index) => {
    const id = boundedText(item.id, 80, `item ${index + 1} id`);
    if (!ID_RE.test(id)) throw new Error(`Invalid daily plan item id '${id}'.`);
    if (seen.has(id)) throw new Error(`Duplicate daily plan item id '${id}'.`);
    seen.add(id);
    const target = boundedNumber(item.target, `item ${id} target`);
    if (target <= 0) throw new Error(`item ${id} target must be greater than zero.`);
    const current = boundedNumber(item.current ?? 0, `item ${id} current`);
    return { id, label: boundedText(item.label, 300, `item ${id} label`), target, current, unit: boundedText(item.unit ?? "mục", 50, `item ${id} unit`, true) || "mục" };
  });
  return { date, title, note, items };
}

export function applyDailyUpdates(plan: DailyProgressPlan, updates: DailyProgressUpdate[]): DailyProgressPlan {
  if (!Array.isArray(updates) || updates.length < 1 || updates.length > 30) throw new Error("Daily progress update must contain 1-30 items.");
  const updateMap = new Map(updates.map((u) => [u.id, u]));
  for (const id of updateMap.keys()) if (!plan.items.some((item) => item.id === id)) throw new Error(`Daily plan item '${id}' was not found.`);
  const items = plan.items.map((item) => {
    const update = updateMap.get(item.id);
    if (!update) return { ...item };
    let current = item.current;
    if (update.complete === true) current = item.target;
    else if (update.current != null) current = boundedNumber(update.current, `item ${item.id} current`);
    else if (update.increment != null) {
      const delta = Number(update.increment);
      if (!Number.isFinite(delta) || Math.abs(delta) > 1_000_000) throw new Error(`item ${item.id} increment is invalid.`);
      current = Math.max(0, Math.round((current + delta) * 1000) / 1000);
    }
    return { ...item, current };
  });
  return { ...plan, items };
}

export function summarizeDailyPlan(plan: DailyProgressPlan) {
  const totalTarget = plan.items.reduce((sum, item) => sum + item.target, 0);
  const credited = plan.items.reduce((sum, item) => sum + Math.min(item.current, item.target), 0);
  const completedItems = plan.items.filter((item) => item.current >= item.target).length;
  const percent = totalTarget > 0 ? Math.round((credited / totalTarget) * 100) : 0;
  const complete = completedItems === plan.items.length && plan.items.length > 0;
  const status = complete ? "complete" : credited <= 0 ? "not_started" : "in_progress";
  return { percent, complete, status, completedItems, totalItems: plan.items.length, remainingItems: plan.items.length - completedItems, totalTarget, credited };
}

export function dailyPlanFactKey(date: string): string {
  return `daily_plan.${normalizeDailyDate(date)}`;
}
