-- These parameter-like strings must remain unchanged: ? :ignored[]
INSERT INTO users (name, password, email, active, external_id)
VALUES :users[]
RETURNING id, name, email, active, external_id,
  CAST(:label AS TEXT) AS label, '? :ignored[]' AS marker;
