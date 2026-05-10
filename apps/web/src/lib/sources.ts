export interface SourceOption {
  value: string;
  label: string;
  description: string;
  sourcePathLabel: string;
  sourcePathPlaceholder: string;
  defaultSourcePath: string;
}

export const DEFAULT_SOURCE: SourceOption = {
  value: "openclaw",
  label: "OpenClaw",
  description: "Local JSONL sessions on disk",
  sourcePathLabel: "OpenClaw path",
  sourcePathPlaceholder: "~/.openclaw",
  defaultSourcePath: "~/.openclaw",
};

export const SOURCE_OPTIONS: SourceOption[] = [
  DEFAULT_SOURCE,
  {
    value: "claude-code",
    label: "Claude Code",
    description: "Local conversation logs on disk",
    sourcePathLabel: "Claude Code path",
    sourcePathPlaceholder: "~/.claude",
    defaultSourcePath: "~/.claude",
  },
  {
    value: "warp",
    label: "Warp",
    description: "Local warp.sqlite session data",
    sourcePathLabel: "Warp database path",
    sourcePathPlaceholder: "Leave blank to auto-detect warp.sqlite",
    defaultSourcePath: "",
  },
];

export function getSourceOption(source: string | undefined): SourceOption {
  return SOURCE_OPTIONS.find((option) => option.value === source) ?? DEFAULT_SOURCE;
}
