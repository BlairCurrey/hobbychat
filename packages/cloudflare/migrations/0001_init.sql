CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  app        TEXT NOT NULL,
  room       TEXT NOT NULL,
  uid        TEXT NOT NULL,
  name       TEXT NOT NULL,
  ip_hash    TEXT,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_room_time ON messages(app, room, created_at);
CREATE INDEX messages_time      ON messages(created_at);

CREATE TABLE bans (
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,
  reason     TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (kind, value)
);
