export type ExtractPageInputData = {
  url: string;
};

export type ExtractedImageOutput = {
  imageUrl: string;
  confidence: number;
  model: string;
  evidence: {
    imageNodeId: string;
    imageDomPath: string;
    sourceNodeIds: string[];
    sourceTexts: string[];
    sourceDomPaths: string[];
    candidateScore: number;
    sameContainer: boolean;
    sameSection: boolean;
    domDistance: number;
    visualDistancePx: number;
    caption: string;
    alt: string;
    rationale: string;
  };
};

export type CandidateVerificationAttemptOutput = {
  model: string;
  matches: boolean;
  confidence: number;
  rationale: string;
};

export type ImageCandidateDiagnosticOutput = {
  imageUrl: string;
  candidateScore: number;
  pairingEvidence: {
    sameContainer: boolean;
    sameSection: boolean;
    domDistance: number;
    visualDistancePx: number;
    captionMatchesLocation: boolean;
    altMatchesLocation: boolean;
  };
  alt: string;
  caption: string;
  outcome:
    | "CONFIRMED"
    | "REJECTED"
    | "BELOW_CONFIDENCE_THRESHOLD"
    | "BELOW_CANDIDATE_SCORE";
  attempts: CandidateVerificationAttemptOutput[];
};

export type LocationImageFailureOutput = {
  code:
    | "NO_IMAGE_CANDIDATES"
    | "MODEL_ABSTAINED"
    | "BELOW_CONFIDENCE_THRESHOLD"
    | "INVALID_IMAGE_REFERENCE";
  message: string;
};

export type LocationExtractionIssueOutput = {
  name: string | null;
  sourceNodeIds: string[];
  sourceTexts: string[];
  reason: string;
};

export type ExtractedLocationOutput = {
  name: string;
  address: string | null;
  status: "CONFIRMED" | "UNKNOWN";
  confidence: number | null;
  mappingRationale: string;
  invalidImageNodeIds: string[];
  images: ExtractedImageOutput[];
  candidateDiagnostics: ImageCandidateDiagnosticOutput[];
  imageFailure: LocationImageFailureOutput | null;
};

export type ExtractPageOutputData = {
  page: {
    requestedUrl: string;
    finalUrl: string;
    title: string;
  };
  locations: ExtractedLocationOutput[];
  diagnostics: {
    textNodeCount: number;
    imageCount: number;
    pageCapture: {
      discoveredContentNodeCount: number;
      capturedContentNodeCount: number;
      omittedContentNodeCount: number;
    };
    browserInspection: {
      available: boolean;
      toolCallCount: number;
      toolNames: string[];
      modelToolCallCount: number;
      modelToolNames: string[];
      failedToolCallCount: number;
      screenshotCount: number;
      failureReason: string | null;
      mappingScreenshotMode: "FULL_PAGE" | "VIEWPORT_FALLBACK" | "UNAVAILABLE";
      mappingScreenshotFallbackReason: string | null;
    };
    extractedLocationCount: number;
    confirmedPairCount: number;
    locationExtractionInput: {
      sourceNodeCount: number;
      sentNodeCount: number;
      uniqueSentNodeCount: number;
      omittedNodeCount: number;
      sentCharacterCount: number;
      maxBatchCharacterCount: number;
      batchCount: 1;
      reachedCharacterLimit: boolean;
      sourceImageCount: number;
      sentImageCount: number;
      omittedImageCount: number;
      screenshotIncluded: boolean;
      screenshotBytes: number;
      accessibilitySnapshotIncluded: boolean;
    };
    headingDiagnostics: {
      sourceNodeId: string;
      heading: string;
      classification: "EXTRACTED" | "NOT_LOCATION" | "UNRESOLVED";
      reason: string;
    }[];
    unresolvedLocationCandidates: LocationExtractionIssueOutput[];
    unsupportedLocationReferences: LocationExtractionIssueOutput[];
    confidenceIsCalibrated: false;
    confidenceNote: string;
  };
};
