import { Router } from "express";
import { container } from "../../../../main/di/container.js";
import { TYPES } from "../../../../main/di/types.js";
import type { ExtractPageRequestContext } from "../../../../main/di/request-context/extract-page-request-context.js";
import { extractPageRequestSchema } from "./extract-page-request.schema.js";

export const extractionRoute = Router();

extractionRoute.post("/extractions", async (request, response, next) => {
  const parsed = extractPageRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Body must contain a valid http(s) URL in the url field.",
      },
    });
    return;
  }

  try {
    const context = container.get<ExtractPageRequestContext>(
      TYPES.ExtractPageRequestContext,
    );
    await context.controller.execute(parsed.data);
    const result = context.presenter.result;
    response.status(result.statusCode).json(result.body);
  } catch (error) {
    next(error);
  }
});
