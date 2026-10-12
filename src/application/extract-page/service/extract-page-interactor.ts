import { rankImageCandidates } from "../../../domain/extraction/candidate-scoring.js";
import type { ContentNode, ImageNode, PageSnapshot } from "../../../domain/extraction/page-snapshot.js";
import type { Location } from "../../../domain/extraction/location.js";
import type { BrowserScreenshot } from "../port/out/browser-inspection-session.js";
import { ModelServiceFailedError } from "../errors.js";
import type {
  ExtractPageOutputData,
  ExtractedImageOutput,
  ImageCandidateDiagnosticOutput,
  LocationImageFailureOutput,
  LocationExtractionIssueOutput,
} from "../dto/extract-page.dto.js";
import type { ExtractPageUseCase } from "../port/in/extract-page-use-case.js";
import type { ArticleMapper, MappedLocation } from "../port/out/article-mapper.js";
import type { ExtractPageOutputBoundary } from "../port/out/extract-page-output-boundary.js";
import type { CapturedPage, PageCapture } from "../port/out/page-capture.js";

export type ExtractionPolicy = {
  confirmThreshold: number;
};

const normalize = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\p{S}\s]/gu, "");

const hasTextualSupport = (
  location: Location,
  contentNodes: ContentNode[],
): boolean => {
  const name = normalize(location.name);
  if (!name) return false;
  const sourceIds = new Set(location.sourceNodeIds);
  const sourceText = contentNodes
    .filter((node) => sourceIds.has(node.id))
    .map((node) => normalize(node.text))
    .join(" ");
  if (sourceText.includes(name)) return true;
  const coreName = normalize(
    location.name
      .replace(/[（(][^）)]*[）)]/gu, " ")
      .replace(/【[^】]*】/gu, " ")
      .replace(/\[[^\]]*\]/gu, " "),
  );
  return coreName.length >= 2 && sourceText.includes(coreName);
};

const emptyPairingEvidence = {
  candidateScore: 0,
  sameContainer: false,
  sameSection: false,
  domDistance: -1,
  visualDistancePx: -1,
  captionMatchesLocation: false,
  altMatchesLocation: false,
};

export class ExtractPageInteractor implements ExtractPageUseCase {
  constructor(
    private readonly pageCapture: PageCapture,
    private readonly articleMapper: ArticleMapper,
    private readonly outputBoundary: ExtractPageOutputBoundary,
    private readonly policy: ExtractionPolicy,
  ) {}

  async execute(input: { url: string }): Promise<void> {
    const capturedPage = await this.pageCapture.capture(input.url);
    try {
      await this.extractCapturedPage(capturedPage);
    } finally {
      await capturedPage.close().catch(() => undefined);
    }
  }

