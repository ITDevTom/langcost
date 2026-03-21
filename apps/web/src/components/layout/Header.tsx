interface HeaderProps {
  configured: boolean;
  currentPath: string;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

const NAV_ITEMS = [
  { path: "/", label: "Traces" },
  { path: "/overview", label: "Overview" },
  { path: "/settings", label: "Settings" },
];

export function Header({
  configured,
  currentPath,
  onNavigate,
  onRefresh,
  refreshing,
  theme,
  onToggleTheme,
}: HeaderProps) {
  return (
    <header className="site-header fixed inset-x-0 top-0 z-20 border-b border-[color:var(--border)] backdrop-blur">
      <div className="flex w-full items-center justify-between gap-4 px-4 py-4 sm:px-6 xl:px-10">
        <div className="flex items-center gap-4">
          <button type="button" onClick={() => onNavigate("/")} className="header-brand">
            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-[color:var(--accent-blue)]" />
            <span className="text-sm font-semibold tracking-[0.18em] text-slate-100 uppercase">
              langcost
            </span>
          </button>

          {configured ? (
            <nav className="hidden items-center gap-1 md:flex">
              {NAV_ITEMS.map((item) => {
                const active = currentPath === item.path;
                return (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => onNavigate(item.path)}
                    className={`nav-pill ${active ? "nav-pill-active" : ""}`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </nav>
          ) : (
            <p className="hidden text-sm text-slate-400 md:block">
              Connect a source to explore traces, costs, and waste.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleTheme}
            className="theme-toggle"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            <span
              className={`theme-toggle__label ${
                theme === "dark" ? "theme-toggle__label--active" : ""
              }`}
            >
              Dark
            </span>
            <span
              className={`theme-toggle__label ${
                theme === "light" ? "theme-toggle__label--active" : ""
              }`}
            >
              Light
            </span>
          </button>

          <button
            type="button"
            onClick={onRefresh}
            disabled={!configured || refreshing}
            className="button-secondary rounded-full px-4 py-2 text-sm"
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
    </header>
  );
}
