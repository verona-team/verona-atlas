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
          id?: string
          name: string
          slug: string
          plan?: string
          created_by: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          slug?: string
          plan?: string
          created_by?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'organizations_created_by_fkey'
            columns: ['created_by']
            isOneToOne: false
            referencedRelation: 'users'
            referencedColumns: ['id']
          },
        ]
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
          id?: string
          org_id: string
          user_id: string
          role?: 'owner' | 'member'
          created_at?: string
        }
        Update: {
          id?: string
          org_id?: string
          user_id?: string
          role?: 'owner' | 'member'
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'org_members_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'org_members_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'users'
            referencedColumns: ['id']
          },
        ]
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
          id?: string
          org_id: string
          name: string
          app_url: string
          auth_email?: string | null
          auth_password_encrypted?: string | null
          agentmail_inbox_id?: string | null
          agentmail_inbox_address?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          org_id?: string
          name?: string
          app_url?: string
          auth_email?: string | null
          auth_password_encrypted?: string | null
          agentmail_inbox_id?: string | null
          agentmail_inbox_address?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'projects_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      integrations: {
        Row: {
          id: string
          project_id: string
          type: 'github' | 'posthog' | 'slack'
          config: Json
          status: 'active' | 'disconnected'
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          project_id: string
          type: 'github' | 'posthog' | 'slack'
          config?: Json
          status?: 'active' | 'disconnected'
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          type?: 'github' | 'posthog' | 'slack'
          config?: Json
          status?: 'active' | 'disconnected'
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'integrations_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects'
            referencedColumns: ['id']
          },
        ]
      }
      test_templates: {
        Row: {
          id: string
          project_id: string
          name: string
          description: string | null
          steps: Json
          source: 'manual' | 'ai_generated'
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          project_id: string
          name: string
          description?: string | null
          steps?: Json
          source?: 'manual' | 'ai_generated'
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          name?: string
          description?: string | null
          steps?: Json
          source?: 'manual' | 'ai_generated'
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'test_templates_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects'
            referencedColumns: ['id']
          },
        ]
      }
      test_runs: {
        Row: {
          id: string
          project_id: string
          trigger: 'manual'
          trigger_ref: string | null
          status: 'pending' | 'planning' | 'running' | 'completed' | 'failed'
          modal_call_id: string | null
          started_at: string | null
          completed_at: string | null
          summary: Json | null
          created_at: string
        }
        Insert: {
          id?: string
          project_id: string
          trigger?: 'manual'
          trigger_ref?: string | null
          status?: 'pending' | 'planning' | 'running' | 'completed' | 'failed'
          modal_call_id?: string | null
          started_at?: string | null
          completed_at?: string | null
          summary?: Json | null
          created_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          trigger?: 'manual'
          trigger_ref?: string | null
          status?: 'pending' | 'planning' | 'running' | 'completed' | 'failed'
          modal_call_id?: string | null
          started_at?: string | null
          completed_at?: string | null
          summary?: Json | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'test_runs_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects'
            referencedColumns: ['id']
          },
        ]
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
          console_logs: Json | null
          network_errors: Json | null
          ai_analysis: string | null
          created_at: string
        }
        Insert: {
          id?: string
          test_run_id: string
          test_template_id?: string | null
          status: 'passed' | 'failed' | 'error' | 'skipped'
          duration_ms?: number | null
          error_message?: string | null
          screenshots?: string[]
          console_logs?: Json | null
          network_errors?: Json | null
          ai_analysis?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          test_run_id?: string
          test_template_id?: string | null
          status?: 'passed' | 'failed' | 'error' | 'skipped'
          duration_ms?: number | null
          error_message?: string | null
          screenshots?: string[]
          console_logs?: Json | null
          network_errors?: Json | null
          ai_analysis?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'test_results_test_run_id_fkey'
            columns: ['test_run_id']
            isOneToOne: false
            referencedRelation: 'test_runs'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'test_results_test_template_id_fkey'
            columns: ['test_template_id']
            isOneToOne: false
            referencedRelation: 'test_templates'
            referencedColumns: ['id']
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_user_org_ids: {
        Args: Record<string, never>
        Returns: string[]
      }
      is_org_owner: {
        Args: { target_org_id: string }
        Returns: boolean
      }
    }
    Enums: {
      org_role: 'owner' | 'member'
      integration_type: 'github' | 'posthog' | 'slack'
      integration_status: 'active' | 'disconnected'
      template_source: 'manual' | 'ai_generated'
      run_trigger: 'manual'
      run_status: 'pending' | 'planning' | 'running' | 'completed' | 'failed'
      result_status: 'passed' | 'failed' | 'error' | 'skipped'
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

// Convenience type aliases
export type Organization = Database['public']['Tables']['organizations']['Row']
export type OrgMember = Database['public']['Tables']['org_members']['Row']
export type Project = Database['public']['Tables']['projects']['Row']
export type Integration = Database['public']['Tables']['integrations']['Row']
export type TestTemplate = Database['public']['Tables']['test_templates']['Row']
export type TestRun = Database['public']['Tables']['test_runs']['Row']
export type TestResult = Database['public']['Tables']['test_results']['Row']