  private async extractCapturedPage(capturedPage: CapturedPage): Promise<void> {
    const snapshot = capturedPage.snapshot;
    const browserInspection = capturedPage.browserInspection;
    let screenshot: BrowserScreenshot | null = null;
    let mappingScreenshotMode: "FULL_PAGE" | "VIEWPORT_FALLBACK" | "UNAVAILABLE" =
      "UNAVAILABLE";
    let mappingScreenshotFallbackReason: string | null = null;

    if (browserInspection) {
      try {
        screenshot = await browserInspection.takeScreenshot(true);
        mappingScreenshotMode = "FULL_PAGE";
      } catch (error) {
        mappingScreenshotFallbackReason =
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Chrome DevTools MCPの全ページスクリーンショット取得に失敗しました。";
        screenshot = browserInspection.initialScreenshot;
        mappingScreenshotMode = screenshot ? "VIEWPORT_FALLBACK" : "UNAVAILABLE";
      }
    } else {
      mappingScreenshotFallbackReason = capturedPage.browserInspectionFailure;
    }

    let extraction: Awaited<ReturnType<ArticleMapper["map"]>>;
    try {
      extraction = await this.articleMapper.map({
        pageTitle: snapshot.title,
        pageUrl: snapshot.finalUrl,
        contentNodes: snapshot.contentNodes,
        images: snapshot.images,
        screenshot,
        accessibilitySnapshot: browserInspection?.initialAccessibilitySnapshot ?? "",
      });
    } catch {
      throw new ModelServiceFailedError("The article location and image mapping request failed.");
    }

    const supportedLocations: MappedLocation[] = [];
    const unsupportedLocationReferences: LocationExtractionIssueOutput[] = [];
    for (const location of extraction.locations) {
      if (hasTextualSupport(location, snapshot.contentNodes)) {
        supportedLocations.push(location);
      } else {
        unsupportedLocationReferences.push({
          name: location.name,
          sourceNodeIds: location.sourceNodeIds,
          sourceTexts: snapshot.contentNodes
            .filter((node) => location.sourceNodeIds.includes(node.id))
            .map((node) => node.text),
          reason:
            "モデルが返した拠点名が指定されたsourceNodeIdsの本文に見つからず、ローカル検証で除外されました。",
        });
      }
    }

    const outputLocations = supportedLocations.map((location) =>
      this.toOutputLocation(location, snapshot, extraction.model),
    );

    const toExtractionIssue = (
      candidate: { name: string | null; sourceNodeIds: string[]; reason: string },
    ): LocationExtractionIssueOutput => ({
      ...candidate,
      sourceTexts: snapshot.contentNodes
        .filter((node) => candidate.sourceNodeIds.includes(node.id))
        .map((node) => node.text),
    });
    const browserDiagnostics = browserInspection?.getDiagnostics();

    const output: ExtractPageOutputData = {
      page: {
        requestedUrl: snapshot.requestedUrl,
        finalUrl: snapshot.finalUrl,
        title: snapshot.title,
      },
      locations: outputLocations,
      diagnostics: {
        textNodeCount: snapshot.contentNodes.length,
        imageCount: snapshot.images.length,
        pageCapture: snapshot.captureDiagnostics,
        browserInspection: {
          available: browserDiagnostics?.available ?? false,
          toolCallCount: browserDiagnostics?.toolCallCount ?? 0,
          toolNames: browserDiagnostics?.toolNames ?? [],
          modelToolCallCount: browserDiagnostics?.modelToolCallCount ?? 0,
          modelToolNames: browserDiagnostics?.modelToolNames ?? [],
          failedToolCallCount: browserDiagnostics?.failedToolCallCount ?? 0,
          screenshotCount: browserDiagnostics?.screenshotCount ?? 0,
          failureReason: capturedPage.browserInspectionFailure,
          mappingScreenshotMode,
          mappingScreenshotFallbackReason,
        },
        extractedLocationCount: supportedLocations.length,
        confirmedPairCount: outputLocations.reduce(
          (total, location) => total + location.images.length,
          0,
        ),
        locationExtractionInput: extraction.inputDiagnostics,
        headingDiagnostics: extraction.headingDiagnostics,
        unresolvedLocationCandidates: extraction.unresolvedCandidates.map(toExtractionIssue),
        unsupportedLocationReferences,
        confidenceIsCalibrated: false,
        confidenceNote:
          "Model confidence is an uncalibrated estimate, not a measured probability or precision guarantee.",
      },
    };

    this.outputBoundary.presentExtracted(output);
  }

