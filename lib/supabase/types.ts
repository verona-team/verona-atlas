export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      agent_credentials: {
        Row: {
          created_at: string
          email: string
          id: string
          last_used_at: string | null
          password_encrypted: string
          project_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          last_used_at?: string | null
          password_encrypted: string
          project_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          last_used_at?: string | null
          password_encrypted?: string
          project_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_credentials_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          client_message_id: string | null
          content: string
          created_at: string | null
          id: string
          metadata: Json | null
          role: string
          session_id: string
        }
        Insert: {
          client_message_id?: string | null
          content: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          role: string
          session_id: string
        }
        Update: {
          client_message_id?: string | null
          content?: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          role?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_sessions: {
        Row: {
          active_chat_call_id: string | null
          active_chat_call_started_at: string | null
          context_summary: string | null
          created_at: string | null
          id: string
          project_id: string
          research_report: Json | null
          status: string
          status_updated_at: string | null
          updated_at: string | null
        }
        Insert: {
          active_chat_call_id?: string | null
          active_chat_call_started_at?: string | null
          context_summary?: string | null
          created_at?: string | null
          id?: string
          project_id: string
          research_report?: Json | null
          status?: string
          status_updated_at?: string | null
          updated_at?: string | null
        }
        Update: {
          active_chat_call_id?: string | null
          active_chat_call_started_at?: string | null
          context_summary?: string | null
          created_at?: string | null
          id?: string
          project_id?: string
          research_report?: Json | null
          status?: string
          status_updated_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chat_sessions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations: {
        Row: {
          config: Json
          created_at: string
          id: string
          project_id: string
          status: Database["public"]["Enums"]["integration_status"]
          type: Database["public"]["Enums"]["integration_type"]
          updated_at: string
        }
        Insert: {
          config?: Json
          created_at?: string
          id?: string
          project_id: string
          status?: Database["public"]["Enums"]["integration_status"]
          type: Database["public"]["Enums"]["integration_type"]
          updated_at?: string
        }
        Update: {
          config?: Json
          created_at?: string
          id?: string
          project_id?: string
          status?: Database["public"]["Enums"]["integration_status"]
          type?: Database["public"]["Enums"]["integration_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integrations_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      landing_generated_images: {
        Row: {
          created_at: string
          id: string
          image_url: string
          location: string | null
          name: string
          prompt: string
        }
        Insert: {
          created_at?: string
          id?: string
          image_url: string
          location?: string | null
          name: string
          prompt: string
        }
        Update: {
          created_at?: string
          id?: string
          image_url?: string
          location?: string | null
          name?: string
          prompt?: string
        }
        Relationships: []
      }
      landing_generation_lock: {
        Row: {
          id: number
          lock_expires_at: string | null
          locked_by: string | null
          next_allowed_at: string | null
        }
        Insert: {
          id: number
          lock_expires_at?: string | null
          locked_by?: string | null
          next_allowed_at?: string | null
        }
        Update: {
          id?: number
          lock_expires_at?: string | null
          locked_by?: string | null
          next_allowed_at?: string | null
        }
        Relationships: []
      }
      org_members: {
        Row: {
          created_at: string
          id: string
          org_id: string
          role: Database["public"]["Enums"]["org_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          role?: Database["public"]["Enums"]["org_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          role?: Database["public"]["Enums"]["org_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          created_by: string
          id: string
          plan: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          plan?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          plan?: string
          updated_at?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          agentmail_inbox_address: string | null
          agentmail_inbox_id: string | null
          app_url: string
          bootstrap_dispatched_at: string | null
          created_at: string
          id: string
          name: string
          org_id: string
          schedule_days: string[] | null
          schedule_enabled: boolean | null
          schedule_time: string | null
          timezone: string | null
          updated_at: string
        }
        Insert: {
          agentmail_inbox_address?: string | null
          agentmail_inbox_id?: string | null
          app_url: string
          bootstrap_dispatched_at?: string | null
          created_at?: string
          id?: string
          name: string
          org_id: string
          schedule_days?: string[] | null
          schedule_enabled?: boolean | null
          schedule_time?: string | null
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          agentmail_inbox_address?: string | null
          agentmail_inbox_id?: string | null
          app_url?: string
          bootstrap_dispatched_at?: string | null
          created_at?: string
          id?: string
          name?: string
          org_id?: string
          schedule_days?: string[] | null
          schedule_enabled?: boolean | null
          schedule_time?: string | null
          timezone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      test_results: {
        Row: {
          ai_analysis: string | null
          console_logs: Json | null
          created_at: string
          duration_ms: number | null
          error_message: string | null
          id: string
          network_errors: Json | null
          recording_url: string | null
          screenshots: string[]
          status: Database["public"]["Enums"]["result_status"]
          test_run_id: string
          test_template_id: string | null
        }
        Insert: {
          ai_analysis?: string | null
          console_logs?: Json | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          network_errors?: Json | null
          recording_url?: string | null
          screenshots?: string[]
          status: Database["public"]["Enums"]["result_status"]
          test_run_id: string
          test_template_id?: string | null
        }
        Update: {
          ai_analysis?: string | null
          console_logs?: Json | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          network_errors?: Json | null
          recording_url?: string | null
          screenshots?: string[]
          status?: Database["public"]["Enums"]["result_status"]
          test_run_id?: string
          test_template_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "test_results_test_run_id_fkey"
            columns: ["test_run_id"]
            isOneToOne: false
            referencedRelation: "test_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_results_test_template_id_fkey"
            columns: ["test_template_id"]
            isOneToOne: false
            referencedRelation: "test_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      test_runs: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          live_session: Json | null
          modal_call_id: string | null
          project_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["run_status"]
          summary: Json | null
          trigger: Database["public"]["Enums"]["run_trigger"]
          trigger_ref: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          live_session?: Json | null
          modal_call_id?: string | null
          project_id: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
          summary?: Json | null
          trigger: Database["public"]["Enums"]["run_trigger"]
          trigger_ref?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          live_session?: Json | null
          modal_call_id?: string | null
          project_id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
          summary?: Json | null
          trigger?: Database["public"]["Enums"]["run_trigger"]
          trigger_ref?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "test_runs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      test_templates: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          project_id: string
          source: Database["public"]["Enums"]["template_source"]
          steps: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          project_id: string
          source?: Database["public"]["Enums"]["template_source"]
          steps?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          project_id?: string
          source?: Database["public"]["Enums"]["template_source"]
          steps?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "test_templates_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      user_github_identities: {
        Row: {
          access_token_encrypted: string
          access_token_expires_at: string | null
          created_at: string
          github_login: string
          github_user_id: number
          refresh_token_encrypted: string | null
          refresh_token_expires_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token_encrypted: string
          access_token_expires_at?: string | null
          created_at?: string
          github_login: string
          github_user_id: number
          refresh_token_encrypted?: string | null
          refresh_token_expires_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token_encrypted?: string
          access_token_expires_at?: string | null
          created_at?: string
          github_login?: string
          github_user_id?: number
          refresh_token_encrypted?: string | null
          refresh_token_expires_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      commit_landing_lock: {
        Args: { p_cooldown_seconds?: number; p_token: string }
        Returns: boolean
      }
      delete_auth_user_app_data: {
        Args: { target_user_id: string }
        Returns: undefined
      }
      get_user_org_ids: { Args: never; Returns: string[] }
      is_org_owner: { Args: { target_org_id: string }; Returns: boolean }
      release_landing_lock: { Args: { p_token: string }; Returns: boolean }
      try_acquire_landing_lock: {
        Args: { p_lock_duration_seconds?: number }
        Returns: string
      }
    }
    Enums: {
      integration_status: "active" | "disconnected"
      integration_type:
        | "github"
        | "posthog"
        | "slack"
        | "sentry"
        | "langsmith"
        | "braintrust"
      org_role: "owner" | "member"
      result_status: "passed" | "failed" | "error" | "skipped"
      run_status: "pending" | "planning" | "running" | "completed" | "failed"
      run_trigger: "manual" | "scheduled" | "chat"
      template_source: "manual" | "ai_generated" | "chat_generated"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      integration_status: ["active", "disconnected"],
      integration_type: [
        "github",
        "posthog",
        "slack",
        "sentry",
        "langsmith",
        "braintrust",
      ],
      org_role: ["owner", "member"],
      result_status: ["passed", "failed", "error", "skipped"],
      run_status: ["pending", "planning", "running", "completed", "failed"],
      run_trigger: ["manual", "scheduled", "chat"],
      template_source: ["manual", "ai_generated", "chat_generated"],
    },
  },
} as const

// --- Convenience aliases -----------------------------------------------------
// Auto-appended by scripts/supabase-gen-types.sh after `supabase gen types`
// (the generator overwrites this file, so aliases live here).
export type Project = Database["public"]["Tables"]["projects"]["Row"]
export type ChatSession = Database["public"]["Tables"]["chat_sessions"]["Row"]
export type ChatMessage = Database["public"]["Tables"]["chat_messages"]["Row"]
export type UserGithubIdentity = Database["public"]["Tables"]["user_github_identities"]["Row"]
