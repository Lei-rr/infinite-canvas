const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

function write(level, scope, message, extra) {
  if (LEVELS[level] < threshold) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}`;
  const payload = extra === undefined ? line : `${line} ${safeJson(extra)}`;
  if (level === "error" || level === "warn") console.error(payload);
  else console.log(payload);
}

function safeJson(value) {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(scope) {
  return {
    debug: (message, extra) => write("debug", scope, message, extra),
    info: (message, extra) => write("info", scope, message, extra),
    warn: (message, extra) => write("warn", scope, message, extra),
    error: (message, extra) => write("error", scope, message, extra),
  };
}
