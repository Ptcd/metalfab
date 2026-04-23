import { redirect } from "next/navigation";

// The sidebar labels this view "Pipeline" but the route is /dashboard.
// Keep both URLs alive so bookmarks and muscle memory don't 404.
export default function PipelineRedirect() {
  redirect("/dashboard");
}
