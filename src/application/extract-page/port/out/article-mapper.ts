import type {
  ContentNode,
  ImageNode,
} from "../../../../domain/extraction/page-snapshot.js";
import type { Location } from "../../../../domain/extraction/location.js";
import type { BrowserScreenshot } from "./browser-inspection-session.js";

export type ArticleImageMatch = {
  imageNodeId: string;
  confidence: number;
  rationale: string;
};

export type MappedLocation = Location & {
  imageMatches: ArticleImageMatch[];
  mappingRationale: string;
  invalidImageNodeIds: string[];
};

export type ArticleMappingInput = {
  pageTitle: string;
  pageUrl: string;
  contentNodes: ContentNode[];
  images: ImageNode[];
  screenshot: BrowserScreenshot | null;
  accessibilitySnapshot: string;
};

export type ArticleMappingResult = {
  model: string;
  locations: MappedLocation[];
  unresolvedCandidates: {
    name: string | null;
    sourceNodeIds: string[];
    reason: string;
  }[];
  headingDiagnostics: {
    sourceNodeId: string;
    heading: string;
    classification: "EXTRACTED" | "NOT_LOCATION" | "UNRESOLVED";
    reason: string;
  }[];
  inputDiagnostics: {
    sourceNodeCount: number;
    sentNodeCount: number;
    uniqueSentNodeCount: number;
    omittedNodeCount: number;
    sourceImageCount: number;
    sentImageCount: number;
    omittedImageCount: number;
    sentCharacterCount: number;
    maxBatchCharacterCount: number;
    batchCount: 1;
    reachedCharacterLimit: boolean;
    screenshotIncluded: boolean;
    screenshotBytes: number;
    accessibilitySnapshotIncluded: boolean;
  };
};

export interface ArticleMapper {
  map(input: ArticleMappingInput): Promise<ArticleMappingResult>;
}
