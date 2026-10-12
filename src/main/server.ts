import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import {
  ModelServiceFailedError,
  PageCaptureFailedError,
  TargetUrlRejectedError,
} from "../application/extract-page/errors.js";
import { extractionRoute } from "../adapter/inbound/http/extraction/extraction-route.js";
import { environment } from "./di/container.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.get("/healthz", (_request, response) => response.status(200).json({ status: "ok" }));
app.use(extractionRoute);

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof TargetUrlRejectedError) {
    response.status(400).json({
      error: { code: "TARGET_URL_REJECTED", message: error.message },
    });
    return;
  }
  if (error instanceof PageCaptureFailedError) {
    response.status(502).json({
      error: { code: "PAGE_CAPTURE_FAILED", message: error.message },
    });
    return;
  }
  if (error instanceof ModelServiceFailedError) {
    response.status(502).json({
      error: {
        code: "MODEL_SERVICE_FAILED",
        message: "The location or image analysis service could not complete the request.",
      },
    });
    return;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.parse.failed"
  ) {
    response.status(400).json({
      error: { code: "INVALID_JSON", message: "Request body must be valid JSON." },
    });
    return;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    response.status(413).json({
      error: { code: "BODY_TOO_LARGE", message: "Request body is too large." },
    });
    return;
  }

  response.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred.",
    },
  });
};

app.use(errorHandler);

app.listen(environment.PORT, environment.HOST, () => {
  console.log(`Image extraction API listening on http://localhost:${environment.PORT}`);
});
