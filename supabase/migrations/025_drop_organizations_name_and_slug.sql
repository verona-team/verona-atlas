-- Orgs are identified exclusively by their UUID id. The `name` and `slug`
-- columns were vestigial — never used for routing, foreign keys, or lookups,
-- and only surfaced on the settings page. Dropping them simplifies the
-- signup flow (email + password only) and removes the previously-unique
-- `slug` constraint that was blocking duplicate organization names.
ALTER TABLE public.organizations DROP COLUMN IF EXISTS slug;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS name;
