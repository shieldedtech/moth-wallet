// Display helpers — style mirrors midnight-wallet-cli (Apache-2.0). See NOTICE.

/** Days/hours/minutes remaining until targetDate, or 'Complete' if past. */
export function formatTimeRemaining(targetDate: Date, now: Date = new Date()): string {
  const diffMs = targetDate.getTime() - now.getTime();
  if (diffMs <= 0) return 'Complete';

  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
