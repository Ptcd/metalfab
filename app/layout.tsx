import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import "./globals.css";
import { DarkModeToggle } from "./components/DarkModeToggle";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "TCB Metalworks — Bid Pipeline",
  description: "Contract opportunity tracking and bid management",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                const theme = localStorage.getItem('theme');
                if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                  document.documentElement.classList.add('dark');
                }
              })();
            `,
          }}
        />
      </head>
      <body className={`${geistSans.variable} font-sans antialiased bg-[var(--background)] text-[var(--foreground)]`}>
        <div className="flex h-screen">
          {/* Sidebar */}
          <aside className="w-56 shrink-0 border-r border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 flex flex-col">
            <div className="p-4 border-b border-slate-200 dark:border-slate-700">
              <h1 className="text-lg font-bold text-slate-900 dark:text-white">TCB Metalworks</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">Bid Pipeline</p>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              <NavLink href="/dashboard">Dashboard</NavLink>
              <NavLink href="/activity">Activity</NavLink>
              <NavLink href="/config">Config</NavLink>
            </nav>
            <div className="p-3 border-t border-slate-200 dark:border-slate-700">
              <DarkModeToggle />
            </div>
          </aside>

          {/* Main content */}
          <main className="flex-1 overflow-auto p-6">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

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
