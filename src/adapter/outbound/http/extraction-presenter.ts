import type { ExtractPageOutputData } from "../../../application/extract-page/dto/extract-page.dto.js";
import type { ExtractPageOutputBoundary } from "../../../application/extract-page/port/out/extract-page-output-boundary.js";

export type ExtractionHttpResult = {
  statusCode: number;
  body: ExtractPageOutputData;
};

export class ExtractionHttpPresenter implements ExtractPageOutputBoundary {
  private resultValue: ExtractionHttpResult | null = null;

  get result(): ExtractionHttpResult {
    if (!this.resultValue) {
      throw new Error("The extraction presenter has no result yet.");
    }
    return this.resultValue;
  }

  presentExtracted(output: ExtractPageOutputData): void {
    this.resultValue = { statusCode: 200, body: output };
  }
}
