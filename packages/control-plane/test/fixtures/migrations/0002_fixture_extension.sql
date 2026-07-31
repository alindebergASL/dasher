CREATE TABLE dasher.fixture_extension (
  fixture_id integer PRIMARY KEY REFERENCES dasher.fixture_base (fixture_id),
  enabled boolean NOT NULL DEFAULT false
);
