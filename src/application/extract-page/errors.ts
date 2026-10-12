export class TargetUrlRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetUrlRejectedError";
  }
}

export class PageCaptureFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageCaptureFailedError";
  }
}

export class ModelServiceFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelServiceFailedError";
  }
}
