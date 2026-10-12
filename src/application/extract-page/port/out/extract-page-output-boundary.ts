import type { ExtractPageOutputData } from "../../dto/extract-page.dto.js";

export interface ExtractPageOutputBoundary {
  presentExtracted(output: ExtractPageOutputData): void;
}
