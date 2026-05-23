// Shared cross-component constants. Lifted out of individual components so
// future infinite-scroll-back, dashboard activity sliding window, etc., can
// share the same numbers.

// Maximum messages kept in the in-memory message stream window. The store can
// hold unbounded messages, but `MessageStream` only renders the trailing N to
// keep DOM cost bounded. Memory tradeoff: each message is small (<1KB) so 300
// is comfortable on every device.
export const MESSAGE_WINDOW_SIZE = 300;

// Of the trailing window, how many items we actually render in the DOM at a
// time. The rest are accessible via "load older". See `MessageStream`.
export const MESSAGE_RENDER_BUDGET = 80;

// Sliding window for the dashboard "messages last hour" tile + sparkline.
export const DASHBOARD_MESSAGE_WINDOW_MS = 60 * 60 * 1000;

// How often to re-poll metrics on the dashboard. SSE doesn't carry per-day
// aggregates, so we still need REST for the charts — but per-event polling
// would be wasteful, so we tick on a fixed interval.
export const DASHBOARD_METRICS_INTERVAL_MS = 30_000;

// Rolling window the dashboard considers a session "active" if no live agents
// are present. Mirrors the original DashboardPage value.
export const DASHBOARD_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Default API port; mirrored in vite.config.ts (proxy target) and Sidebar
// footer. Override via `VITE_API_PORT` at build/dev time.
export const DEFAULT_API_PORT = 48742;
