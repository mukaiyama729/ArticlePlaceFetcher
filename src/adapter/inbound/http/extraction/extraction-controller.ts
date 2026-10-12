import type { ExtractPageUseCase } from "../../../../application/extract-page/port/in/extract-page-use-case.js";
import type { ExtractPageRequest } from "./extract-page-request.schema.js";

export class ExtractionController {
  constructor(private readonly extractPageUseCase: ExtractPageUseCase) {}

  async execute(request: ExtractPageRequest): Promise<void> {
    await this.extractPageUseCase.execute({ url: request.url });
  }
}
