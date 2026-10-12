export type BrowserScreenshot = {
  mimeType: string;
  base64Data: string;
};

export type BrowserInspectionDiagnostics = {
  available: boolean;
  toolCallCount: number;
  toolNames: string[];
  modelToolCallCount: number;
  modelToolNames: string[];
  failedToolCallCount: number;
  screenshotCount: number;
};

/** Application-facing, restricted view of the rendered article browser. */
export interface BrowserInspectionSession {
  readonly initialAccessibilitySnapshot: string;
  readonly initialScreenshot: BrowserScreenshot | null;
  takeAccessibilitySnapshot(): Promise<string>;
  takeScreenshot(fullPage: boolean): Promise<BrowserScreenshot>;
  inspectDom(keyword: string): Promise<string>;
  scrollToText(text: string): Promise<string>;
  listImageRequests(): Promise<string>;
  recordModelToolCall(name: string): void;
  getDiagnostics(): BrowserInspectionDiagnostics;
  close(): Promise<void>;
}
