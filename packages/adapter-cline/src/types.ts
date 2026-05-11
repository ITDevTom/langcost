export interface ClineModelInfo {
  providerId?: string;
  modelId?: string;
  mode?: string;
  [key: string]: unknown;
}

export interface ClineUiMessage {
  ts?: number;
  type?: string;
  say?: string;
  ask?: string;
  text?: string;
  conversationHistoryIndex?: number;
  modelInfo?: ClineModelInfo;
  [key: string]: unknown;
}

export interface ClineApiRequestUsage {
  source?: string;
  request?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheWrites?: number;
  cacheReads?: number;
  cost?: number;
  [key: string]: unknown;
}

export interface ClineApiConversationMetrics {
  tokens?: {
    prompt?: number;
    completion?: number;
    cached?: number;
    cacheWrites?: number;
    cacheReads?: number;
    [key: string]: unknown;
  };
  cost?: number;
  [key: string]: unknown;
}

export interface ClineApiConversationMessage {
  role?: string;
  content?: unknown;
  modelInfo?: ClineModelInfo;
  metrics?: ClineApiConversationMetrics;
  ts?: number;
  [key: string]: unknown;
}

export interface ClineTaskHistoryItem {
  id: string;
  ulid?: string;
  ts?: number;
  task?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheWrites?: number;
  cacheReads?: number;
  totalCost?: number;
  cwdOnTaskInitialization?: string;
  modelId?: string;
  [key: string]: unknown;
}

export interface DiscoveredClineTaskFile {
  filePath: string;
  fileSize: number;
  modifiedAt: Date;
  taskId: string;
  rootPath?: string;
}

export interface ReadClineTaskResult {
  taskId: string;
  sourceFile: string;
  rootPath?: string;
  uiMessages: ClineUiMessage[];
  apiConversationHistory?: ClineApiConversationMessage[];
  taskHistoryItem?: ClineTaskHistoryItem;
  lastOffset: number;
  lastLineHash?: string;
  errors: Array<{ line?: number; message: string }>;
}
