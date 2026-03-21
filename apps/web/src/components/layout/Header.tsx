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
      <div className="mx-auto flex w-full max-w-[1480px] items-center justify-between gap-4 px-4 py-3 sm:px-6 xl:px-10">
        <div className="flex items-center gap-5">
          <button type="button" onClick={() => onNavigate("/")} className="header-brand">
            <img
              src="/logo.svg"
              alt=""
              className="h-7 w-7"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
            <span className="text-[15px] font-bold tracking-[-0.01em]" style={{ color: "var(--text-primary)" }}>
              Lang<span style={{ color: "var(--accent-orange, #ff6b00)" }}>Cost</span>
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
