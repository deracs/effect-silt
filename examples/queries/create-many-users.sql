INSERT INTO users (name, email, password)
VALUES :users[]
RETURNING id, name, email;
