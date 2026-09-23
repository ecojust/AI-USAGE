export type QuotaWindow = {
  remainingPercent: number;
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type QuotaBucket = {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  primary: QuotaWindow | null;
  secondary: QuotaWindow | null;
};

export type AccountQuotaSnapshot = {
  buckets: QuotaBucket[];
  updatedAt: number;
};

export const LOW_QUOTA_WARNING_PERCENT = 15;

export function formatWindowLabel(minutes: number | null) {
  if (minutes == null) return "额度周期";
  if (minutes === 10080) return "每周额度";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天额度`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时额度`;
  return `${minutes} 分钟额度`;
}

export function getRemainingPercent(window: QuotaWindow) {
  return Number.isFinite(window.remainingPercent) ? window.remainingPercent : null;
}

export function formatPercent(value: number | null) {
  return value == null ? "—" : `${Number(value.toFixed(1))}%`;
}

function isWindowActive(window: QuotaWindow, now: number) {
  return window.usedPercent != null && Number.isFinite(window.usedPercent)
    && (window.resetsAt == null || window.resetsAt * 1000 > now);
}

// Normally show the shortest live window. If a window is at 15% or less,
// surface the most depleted such window because it now constrains usage.
export function findBindingQuotaWindow(
  snapshot: AccountQuotaSnapshot | null,
  now = Date.now(),
): QuotaWindow | null {
  const activeWindows = (snapshot?.buckets ?? [])
    .flatMap((bucket) => [bucket.primary, bucket.secondary])
    .filter(
      (window): window is QuotaWindow =>
        window !== null && isWindowActive(window, now),
    )
    .sort(
      (first, second) =>
        (first.windowDurationMins ?? Number.MAX_SAFE_INTEGER) -
        (second.windowDurationMins ?? Number.MAX_SAFE_INTEGER),
    );

  if (activeWindows.length === 0) return null;

  const warningWindows = activeWindows.filter(
    (window) =>
      (getRemainingPercent(window) ?? 100) <= LOW_QUOTA_WARNING_PERCENT,
  );
  if (warningWindows.length === 0) return activeWindows[0];

  return warningWindows.reduce((mostDepleted, window) =>
    (getRemainingPercent(window) ?? 100) <
    (getRemainingPercent(mostDepleted) ?? 100)
      ? window
      : mostDepleted,
  );
}

export function formatResetTime(timestamp: number | null) {
  if (timestamp == null) return "重置时间暂不可用";
  return `重置于 ${new Date(timestamp * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}
