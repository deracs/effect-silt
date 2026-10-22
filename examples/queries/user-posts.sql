SELECT u.id, u.name, p.title
FROM users u
LEFT JOIN posts p ON p.user_id = u.id
WHERE u.id = :id;
