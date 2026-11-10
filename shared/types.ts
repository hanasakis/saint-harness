export type AccessMode = 'ask' | 'auto' | 'full';
export interface Project { id: string; name: string; path: string; trusted: boolean; archivedAt?: number }
export interface Thread { id: string; projectId: string; title: string; sessionFile?: string; attachmentPaths?: string[]; createdAt: number; updatedAt: number; archivedAt?: number }
export interface ProviderConfig { id: 'anthropic' | 'openai' | 'deepseek' | 'custom'; name: string; baseUrl?: string; modelId?: string; contextWindow?: number; reasoning?: boolean; supportsImages?: boolean; hasKey?: boolean }
export interface ConnectionTestResult { ok: boolean; message: string; elapsedMs: number; modelCount?: number }
export interface Settings { access: AccessMode; autoCheck: boolean; autoUpdate: boolean; providers: ProviderConfig[]; defaultModel?: { provider: string; id: string }; defaultThinking?: string }
export interface Model { id: string; name: string; provider: string; contextWindow: number; reasoning: boolean; input?: string[] }
export interface Skill { name: string; description?: string; source: string; sourceInfo?: { path: string; scope: string } }
export interface ContentBlock { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown>; data?: string; mimeType?: string }
export interface Message { role: string; content: string | ContentBlock[]; timestamp?: number; toolName?: string; toolCallId?: string; isError?: boolean; errorMessage?: string; stopReason?: string; usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } }
export interface SessionStats { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number; contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } }
export interface Snapshot { connected: boolean; busy: boolean; threadId?: string; model?: Model; thinkingLevel: string; models: Model[]; levels: string[]; commands: Skill[]; messages: Message[]; stats?: SessionStats; sessionFile?: string; error?: string }
export interface EngineCandidate { cli: string; version: string; source: string; managedRoot?: string }
export interface RuntimeInfo { current: string; installed: boolean; candidates: EngineCandidate[]; latest?: string; previous?: string; updating: boolean; message?: string; external: boolean; path: string; updateAvailable?: boolean }
export interface Bootstrap { projects: Project[]; threads: Thread[]; activeThreadId?: string; settings: Settings; engine: RuntimeInfo; version: string; snapshot: Snapshot }
export interface FileEntry { name: string; path: string; directory: boolean }
export interface ChangeEntry { path: string; status: string; additions: number; deletions: number; untracked: boolean }
export interface Changes { git: boolean; branch?: string; files: ChangeEntry[]; error?: string }
export interface Attachment { id: string; name: string; bytes: number; image: boolean; kind?: 'image' | 'text' | 'file'; preview?: string }
export interface PiEvent { type: string; [key: string]: any }
export interface AccessConfirmation { id: string }
export type DesktopEvent = { kind: 'pi'; threadId?: string; record: PiEvent } | { kind: 'snapshot'; snapshot: Snapshot } | { kind: 'engine'; engine: RuntimeInfo } | { kind: 'data' } | { kind: 'confirm-access'; request: AccessConfirmation } | { kind: 'notice'; message: string; error?: boolean };
export interface Bridge { invoke<T = any>(action: string, payload?: unknown): Promise<T>; addDroppedFiles(files: File[]): Promise<Attachment[]>; onEvent(callback: (event: DesktopEvent) => void): () => void; window(action: 'minimize' | 'maximize' | 'close'): void }
declare global { interface Window { saint: Bridge } }
