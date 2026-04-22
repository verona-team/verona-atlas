import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getServerUser } from "@/lib/supabase/server-user";

export default async function ProjectsPage() {
  const supabase = await createClient();

  const user = await getServerUser(supabase);
  if (!user) return null;

  const { data: membership } = await supabase
    .from("org_members")
    .select("org_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  const orgId = membership?.org_id;

  const { data: projects } = orgId
    ? await supabase
        .from("projects")
        .select("id")
        .eq("org_id", orgId)
        .order("updated_at", { ascending: false })
        .limit(1)
    : { data: [] as never[] };

  if (projects && projects.length > 0) {
    redirect(`/projects/${projects[0].id}`);
  }

  return <EmptyProjectsPage />;
}

function EmptyProjectsPage() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center space-y-3">
        <h2 className="text-2xl font-medium">Welcome to Verona</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          Create your first project to get started.
        </p>
      </div>
    </div>
  );
}
