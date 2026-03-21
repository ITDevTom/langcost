interface SidebarProps {
  configured: boolean;
  currentPath: string;
  onNavigate: (path: string) => void;
}

const NAV_ITEMS = [
  { path: "/", label: "Overview" },
  { path: "/sessions", label: "Sessions" },
  { path: "/settings", label: "Settings" },
];

export function Sidebar({ configured, currentPath, onNavigate }: SidebarProps) {
  if (!configured) {
    return null;
  }

  return (
    <div className="panel p-2 md:hidden">
      <div className="grid grid-cols-3 gap-2">
        {NAV_ITEMS.map((item) => {
          const active = currentPath === item.path;
          return (
            <button
              key={item.path}
              type="button"
              onClick={() => onNavigate(item.path)}
              className={`rounded-xl px-3 py-2 text-sm transition ${
                active
                  ? "bg-blue-500/15 text-blue-100"
                  : "bg-transparent text-slate-400 hover:bg-white/5 hover:text-slate-100"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
