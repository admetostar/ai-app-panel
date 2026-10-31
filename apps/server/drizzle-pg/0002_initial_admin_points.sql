UPDATE "users"
SET "points_balance" = 99999999
WHERE "id" = (
  SELECT "id"
  FROM "users"
  WHERE "role" = 'admin'
  ORDER BY "id"
  LIMIT 1
)
AND "points_balance" = 0;
