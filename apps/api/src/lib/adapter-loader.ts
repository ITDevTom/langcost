import type { IAdapter } from "@langcost/core";

async function importModule(specifier: string) {
  return import(specifier);
}

async function importInstalledAdapter(name: string): Promise<IAdapter | null> {
  const packageName = `@langcost/adapter-${name}`;
  try {
    const module = await importModule(packageName);
    const adapter = module.default as IAdapter | undefined;
    return adapter ?? null;
  } catch {
    return null;
  }
}

async function importWorkspaceAdapter(name: string): Promise<IAdapter | null> {
  try {
    const module = await importModule(
      new URL(`../../../../packages/adapter-${name}/src/index.ts`, import.meta.url).href,
    );
    const adapter = module.default as IAdapter | undefined;
    return adapter ?? null;
  } catch {
    return null;
  }
}

export async function tryLoadAdapter(name: string): Promise<IAdapter | null> {
  return (await importInstalledAdapter(name)) ?? (await importWorkspaceAdapter(name));
}

export async function loadAdapter(name: string): Promise<IAdapter> {
  const adapter = await tryLoadAdapter(name);
  if (adapter) return adapter;

  const packageName = `@langcost/adapter-${name}`;
  throw new Error(`Adapter "${name}" not found.\nInstall it: npm install ${packageName}`);
}
