CREATE SCHEMA dasher;

CREATE TABLE dasher.fixture_base (
  fixture_id integer PRIMARY KEY,
  fixture_value text NOT NULL,
  drift_marker boolean NOT NULL DEFAULT false
);
