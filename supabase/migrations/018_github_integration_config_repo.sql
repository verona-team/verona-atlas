-- Migrate GitHub integration config: `repos` array -> single `config.repo` object.
-- Removes `repos` key; rows with empty array get `repo: null`.

UPDATE public.integrations
SET config =
  CASE
    WHEN NOT (config ? 'repos') THEN config
    WHEN jsonb_typeof(config->'repos') = 'array' AND jsonb_array_length(config->'repos') > 0 THEN
      (config - 'repos') || jsonb_build_object('repo', config->'repos'->0)
    ELSE
      (config - 'repos') || '{"repo": null}'::jsonb
  END
WHERE type = 'github'
  AND (config ? 'repos');
