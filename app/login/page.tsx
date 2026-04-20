import { redirect } from "next/navigation";

// The old per-user Supabase login has been replaced by the shared site code
// gate at /unlock. Keep this path alive so old links don't 404, but bounce
// them to /unlock.
export default function LoginPage() {
  redirect("/unlock");
}
