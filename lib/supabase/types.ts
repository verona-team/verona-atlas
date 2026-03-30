export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string
          name: string
          slug: string
          plan: string
          created_by: string
          created_at: string
          updated_at: string
        }
        Insert: {
          name: string
          slug: string
          plan: string
          created_by: string
        }
        Update: Partial<Database['public']['Tables']['organizations']['Row']>
      }
      org_members: {
        Row: {
          id: string
          org_id: string
          user_id: string
          role: 'owner' | 'member'
          created_at: string
        }
        Insert: {
          org_id: string
          user_id: string
          role: 'owner' | 'member'
        }
        Update: Partial<Database['public']['Tables']['org_members']['Row']>
      }
      projects: {
        Row: {
          id: string
          org_id: string
          name: string
          app_url: string
          auth_email: string | null
          auth_password_encrypted: string | null
          agentmail_inbox_id: string | null
          agentmail_inbox_address: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          org_id: string
          name: string
          app_url: string
          auth_email?: string | null
          auth_password_encrypted?: string | null
          agentmail_inbox_id?: string | null
          agentmail_inbox_address?: string | null
        }
        Update: Partial<Database['public']['Tables']['projects']['Row']>
      }
      integrations: {
        Row: {
          id: string
          project_id: string
          type: 'github' | 'posthog' | 'slack'
          config: Record<string, unknown>
          status: 'active' | 'disconnected'
          created_at: string
          updated_at: string
        }
        Insert: {
          project_id: string
          type: 'github' | 'posthog' | 'slack'
          config: Record<string, unknown>
          status: 'active' | 'disconnected'
        }
        Update: Partial<Database['public']['Tables']['integrations']['Row']>
      }
      test_templates: {
        Row: {
          id: string
          project_id: string
          name: string
          description: string | null
          steps: Record<string, unknown>[]
          source: 'manual' | 'ai_generated'
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          project_id: string
          name: string
          description?: string | null
          steps: Record<string, unknown>[]
          source: 'manual' | 'ai_generated'
          is_active: boolean
        }
        Update: Partial<Database['public']['Tables']['test_templates']['Row']>
      }
      test_runs: {
        Row: {
          id: string
          project_id: string
          trigger: 'manual'
          trigger_ref: string | null
          status:
            | 'pending'
            | 'planning'
            | 'running'
            | 'completed'
            | 'failed'
          modal_call_id: string | null
          started_at: string | null
          completed_at: string | null
          summary: Record<string, unknown> | null
          created_at: string
        }
        Insert: {
          project_id: string
          trigger: 'manual'
          trigger_ref?: string | null
          status:
            | 'pending'
            | 'planning'
            | 'running'
            | 'completed'
            | 'failed'
          modal_call_id?: string | null
          started_at?: string | null
          completed_at?: string | null
          summary?: Record<string, unknown> | null
        }
        Update: Partial<Database['public']['Tables']['test_runs']['Row']>
      }
      test_results: {
        Row: {
          id: string
          test_run_id: string
          test_template_id: string | null
          status: 'passed' | 'failed' | 'error' | 'skipped'
          duration_ms: number | null
          error_message: string | null
          screenshots: string[]
          console_logs: Record<string, unknown> | null
          network_errors: Record<string, unknown> | null
          ai_analysis: string | null
          created_at: string
        }
        Insert: {
          test_run_id: string
          test_template_id?: string | null
          status: 'passed' | 'failed' | 'error' | 'skipped'
          duration_ms?: number | null
          error_message?: string | null
          screenshots: string[]
          console_logs?: Record<string, unknown> | null
          network_errors?: Record<string, unknown> | null
          ai_analysis?: string | null
        }
        Update: Partial<Database['public']['Tables']['test_results']['Row']>
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
  }
}

export type Organization =
  Database['public']['Tables']['organizations']['Row']
export type OrgMember = Database['public']['Tables']['org_members']['Row']
export type Project = Database['public']['Tables']['projects']['Row']
export type Integration = Database['public']['Tables']['integrations']['Row']
export type TestTemplate = Database['public']['Tables']['test_templates']['Row']
export type TestRun = Database['public']['Tables']['test_runs']['Row']
export type TestResult = Database['public']['Tables']['test_results']['Row']
