import type { IAdapter } from "@langcost/core";

async function importAdapterModule(specifier: string) {
  return import(specifier);
}

export async function loadAdapter(name: string): Promise<IAdapter> {
  const packageName = `@langcost/adapter-${name}`;

  try {
    const mod = await importAdapterModule(packageName);
    const adapter = mod.default as IAdapter | undefined;

    if (!adapter) {
      throw new Error(`Adapter module "${packageName}" has no default export.`);
    }

    return adapter;
  } catch (error) {
    try {
      const workspaceModule = await importAdapterModule(
        new URL(`../../adapter-${name}/src/index.ts`, import.meta.url).href,
      );
      const adapter = workspaceModule.default as IAdapter | undefined;

      if (!adapter) {
        throw new Error(`Workspace adapter "${packageName}" has no default export.`);
      }

      return adapter;
    } catch {
      const details = error instanceof Error ? `\n${error.message}` : "";
      throw new Error(
        `Adapter "${name}" not found.\nInstall it: npm install ${packageName}${details}`,
      );
    }
  }
}
