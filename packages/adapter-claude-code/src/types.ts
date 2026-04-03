// ──────────────────────────────────────────
// Claude Code JSONL entry types
// ──────────────────────────────────────────

export interface ClaudeCodeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  service_tier?: string;
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  };
  inference_geo?: string;
  speed?: string;
}

// ── Content blocks ──

export interface ClaudeCodeTextBlock {
  type: "text";
  text: string;
}

export interface ClaudeCodeThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ClaudeCodeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeCodeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  is_error?: boolean;
}

export interface ClaudeCodeImageBlock {
  type: "image";
  source?: unknown;
}

export type ClaudeCodeContentBlock =
  | ClaudeCodeImageBlock
  | ClaudeCodeTextBlock
  | ClaudeCodeThinkingBlock
  | ClaudeCodeToolResultBlock
  | ClaudeCodeToolUseBlock
  | { type: string; [key: string]: unknown };

// ── Message payloads ──

export interface ClaudeCodeAssistantPayload {
  model: string;
  id: string;
  type: "message";
  role: "assistant";
  content: ClaudeCodeContentBlock[];
  stop_reason: string | null;
  usage: ClaudeCodeUsage;
}

export interface ClaudeCodeUserPayload {
  role: "user";
  content: string | ClaudeCodeContentBlock[];
}

// ── JSONL entry types ──

export interface ClaudeCodeBaseEntry {
  type: string;
  uuid?: string;
  timestamp?: string;
  parentUuid?: string;
  sessionId?: string;
  isSidechain?: boolean;
  userType?: string;
  entrypoint?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  permissionMode?: string;
  promptId?: string;
  requestId?: string;
}

export interface ClaudeCodeUserEntry extends ClaudeCodeBaseEntry {
  type: "user";
  message: ClaudeCodeUserPayload;
}

export interface ClaudeCodeAssistantEntry extends ClaudeCodeBaseEntry {
  type: "assistant";
  message: ClaudeCodeAssistantPayload;
}

export interface ClaudeCodeSystemEntry extends ClaudeCodeBaseEntry {
  type: "system";
  subtype?: string;
  durationMs?: number;
  messageCount?: number;
  isMeta?: boolean;
}

export interface ClaudeCodeProgressEntry extends ClaudeCodeBaseEntry {
  type: "progress";
}

export interface ClaudeCodeFileHistoryEntry extends ClaudeCodeBaseEntry {
  type: "file-history-snapshot";
  messageId?: string;
  snapshot?: Record<string, unknown>;
  isSnapshotUpdate?: boolean;
}

export type ClaudeCodeEntry =
  | ClaudeCodeAssistantEntry
  | ClaudeCodeFileHistoryEntry
  | ClaudeCodeProgressEntry
  | ClaudeCodeSystemEntry
  | ClaudeCodeUserEntry
  | (ClaudeCodeBaseEntry & { type: string });

// ── Discovery types ──

export interface DiscoveredProject {
  projectPath: string;
  projectName: string;
  originalPath: string;
}

export interface DiscoveredConversationFile {
  filePath: string;
  fileSize: number;
  modifiedAt: Date;
  conversationId: string;
  project: DiscoveredProject;
  parentConversationId?: string;
  subagentId?: string;
}

export interface ReadConversationResult {
  entries: ClaudeCodeEntry[];
  lastLineHash?: string;
  lastOffset: number;
  errors: Array<{ line: number; message: string }>;
}