  private toOutputLocation(
    location: MappedLocation,
    snapshot: PageSnapshot,
    model: string,
  ) {
    const contentNodeIds = new Set(snapshot.contentNodes.map((node) => node.id));
    const imageById = new Map(snapshot.images.map((image) => [image.id, image]));
    const rankedCandidates = rankImageCandidates(
      snapshot,
      location.sourceNodeIds.filter((id) => contentNodeIds.has(id)),
      location.name,
      snapshot.images.length,
    );
    const candidateByImageId = new Map(
      rankedCandidates.map((candidate) => [candidate.image.id, candidate]),
    );
    const assignments = location.imageMatches;
    const invalidImageNodeIds = [...new Set(location.invalidImageNodeIds)];
    const matchedImages: ExtractedImageOutput[] = [];
    const candidateDiagnostics: ImageCandidateDiagnosticOutput[] = [];

    for (const assignment of assignments) {
      const image = imageById.get(assignment.imageNodeId);
      if (!image) {
        invalidImageNodeIds.push(assignment.imageNodeId);
        continue;
      }
      const candidate = candidateByImageId.get(image.id);
      const pairingEvidence = candidate?.evidence ?? emptyPairingEvidence;
      const confirmed = assignment.confidence >= this.policy.confirmThreshold;
      const sourceNodes = snapshot.contentNodes.filter((node) =>
        location.sourceNodeIds.includes(node.id),
      );
      candidateDiagnostics.push({
        imageUrl: image.url,
        candidateScore: pairingEvidence.candidateScore,
        pairingEvidence: {
          sameContainer: pairingEvidence.sameContainer,
          sameSection: pairingEvidence.sameSection,
          domDistance: pairingEvidence.domDistance,
          visualDistancePx: pairingEvidence.visualDistancePx,
          captionMatchesLocation: pairingEvidence.captionMatchesLocation,
          altMatchesLocation: pairingEvidence.altMatchesLocation,
        },
        alt: image.alt,
        caption: image.caption,
        outcome: confirmed ? "CONFIRMED" : "BELOW_CONFIDENCE_THRESHOLD",
        attempts: [
          {
            model,
            matches: true,
            confidence: assignment.confidence,
            rationale: assignment.rationale,
          },
        ],
      });

      if (!confirmed) continue;
      matchedImages.push({
        imageUrl: image.url,
        confidence: assignment.confidence,
        model,
        evidence: {
          imageNodeId: image.id,
          imageDomPath: image.domPath,
          sourceNodeIds: location.sourceNodeIds,
          sourceTexts: sourceNodes.map((node) => node.text),
          sourceDomPaths: sourceNodes.map((node) => node.domPath),
          candidateScore: pairingEvidence.candidateScore,
          sameContainer: pairingEvidence.sameContainer,
          sameSection: pairingEvidence.sameSection,
          domDistance: pairingEvidence.domDistance,
          visualDistancePx: pairingEvidence.visualDistancePx,
          caption: image.caption,
          alt: image.alt,
          rationale: assignment.rationale,
        },
      });
    }

    const uniqueImages = [
      ...new Map(matchedImages.map((image) => [image.imageUrl, image])).values(),
    ];
    const uniqueInvalidIds = [...new Set(invalidImageNodeIds)];
    let imageFailure: LocationImageFailureOutput | null = null;

    if (uniqueImages.length === 0) {
      const rationale = location.mappingRationale || "モデルから説明が返りませんでした。";
      imageFailure =
        snapshot.images.length === 0
          ? {
              code: "NO_IMAGE_CANDIDATES",
              message: "ページから画像を取得できませんでした。拠点に対応する画像を判定できません。",
            }
          : uniqueInvalidIds.length > 0 && assignments.length === 0
            ? {
                code: "INVALID_IMAGE_REFERENCE",
                message: `AIが返した画像IDが取得済み画像に存在しません (${uniqueInvalidIds.join(", ")})。 ${rationale}`,
              }
            : assignments.some((assignment) => assignment.confidence < this.policy.confirmThreshold)
              ? {
                  code: "BELOW_CONFIDENCE_THRESHOLD",
                  message: `AIは画像候補を返しましたが、確信度が採用基準 ${this.policy.confirmThreshold} 未満でした。${rationale}`,
                }
              : {
                  code: "MODEL_ABSTAINED",
                  message: rationale,
                };
    }

    return {
      name: location.name,
      address: location.address,
      status: uniqueImages.length > 0 ? ("CONFIRMED" as const) : ("UNKNOWN" as const),
      confidence:
        uniqueImages.length > 0
          ? Math.max(...uniqueImages.map((image) => image.confidence))
          : null,
      mappingRationale: location.mappingRationale,
      invalidImageNodeIds: uniqueInvalidIds,
      images: uniqueImages,
      candidateDiagnostics,
      imageFailure,
    };
  }
}
