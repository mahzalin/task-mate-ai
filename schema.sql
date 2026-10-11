CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tehran',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('pending', 'confirmed', 'done', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reminded_at TEXT,
  FOREIGN KEY (telegram_id)
    REFERENCES users(telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_due_status
ON tasks(status, due_at);

CREATE INDEX IF NOT EXISTS idx_tasks_user
ON tasks(telegram_id);
