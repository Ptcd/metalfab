"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { DarkModeToggle } from "./DarkModeToggle";
import { SignOutButton } from "./SignOutButton";

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="block px-3 py-2 rounded-md text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
    >
      {children}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // On the login/unlock pages, render children without the sidebar wrapper
  if (pathname === "/login" || pathname === "/unlock") {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 border-r border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 flex flex-col">
        <div className="p-4 border-b border-slate-200 dark:border-slate-700">
          <h1 className="text-lg font-bold text-slate-900 dark:text-white">TCB Metalworks</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">Bid Pipeline</p>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          <NavLink href="/today">Today</NavLink>
          <NavLink href="/dashboard">Pipeline</NavLink>
          <NavLink href="/customers">Customers</NavLink>
          <NavLink href="/activity">Activity</NavLink>
          <NavLink href="/config">Config</NavLink>
        </nav>
        <div className="p-3 border-t border-slate-200 dark:border-slate-700 space-y-1">
          <DarkModeToggle />
          <SignOutButton />
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-6">
        {children}
      </main>
    </div>
  );
}
