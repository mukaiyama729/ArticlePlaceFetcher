import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  BrowserInspectionDiagnostics,
  BrowserInspectionSession,
  BrowserScreenshot,
} from "../../../application/extract-page/port/out/browser-inspection-session.js";

const require = createRequire(import.meta.url);
const packageEntryPath = require.resolve("chrome-devtools-mcp");
const serverEntryPath = join(dirname(packageEntryPath), "bin", "chrome-devtools-mcp.js");

type McpContentResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};

const hasContent = (result: unknown): result is McpContentResult =>
  typeof result === "object" &&
  result !== null &&
  "content" in result &&
  Array.isArray(result.content);

const textContent = (result: McpContentResult): string => {
  if (result.isError) throw new Error("Chrome DevTools MCP returned an error.");
  return result.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
};

const encodedLiteral = (value: string): string => JSON.stringify(value.slice(0, 300));

export class ChromeDevToolsMcpInspector implements BrowserInspectionSession {
  private toolNames: string[] = [];
  private modelToolNames: string[] = [];
  private failedToolCallCount = 0;
  private screenshotCount = 0;
  private closed = false;
  private initialAccessibilitySnapshotValue = "";
  private initialScreenshotValue: BrowserScreenshot | null = null;

  private constructor(
    private readonly client: Client,
    private readonly pageId: number,
  ) {}

  get initialAccessibilitySnapshot(): string {
    return this.initialAccessibilitySnapshotValue;
  }

  get initialScreenshot(): BrowserScreenshot | null {
    return this.initialScreenshotValue;
  }

