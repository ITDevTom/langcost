export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
}

function pad(value: string, width: number, align: "left" | "right"): string {
  return align === "right" ? value.padStart(width, " ") : value.padEnd(width, " ");
}

export function renderTable(columns: TableColumn[], rows: Array<Record<string, string>>): string {
  if (rows.length === 0) {
    return "No rows.";
  }

  const widths = columns.map((column) =>
    Math.max(column.label.length, ...rows.map((row) => (row[column.key] ?? "").length)),
  );

  const header = columns
    .map((column, index) =>
      pad(column.label, widths[index] ?? column.label.length, column.align ?? "left"),
    )
    .join(" | ");

  const separator = columns
    .map((column, index) =>
      column.align === "right"
        ? `${"-".repeat(Math.max(1, (widths[index] ?? column.label.length) - 1))}:`
        : "-".repeat(widths[index] ?? column.label.length),
    )
    .join("-+-");

  const body = rows.map((row) =>
    columns
      .map((column, index) =>
        pad(row[column.key] ?? "", widths[index] ?? column.label.length, column.align ?? "left"),
      )
      .join(" | "),
  );

  return [header, separator, ...body].join("\n");
}

export function renderMarkdownTable(
  columns: TableColumn[],
  rows: Array<Record<string, string>>,
): string {
  if (rows.length === 0) {
    return "No rows.";
  }

  const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
  const separator = `| ${columns
    .map((column) => (column.align === "right" ? "---:" : "---"))
    .join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${columns.map((column) => row[column.key] ?? "").join(" | ")} |`,
  );

  return [header, separator, ...body].join("\n");
}
