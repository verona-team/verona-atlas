-- Add new integration types for Sentry, LangSmith, and Braintrust
ALTER TYPE integration_type ADD VALUE IF NOT EXISTS 'sentry';
ALTER TYPE integration_type ADD VALUE IF NOT EXISTS 'langsmith';
ALTER TYPE integration_type ADD VALUE IF NOT EXISTS 'braintrust';
