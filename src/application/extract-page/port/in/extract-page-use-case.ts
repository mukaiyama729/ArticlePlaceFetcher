import type { ExtractPageInputData } from "../../dto/extract-page.dto.js";

export interface ExtractPageUseCase {
  execute(input: ExtractPageInputData): Promise<void>;
}
