import type OpenAI from "openai";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseFunctionCallOutputItemList,
  ResponseTextConfig,
} from "openai/resources/responses/responses.js";
import { z } from "zod";
import type { BrowserInspectionSession } from "../../../application/extract-page/port/out/browser-inspection-session.js";

const MAX_BROWSER_TOOL_CALLS = 6;

const emptyParameters = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

const browserTools: FunctionTool[] = [
  {
    type: "function",
    name: "take_accessibility_snapshot",
    description:
      "Read the current page's Chrome accessibility tree. Use this to confirm headings, captions, and visible page structure.",
    parameters: emptyParameters,
    strict: true,
  },
  {
    type: "function",
    name: "take_page_screenshot",
    description:
      "Capture the current browser viewport, or the full page, as an image. Scroll to the relevant heading first when needed.",
    parameters: {
      type: "object",
      properties: { fullPage: { type: "boolean" } },
      required: ["fullPage"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "inspect_dom_around_text",
    description:
      "Read visible DOM text and image metadata around a keyword, including their rendered coordinates and nearest card text.",
    parameters: {
      type: "object",
      properties: { keyword: { type: "string" } },
      required: ["keyword"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "scroll_to_article_text",
    description:
      "Scroll the rendered article to a visible heading or text fragment so it can be inspected in the next screenshot.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "list_image_network_requests",
    description:
      "Inspect recent image requests and their statuses when an article image appears missing or broken.",
    parameters: emptyParameters,
    strict: true,
  },
];

const InspectArgsSchema = z.object({ keyword: z.string().min(1).max(200) }).strict();
const ScrollArgsSchema = z.object({ text: z.string().min(1).max(300) }).strict();
const ScreenshotArgsSchema = z.object({ fullPage: z.boolean() }).strict();

type BrowserToolOutput = string | ResponseFunctionCallOutputItemList;

export const runWithBrowserTools = async (params: {
  client: OpenAI;
  model: string;
  input: ResponseCreateParamsNonStreaming["input"];
  instructions: string;
  text: ResponseTextConfig;
  browserInspection: BrowserInspectionSession | null | undefined;
}): Promise<Response> => {
  const tools = params.browserInspection ? browserTools : [];
  let response = await params.client.responses.create({
    model: params.model,
    input: params.input,
    instructions: params.instructions,
    text: params.text,
    tools,
  });

  let toolCallCount = 0;
  while (true) {
    const calls = response.output.filter((item) => item.type === "function_call");
    if (calls.length === 0) return response;

    const outputs: ResponseInputItem[] = [];
    for (const call of calls) {
      if (call.type !== "function_call") continue;
      if (!params.browserInspection || toolCallCount >= MAX_BROWSER_TOOL_CALLS) {
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: "The browser inspection tool-call limit has been reached.",
        });
        continue;
      }

      toolCallCount += 1;
      params.browserInspection.recordModelToolCall(call.name);
      let output: BrowserToolOutput;
      try {
        output = await executeBrowserTool(
          params.browserInspection,
          call.name,
          call.arguments,
        );
      } catch (error) {
        output = `Browser inspection failed: ${error instanceof Error ? error.message : "unknown error"}`;
      }
      outputs.push({ type: "function_call_output", call_id: call.call_id, output });
    }

    response = await params.client.responses.create({
      model: params.model,
      previous_response_id: response.id,
      input: outputs,
      instructions: params.instructions,
      text: params.text,
      tools,
      tool_choice: toolCallCount >= MAX_BROWSER_TOOL_CALLS ? "none" : "auto",
    });
  }
};

const executeBrowserTool = async (
  browser: BrowserInspectionSession,
  name: string,
  rawArguments: string,
): Promise<BrowserToolOutput> => {
  const argumentsValue: unknown = JSON.parse(rawArguments);
  switch (name) {
    case "take_accessibility_snapshot":
      return await browser.takeAccessibilitySnapshot();
    case "take_page_screenshot": {
      const { fullPage } = ScreenshotArgsSchema.parse(argumentsValue);
      const screenshot = await browser.takeScreenshot(fullPage);
      return [
        { type: "input_text", text: `Chrome DevTools MCP screenshot (${fullPage ? "full page" : "viewport"}).` },
        {
          type: "input_image",
          image_url: `data:${screenshot.mimeType};base64,${screenshot.base64Data}`,
          detail: "high",
        },
      ];
    }
    case "inspect_dom_around_text": {
      const { keyword } = InspectArgsSchema.parse(argumentsValue);
      return await browser.inspectDom(keyword);
    }
    case "scroll_to_article_text": {
      const { text } = ScrollArgsSchema.parse(argumentsValue);
      return await browser.scrollToText(text);
    }
    case "list_image_network_requests":
      return await browser.listImageRequests();
    default:
      return `Unsupported browser tool: ${name}`;
  }
};
