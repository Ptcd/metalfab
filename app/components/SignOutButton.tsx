"use client";

import { useRouter } from "next/navigation";

export function SignOutButton() {
  const router = useRouter();

  async function handleSignOut() {
    // Clear the site access cookie server-side, then bounce to /unlock.
    await fetch("/api/unlock", { method: "DELETE" });
    router.push("/unlock");
    router.refresh();
  }

  return (
    <button
      onClick={handleSignOut}
      className="w-full px-3 py-2 rounded-md text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors text-left"
    >
      Lock
    </button>
  );
}
