-- NONCANONICAL Task 8A catalog fixture. Never copy this file into migrations/.
-- The harmless table proves post-catalog rejection rolls modeled DDL back.
CREATE TABLE dasher.modeled_successor_inventory_probe (
  marker integer NOT NULL
);
SELECT 3::integer AS modeled_successor_inventory_version;
