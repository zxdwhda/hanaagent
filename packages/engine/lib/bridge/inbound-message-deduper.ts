const RETENTION_MS = 30 * 60 * 1000;
const MAX_RECENT_IDS = 4096;

// Keep platform delivery IDs per adapter. A new ID is a new message even when
// the sender forwards the same attachment or repeats the same text.
export function createInboundMessageDeduper() {
  const recent = new Map<string, number>();

  return (id: unknown) => {
    if (typeof id !== "string" || !id) return true;
    const now = Date.now();
    for (const [oldId, acceptedAt] of recent) {
      if (now - acceptedAt < RETENTION_MS) break;
      recent.delete(oldId);
    }
    if (recent.has(id)) return false;
    if (recent.size >= MAX_RECENT_IDS) {
      const oldest = recent.keys().next().value;
      if (oldest !== undefined) recent.delete(oldest);
    }
    recent.set(id, now);
    return true;
  };
}
