UPDATE "apps"
SET "visibility" = 'private'
WHERE "visibility" = 'public'
  AND "manifest_json" IS NOT NULL
  AND jsonb_typeof("manifest_json"::jsonb) = 'object'
  AND jsonb_typeof("manifest_json"::jsonb -> 'capabilities') = 'array'
  AND ("manifest_json"::jsonb -> 'capabilities') ? 'llm';
