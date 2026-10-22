INSERT INTO users (name, email)
VALUES (:name, :email)
RETURNING id, name, email;
