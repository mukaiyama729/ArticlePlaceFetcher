import { Container } from "inversify";
import OpenAI from "openai";
import { ExtractPageInteractor } from "../../application/extract-page/service/extract-page-interactor.js";
import type { ArticleMapper } from "../../application/extract-page/port/out/article-mapper.js";
import type { PageCapture } from "../../application/extract-page/port/out/page-capture.js";
import { ExtractionController } from "../../adapter/inbound/http/extraction/extraction-controller.js";
import { ExtractionHttpPresenter } from "../../adapter/outbound/http/extraction-presenter.js";
import { PlaywrightPageCapture } from "../../adapter/outbound/browser/playwright-page-capture.js";
import { OpenAiArticleMapper } from "../../adapter/outbound/llm/openai-article-mapper.js";
import { loadEnvironment, type Environment } from "../config/environment.js";
import type { ExtractPageRequestContext } from "./request-context/extract-page-request-context.js";
import { TYPES } from "./types.js";

export const environment = loadEnvironment();
export const container = new Container();

container.bind<Environment>(TYPES.Environment).toConstantValue(environment);
container
  .bind<OpenAI>(TYPES.OpenAI)
  .toConstantValue(
    new OpenAI({
      apiKey: environment.OPENAI_API_KEY,
      timeout: 300_000,
      maxRetries: 0,
    }),
  );
container
  .bind<PageCapture>(TYPES.PageCapture)
  .toConstantValue(
    new PlaywrightPageCapture({
      timeoutMs: environment.PAGE_TIMEOUT_MS,
      maxImages: environment.MAX_IMAGES,
      maxContentNodes: environment.MAX_CONTENT_NODES,
      enableChromeDevToolsMcp: environment.ENABLE_CHROME_DEVTOOLS_MCP,
    }),
  );
container
  .bind<ArticleMapper>(TYPES.ArticleMapper)
  .toDynamicValue(
    (context) =>
      new OpenAiArticleMapper(
        context.get<OpenAI>(TYPES.OpenAI),
        environment.MAX_PAGE_TEXT_CHARS,
      ),
  )
  .inSingletonScope();

container
  .bind<ExtractPageRequestContext>(TYPES.ExtractPageRequestContext)
  .toDynamicValue((context) => {
    const presenter = new ExtractionHttpPresenter();
    const interactor = new ExtractPageInteractor(
      context.get<PageCapture>(TYPES.PageCapture),
      context.get<ArticleMapper>(TYPES.ArticleMapper),
      presenter,
      {
        confirmThreshold: environment.CONFIRM_THRESHOLD,
      },
    );

    return {
      controller: new ExtractionController(interactor),
      presenter,
    };
  });
