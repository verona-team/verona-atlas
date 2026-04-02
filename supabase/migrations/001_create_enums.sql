-- Atlas QA Platform - Enum Types
CREATE TYPE org_role AS ENUM ('owner', 'member');
CREATE TYPE integration_type AS ENUM ('github', 'posthog', 'slack', 'sentry', 'langsmith', 'braintrust');
CREATE TYPE integration_status AS ENUM ('active', 'disconnected');
CREATE TYPE template_source AS ENUM ('manual', 'ai_generated');
CREATE TYPE run_trigger AS ENUM ('manual');
CREATE TYPE run_status AS ENUM ('pending', 'planning', 'running', 'completed', 'failed');
CREATE TYPE result_status AS ENUM ('passed', 'failed', 'error', 'skipped');
