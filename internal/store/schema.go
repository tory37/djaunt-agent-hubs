package store

const schemaVersion = 1

const schemaV1 = `
CREATE TABLE hubs (
	id         TEXT PRIMARY KEY,
	title      TEXT NOT NULL,
	status     TEXT NOT NULL CHECK (status IN ('active', 'archived')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE blocks (
	hub_id   TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
	id       TEXT NOT NULL,
	type     TEXT NOT NULL,
	position INTEGER NOT NULL,
	props    TEXT NOT NULL,
	PRIMARY KEY (hub_id, id)
);

CREATE TABLE hub_state (
	hub_id   TEXT PRIMARY KEY REFERENCES hubs(id) ON DELETE CASCADE,
	document TEXT NOT NULL
);

CREATE TABLE events (
	seq        INTEGER PRIMARY KEY AUTOINCREMENT,
	hub_id     TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
	source     TEXT NOT NULL,
	type       TEXT NOT NULL,
	payload    TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX events_by_hub ON events (hub_id, seq);

CREATE TABLE services (
	hub_id     TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
	name       TEXT NOT NULL,
	command    TEXT NOT NULL,
	workdir    TEXT NOT NULL,
	env        TEXT NOT NULL,
	every_ms   INTEGER NOT NULL DEFAULT 0,
	cron       TEXT NOT NULL DEFAULT '',
	restart    TEXT NOT NULL CHECK (restart IN ('never', 'on-failure', 'always')),
	desired    TEXT NOT NULL CHECK (desired IN ('running', 'stopped')),
	created_at INTEGER NOT NULL,
	PRIMARY KEY (hub_id, name)
);
`
