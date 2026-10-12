import { chromium, type Browser } from "playwright";
import { createServer } from "node:net";
import {
  PageCaptureFailedError,
  TargetUrlRejectedError,
} from "../../../application/extract-page/errors.js";
import type {
  CapturedPage,
  PageCapture,
} from "../../../application/extract-page/port/out/page-capture.js";
import type { PageSnapshot } from "../../../domain/extraction/page-snapshot.js";
import { ChromeDevToolsMcpInspector } from "./chrome-devtools-mcp-inspector.js";
import { assertPublicHttpUrl } from "./target-url-policy.js";

export type PageCaptureConfig = {
  timeoutMs: number;
  maxImages: number;
  maxContentNodes: number;
  enableChromeDevToolsMcp: boolean;
};

type CapturedBrowserData = {
  finalUrl: string;
  title: string;
  discoveredContentNodeCount: number;
  contentNodes: PageSnapshot["contentNodes"];
  images: PageSnapshot["images"];
};

export class PlaywrightPageCapture implements PageCapture {
  private browserPromise: Promise<Browser> | null = null;
  private debuggingPort: number | null = null;

  constructor(private readonly config: PageCaptureConfig) {}

  async capture(url: string): Promise<CapturedPage> {
    const hostCache = new Map<string, Promise<void>>();
    const target = await assertPublicHttpUrl(url, hostCache);
    let browser: Browser;
    let debuggingPort: number;
    try {
      browser = await this.getBrowser();
      if (this.debuggingPort === null) throw new Error("Chrome DevTools port is unavailable.");
      debuggingPort = this.debuggingPort;
    } catch {
      throw new PageCaptureFailedError(
        "Chromium could not be started. Install the Playwright Chromium browser before running the service.",
      );
    }
    const context = await browser.newContext({
      javaScriptEnabled: true,
      ignoreHTTPSErrors: false,
      serviceWorkers: "block",
    });
    await context.route("**/*", async (route) => {
      try {
        await assertPublicHttpUrl(route.request().url(), hostCache);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient").catch(() => undefined);
      }
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(this.config.timeoutMs);
    page.setDefaultTimeout(this.config.timeoutMs);

    let browserInspection: ChromeDevToolsMcpInspector | null = null;
    try {
      await page.goto(target.href, {
        waitUntil: "domcontentloaded",
        timeout: this.config.timeoutMs,
      });
      await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
      await this.loadLazyContent(page);

      const captureFunction = ({ maxImages, maxContentNodes }: {
        maxImages: number;
        maxContentNodes: number;
      }) => {
          const ids = new WeakMap<Element, string>();
          let nextId = 1;
          function getId(element: Element): string {
            let id = ids.get(element);
            if (!id) {
              id = `n${nextId++}`;
              ids.set(element, id);
            }
            return id;
          }

          function getCard(element: Element): Element | null {
            let current: Element | null = element;
            while (current && current !== document.body) {
              const tag = current.tagName.toLowerCase();
              const role = current.getAttribute("role") ?? "";
              const classes = current.getAttribute("class") ?? "";
              if (
                tag === "figure" ||
                tag === "li" ||
                role === "listitem" ||
                /(?:^|[\s_-])(card|spot|location|place|shop|store|restaurant|facility|slide|item)(?:$|[\s_-])/iu.test(
                  classes,
                )
              ) {
                return current;
              }
              current = current.parentElement;
            }
            return null;
          }
          // <article> often wraps the entire page, so it is too broad to be
          // useful as evidence that a nearby image belongs to one location.
          function getSection(element: Element): Element | null {
            return element.closest("section, [role='region']");
          }
          function boxOf(element: Element) {
            const rect = element.getBoundingClientRect();
            return {
              x: Math.round(rect.left + window.scrollX),
              y: Math.round(rect.top + window.scrollY),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          }
          function domPathOf(element: Element): string {
            const segments: string[] = [];
            let current: Element | null = element;
            while (current && current !== document.documentElement) {
              const tag = current.tagName.toLowerCase();
              let index = 1;
              let sibling = current.previousElementSibling;
              while (sibling) {
                if (sibling.tagName === current.tagName) index += 1;
                sibling = sibling.previousElementSibling;
              }
              segments.unshift(`${tag}:nth-of-type(${index})`);
              current = current.parentElement;
            }
            return `/${segments.join("/")}`;
          }
          function isVisible(element: Element): boolean {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity) !== 0 &&
              rect.width > 0 &&
              rect.height > 0
            );
          }
          const articleRootCandidates = Array.from(
            document.querySelectorAll(
              "[itemprop='articleBody'],article,main,[role='main'],[class*='article-body'],[class*='article-content'],[class*='entry-content'],[class*='post-content']",
            ),
          ).filter(isVisible);
          const articleRoot = articleRootCandidates
            .map((element) => {
              const textLength = (element.textContent ?? "").trim().length;
              const headingCount = element.querySelectorAll(
                "h1,h2,h3,h4,h5,h6,[role='heading']",
              ).length;
              const paragraphCount = element.querySelectorAll("p,li,blockquote").length;
              const imageCount = element.querySelectorAll("img").length;
              const tag = element.tagName.toLowerCase();
              const attributes = `${element.id} ${element.getAttribute("class") ?? ""} ${element.getAttribute("itemprop") ?? ""}`.toLowerCase();
              const semanticWeight =
                element.getAttribute("itemprop") === "articleBody"
                  ? 100
                  : tag === "article"
                    ? 75
                    : /article[-_ ]?(body|content)|entry[-_ ]?content|post[-_ ]?content/u.test(attributes)
                      ? 45
                      : 10;
              const score =
                semanticWeight +
                Math.min(headingCount, 40) * 12 +
                Math.min(paragraphCount, 80) +
                Math.min(imageCount, 100) * 2 +
                Math.min(textLength, 40_000) / 400;
              return { element, score, textLength, headingCount };
            })
            .filter((candidate) => candidate.textLength >= 800 && candidate.headingCount >= 3)
            .sort((left, right) => right.score - left.score)[0]?.element ?? null;
          const isInArticleRoot = (element: Element): boolean =>
            !articleRoot || articleRoot.contains(element);
          const textElements = Array.from(
            document.querySelectorAll(
              "h1,h2,h3,h4,h5,h6,[role='heading'],p,li,figcaption,blockquote,dt,dd,[itemprop='name']",
            ),
          ).filter((element) => isVisible(element) && isInArticleRoot(element));
          const imageElements = Array.from(document.images).filter(
            (image) => isVisible(image) && isInArticleRoot(image),
          );
          const orderedElements = [...new Set<Element>([...textElements, ...imageElements])].sort(
            (left, right) => {
              if (left === right) return 0;
              return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING
                ? -1
                : 1;
            },
          );
          const orders = new Map(orderedElements.map((element, index) => [element, index]));

          const allContentNodes = textElements
            .map((element) => {
              const text = (element.textContent ?? "").replace(/\s+/gu, " ").trim();
              if (!text || text.length > 1_500) return null;
              const tag = element.tagName.toLowerCase();
              const kind: "heading" | "text" | "caption" =
                /^h[1-6]$/u.test(tag) || element.getAttribute("role") === "heading"
                ? "heading"
                : tag === "figcaption"
                  ? "caption"
                  : "text";
              return {
                id: getId(element),
                kind,
                tag,
                domPath: domPathOf(element),
                text,
                order: orders.get(element) ?? 0,
                groupId: getCard(element) ? getId(getCard(element)!) : null,
                sectionId: getSection(element) ? getId(getSection(element)!) : null,
                box: boxOf(element),
              };
            })
            .filter((node): node is NonNullable<typeof node> => node !== null);
          function sampleEvenly<T>(items: T[], limit: number): T[] {
            if (items.length <= limit) return items;
            if (limit <= 1) return items.length > 0 ? [items[0]!] : [];
            return Array.from({ length: limit }, (_, index) =>
              items[Math.round((index * (items.length - 1)) / (limit - 1))]!,
            );
          }
          const headingNodes = allContentNodes.filter((node) => node.kind === "heading");
          const captionNodes = allContentNodes.filter((node) => node.kind === "caption");
          const textNodes = allContentNodes.filter((node) => node.kind === "text");
          const selectedHeadingNodes = sampleEvenly(headingNodes, maxContentNodes);
          const selectedCaptionNodes = sampleEvenly(
            captionNodes,
            Math.max(0, maxContentNodes - selectedHeadingNodes.length),
          );
          const selectedStructuralNodes = [...selectedHeadingNodes, ...selectedCaptionNodes];
          const selectedTextNodes =
            selectedStructuralNodes.length >= maxContentNodes
              ? []
              : sampleEvenly(textNodes, maxContentNodes - selectedStructuralNodes.length);
          const contentNodes = [...selectedStructuralNodes, ...selectedTextNodes].sort(
            (left, right) => left.order - right.order,
          );

          const images = imageElements
            .map((image) => {
              const lazySources = [
                image.getAttribute("data-src"),
                image.getAttribute("data-lazy-src"),
                image.getAttribute("data-original"),
                image.getAttribute("data-srcset")?.trim().split(/\s+/u)[0],
              ].filter((source): source is string => Boolean(source));
              const srcsetSource = image
                .getAttribute("srcset")
                ?.split(",")[0]
                ?.trim()
                .split(/\s+/u)[0];
              const standardSources = [image.currentSrc, image.getAttribute("src"), srcsetSource]
                .filter((source): source is string => Boolean(source));
              const rawSources =
                image.naturalWidth > 1
                  ? [...standardSources, ...lazySources]
                  : [...lazySources, ...standardSources];
              let resolvedUrl: URL | null = null;
              for (const rawSource of rawSources) {
                try {
                  const candidateUrl = new URL(rawSource, location.href);
                  if (candidateUrl.protocol === "http:" || candidateUrl.protocol === "https:") {
                    resolvedUrl = candidateUrl;
                    break;
                  }
                } catch {
                  // Try the next lazy-load or source-set attribute.
                }
              }
              if (!resolvedUrl) return null;

              const figure = image.closest("figure");
              const caption = figure?.querySelector("figcaption")?.textContent ?? "";
              const card = getCard(image);
              const section = getSection(image);
              return {
                id: getId(image),
                domPath: domPathOf(image),
                url: resolvedUrl.href,
                srcset:
                  image.getAttribute("srcset") ??
                  image.getAttribute("data-srcset") ??
                  "",
                alt: (image.getAttribute("alt") ?? "").trim().slice(0, 500),
                title: (image.getAttribute("title") ?? "").trim().slice(0, 300),
                caption: caption.replace(/\s+/gu, " ").trim().slice(0, 500),
                order: orders.get(image) ?? 0,
                groupId: card ? getId(card) : null,
                sectionId: section ? getId(section) : null,
                box: boxOf(image),
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
              };
            })
            .filter((image): image is NonNullable<typeof image> => image !== null)
            .slice(0, maxImages);

          return {
            finalUrl: location.href,
            title: document.title.trim(),
            discoveredContentNodeCount: allContentNodes.length,
            contentNodes,
            images,
          };
      };
      // tsx's keep-names transform can add Node-only __name() calls inside
      // browser callbacks. Serialize and remove those annotations before eval.
      const captureFunctionSource = captureFunction
        .toString()
        .replace(/(=>\s*\{)/u, "$1const __name=(value)=>value;")
        .replace(/__name\([A-Za-z_$][\w$]*,\s*["'][^"']+["']\);?/gu, "");
      const captured = (await page.evaluate(
        `(${captureFunctionSource})(${JSON.stringify({
          maxImages: this.config.maxImages,
          maxContentNodes: this.config.maxContentNodes,
        })})`,
      )) as CapturedBrowserData;

      if (captured.contentNodes.length === 0) {
        throw new PageCaptureFailedError("No visible article text was found on the page.");
      }

      let browserInspectionFailure: string | null = null;
      if (this.config.enableChromeDevToolsMcp) {
        try {
          browserInspection = await ChromeDevToolsMcpInspector.attach(
            debuggingPort,
            captured.finalUrl,
          );
        } catch (error) {
          browserInspectionFailure =
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Chrome DevTools MCP could not inspect the rendered page.";
        }
      } else {
        browserInspectionFailure = "Chrome DevTools MCP is disabled by configuration.";
      }

      const snapshot: PageSnapshot = {
          requestedUrl: target.href,
          finalUrl: captured.finalUrl,
          title: captured.title,
          contentNodes: captured.contentNodes,
          images: captured.images,
          captureDiagnostics: {
            discoveredContentNodeCount: captured.discoveredContentNodeCount,
            capturedContentNodeCount: captured.contentNodes.length,
            omittedContentNodeCount: Math.max(
              0,
              captured.discoveredContentNodeCount - captured.contentNodes.length,
            ),
          },
      };

      return {
        snapshot,
        browserInspection,
        browserInspectionFailure,
        close: async () => {
          await browserInspection?.close();
          await context.close();
        },
      };
    } catch (error) {
      if (process.env.NODE_ENV !== "production") {
        console.error("Page capture failed", error);
      }
      await browserInspection?.close();
      await context.close().catch(() => undefined);
      if (error instanceof TargetUrlRejectedError || error instanceof PageCaptureFailedError) {
        throw error;
      }
      throw new PageCaptureFailedError(
        "The page could not be rendered or its visible content could not be read.",
      );
    }
  }

  private async loadLazyContent(page: import("playwright").Page): Promise<void> {
    await page.evaluate(async () => {
      document.querySelectorAll<HTMLImageElement>("img[loading='lazy']").forEach((image) => {
        image.loading = "eager";
      });
      let previousHeight = 0;
      for (let step = 0; step < 32; step += 1) {
        const height = document.documentElement.scrollHeight;
        window.scrollBy(0, Math.max(window.innerHeight * 0.85, 500));
        await new Promise<void>((resolve) => window.setTimeout(resolve, 180));
        const currentHeight = document.documentElement.scrollHeight;
        if (window.scrollY + window.innerHeight >= currentHeight && currentHeight === previousHeight) {
          break;
        }
        previousHeight = currentHeight;
      }
      window.scrollTo(0, 0);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
    });
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = this.launchBrowser();
    }
    return this.browserPromise;
  }

  private async launchBrowser(): Promise<Browser> {
    this.debuggingPort = await getAvailablePort();
    return chromium.launch({
      headless: true,
      args: [
        `--remote-debugging-port=${this.debuggingPort}`,
        "--remote-debugging-address=127.0.0.1",
      ],
    });
  }
}

const getAvailablePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local Chrome DevTools port.");
  }
  return address.port;
};