  static async attach(
    debuggingPort: number,
    pageUrl: string,
  ): Promise<ChromeDevToolsMcpInspector> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        serverEntryPath,
        `--browser-url=http://127.0.0.1:${debuggingPort}`,
        "--headless",
        "--no-usage-statistics",
        "--screenshotMaxWidth=1400",
        "--screenshotMaxHeight=7000",
      ],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client(
      { name: "web-site-image-fetcher", version: "0.1.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const pages = await client.callTool({ name: "list_pages", arguments: {} });
      if (!hasContent(pages)) throw new Error("Chrome DevTools MCP returned no page list.");
      const pageText = textContent(pages);
      const pageId = ChromeDevToolsMcpInspector.findPageId(pageText, pageUrl);
      const inspector = new ChromeDevToolsMcpInspector(client, pageId);
      inspector.toolNames = ["list_pages"];
      inspector.initialAccessibilitySnapshotValue = await inspector.takeAccessibilitySnapshot();
      inspector.initialScreenshotValue = await inspector.takeScreenshot(false);
      return inspector;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async takeAccessibilitySnapshot(): Promise<string> {
    const result = await this.callTextTool("take_snapshot", {
      pageId: this.pageId,
      verbose: false,
    });
    return result.slice(0, 30_000);
  }

  async takeScreenshot(fullPage: boolean): Promise<BrowserScreenshot> {
    const filePath = join(tmpdir(), `web-site-image-fetcher-${randomUUID()}.jpeg`);
    const result = await this.callTool("take_screenshot", {
      pageId: this.pageId,
      fullPage,
      format: "jpeg",
      quality: 68,
      filePath,
    });
    try {
      const screenshot = result.content.find(
        (item): item is { type: "image"; data: string; mimeType: string } =>
          item.type === "image" &&
          typeof item.data === "string" &&
          typeof item.mimeType === "string",
      );
      const imageBytes = screenshot
        ? Buffer.from(screenshot.data, "base64")
        : await readFile(filePath);
      this.screenshotCount += 1;
      return {
        mimeType: screenshot?.mimeType ?? "image/jpeg",
        base64Data: imageBytes.toString("base64"),
      };
    } finally {
      await rm(filePath, { force: true }).catch(() => undefined);
    }
  }

  async inspectDom(keyword: string): Promise<string> {
    const literal = encodedLiteral(keyword);
    const script = `() => {
      const keyword = ${literal}.normalize("NFKC").toLocaleLowerCase();
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const textElements = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading],p,li,figcaption")]
        .filter(visible)
        .map((element, order) => ({
          element,
          order,
          text: (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 1000),
          rect: element.getBoundingClientRect(),
        }))
        .filter((entry) => entry.text);
      const matches = textElements.filter((entry) => entry.text.normalize("NFKC").toLocaleLowerCase().includes(keyword));
      const selected = new Set();
      for (const match of matches) {
        for (let offset = -2; offset <= 3; offset += 1) {
          const nearby = textElements[match.order + offset];
          if (nearby) selected.add(nearby);
        }
      }
      const text = (matches.length ? [...selected] : textElements.slice(0, 30)).map(({ element, order, text, rect }) => ({
        order,
        tag: element.tagName.toLowerCase(),
        text,
        x: Math.round(rect.left + scrollX),
        y: Math.round(rect.top + scrollY),
        groupText: (element.closest("figure,li,[role=listitem],section")?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 1200),
      }));
      const images = [...document.images].filter(visible).map((image, order) => {
        const rect = image.getBoundingClientRect();
        return {
          order,
          src: image.currentSrc || image.src || image.getAttribute("data-src") || "",
          alt: image.alt || "",
          title: image.title || "",
          caption: image.closest("figure")?.querySelector("figcaption")?.innerText || "",
          groupText: (image.closest("figure,li,[role=listitem],section")?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 800),
          x: Math.round(rect.left + scrollX),
          y: Math.round(rect.top + scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }).slice(0, 80);
      return JSON.stringify({ title: document.title, url: location.href, matchingTextCount: matches.length, text, images });
    }`;
    return this.callTextTool("evaluate_script", {
      pageId: this.pageId,
      function: script,
      waitForStableDom: false,
    }).then((result) => result.slice(0, 30_000));
  }

  async scrollToText(text: string): Promise<string> {
    const literal = encodedLiteral(text);
    const script = `async () => {
      const target = ${literal}.normalize("NFKC").toLocaleLowerCase();
      const elements = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading],p,li,figcaption")];
      const element = elements.find((item) => (item.innerText || item.textContent || "").normalize("NFKC").toLocaleLowerCase().includes(target));
      if (!element) return JSON.stringify({ found: false, requestedText: ${literal} });
      element.scrollIntoView({ block: "center", behavior: "instant" });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = element.getBoundingClientRect();
      return JSON.stringify({ found: true, text: (element.innerText || element.textContent || "").trim().slice(0, 500), x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY) });
    }`;
    return this.callTextTool("evaluate_script", {
      pageId: this.pageId,
      function: script,
      waitForStableDom: false,
    });
  }

  async listImageRequests(): Promise<string> {
    const result = await this.callTextTool("list_network_requests", {
      pageId: this.pageId,
      pageSize: 80,
      pageIdx: 0,
      resourceTypes: ["image"],
      includePreservedRequests: true,
    });
    return result.slice(0, 20_000);
  }

  recordModelToolCall(name: string): void {
    this.modelToolNames.push(name);
  }

  getDiagnostics(): BrowserInspectionDiagnostics {
    return {
      available: !this.closed,
      toolCallCount: this.toolNames.length,
      toolNames: [...this.toolNames],
      modelToolCallCount: this.modelToolNames.length,
      modelToolNames: [...this.modelToolNames],
      failedToolCallCount: this.failedToolCallCount,
      screenshotCount: this.screenshotCount,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close().catch(() => undefined);
  }

  private async callTextTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.callTool(name, args);
    return textContent(result);
  }

  private async callTool(name: string, args: Record<string, unknown>) {
    if (this.closed) throw new Error("The browser inspection session has already closed.");
    this.toolNames.push(name);
    try {
      const result = await this.client.callTool({ name, arguments: args });
      if (!hasContent(result) || result.isError) {
        throw new Error(`Chrome DevTools MCP tool ${name} failed.`);
      }
      return result;
    } catch (error) {
      this.failedToolCallCount += 1;
      throw error;
    }
  }

  private static findPageId(pageList: string, pageUrl: string): number {
    const matchingLine = pageList
      .split("\n")
      .find((line) => line.includes(`(${pageUrl})`));
    const pageId = Number(matchingLine?.match(/^\s*(\d+):/u)?.[1]);
    if (!Number.isSafeInteger(pageId) || pageId < 1) {
      throw new Error("Chrome DevTools MCP could not find the rendered page.");
    }
    return pageId;
  }
}
