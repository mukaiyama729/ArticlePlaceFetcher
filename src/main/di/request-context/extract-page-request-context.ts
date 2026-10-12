import type { ExtractionController } from "../../../adapter/inbound/http/extraction/extraction-controller.js";
import type { ExtractionHttpPresenter } from "../../../adapter/outbound/http/extraction-presenter.js";

export type ExtractPageRequestContext = {
  controller: ExtractionController;
  presenter: ExtractionHttpPresenter;
};
