import { useEffect, useMemo, useState } from "react";

import {
  getHealth,
  getSettings,
  type HealthResponse,
  type SettingsResponse,
  triggerScan,
} from "./api/client";
import { Header } from "./components/layout/Header";
import { Overview } from "./pages/Overview";
import { Sessions } from "./pages/Sessions";
import { Settings } from "./pages/Settings";
import { Setup } from "./pages/Setup";
import { TraceDetail } from "./pages/TraceDetail";

type Route =
  | { page: "setup" }
  | { page: "traces" }
  | { page: "overview" }
  | { page: "settings" }
  | { page: "trace"; traceId: string };

function parseRoute(pathname: string, configured: boolean): Route {
  if (!configured) {
    return { page: "setup" };
  }

  if (pathname.startsWith("/traces/")) {
    const traceId = pathname.replace(/^\/traces\//, "");
    return { page: "trace", traceId: decodeURIComponent(traceId) };
  }

  if (pathname === "/overview") {
    return { page: "overview" };
  }

  if (pathname === "/settings") {
    return { page: "settings" };
  }

  return { page: "traces" };
}

export default function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") {
      return "dark";
    }

    const savedTheme = window.localStorage.getItem("langcost-theme");
    if (savedTheme === "light" || savedTheme === "dark") {
      return savedTheme;
    }

    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  const [loadingShell, setLoadingShell] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);
  const [bannerTone, setBannerTone] = useState<"info" | "error">("info");

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("langcost-theme", theme);
  }, [theme]);

  async function reloadShell() {
    const [nextSettings, nextHealth] = await Promise.all([getSettings(), getHealth()]);
    setSettings(nextSettings);
    setHealth(nextHealth);
    setRefreshToken((current) => current + 1);
  }

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const [nextSettings, nextHealth] = await Promise.all([getSettings(), getHealth()]);

        if (!active) {
          return;
        }

        setSettings(nextSettings);
        setHealth(nextHealth);
      } catch (cause) {
        if (!active) {
          return;
        }

        setBanner(cause instanceof Error ? cause.message : "Failed to initialize dashboard.");
        setBannerTone("error");
      } finally {
        if (active) {
          setLoadingShell(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const configured = Boolean(settings?.source);
  const route = useMemo(() => parseRoute(pathname, configured), [configured, pathname]);
  const activePath = route.page === "trace" || route.page === "traces" ? "/" : pathname;

  function navigate(path: string) {
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }

    setPathname(path);
  }

  async function handleRefresh() {
    if (!configured) {
      return;
    }

    setRefreshing(true);
    setBanner(null);

    try {
      const result = await triggerScan(false);
      await reloadShell();
      setBanner(`Refresh complete. Ingested ${result.tracesIngested} traces.`);
      setBannerTone("info");
    } catch (cause) {
      setBanner(cause instanceof Error ? cause.message : "Refresh failed.");
      setBannerTone("error");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleConfigured() {
    await reloadShell();
    navigate("/");
  }

  async function handleSettingsSaved() {
    await reloadShell();
    setBanner("Settings saved.");
    setBannerTone("info");
  }

  if (loadingShell) {
    return (
      <div className="page-shell">
        <div className="panel p-8 text-sm text-slate-400">Loading dashboard shell...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header
        configured={configured}
        currentPath={activePath}
        onNavigate={navigate}
        onRefresh={() => void handleRefresh()}
        refreshing={refreshing}
        theme={theme}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
      />

      <main className="page-shell">
        {banner ? (
          <div className={`banner ${bannerTone === "error" ? "banner--error" : "banner--info"}`}>
            {banner}
          </div>
        ) : null}

        {route.page === "setup" ? (
          <Setup initialSettings={settings} onConfigured={handleConfigured} />
        ) : null}
        {route.page === "traces" ? (
          <Sessions refreshToken={refreshToken} onNavigate={navigate} />
        ) : null}
        {route.page === "overview" ? (
          <Overview refreshToken={refreshToken} onNavigate={navigate} />
        ) : null}
        {route.page === "settings" ? (
          <Settings
            settings={settings}
            health={health}
            refreshing={refreshing}
            onSettingsSaved={handleSettingsSaved}
            onRefreshData={handleRefresh}
          />
        ) : null}
        {route.page === "trace" ? (
          <TraceDetail
            traceId={route.traceId}
            refreshToken={refreshToken}
            onBack={() => navigate("/")}
          />
        ) : null}
      </main>
    </div>
  );
}
