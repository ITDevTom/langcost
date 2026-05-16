import { Hono } from "hono";

import { tryLoadAdapter } from "../lib/adapter-loader";

interface KnownAdapter {
  name: string;
  label: string;
}

const KNOWN_ADAPTERS: KnownAdapter[] = [
  { name: "openclaw", label: "OpenClaw" },
  { name: "claude-code", label: "Claude Code" },
  { name: "warp", label: "Warp" },
];

interface AdapterStatusInstalled {
  name: string;
  label: string;
  installed: true;
  version: string;
}

interface AdapterStatusMissing {
  name: string;
  label: string;
  installed: false;
  installCommand: string;
}

type AdapterStatus = AdapterStatusInstalled | AdapterStatusMissing;

async function buildAdapterStatus(known: KnownAdapter): Promise<AdapterStatus> {
  const adapter = await tryLoadAdapter(known.name);

  if (adapter) {
    return {
      name: known.name,
      label: known.label,
      installed: true,
      version: adapter.meta.version,
    };
  }

  return {
    name: known.name,
    label: known.label,
    installed: false,
    installCommand: `npm install -g @langcost/adapter-${known.name}`,
  };
}

export function createAdaptersRoute() {
  const route = new Hono();

  route.get("/", async (c) => {
    const adapters = await Promise.all(KNOWN_ADAPTERS.map(buildAdapterStatus));
    return c.json({ adapters });
  });

  return route;
}
