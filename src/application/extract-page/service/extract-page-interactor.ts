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

// LOGIC.md「4. モデル出力をローカルで検査する」：表記ゆれを吸収して本文中の拠点名を照合できるよう正規化する。
const normalize = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\p{S}\s]/gu, "");

// LOGIC.md「4. モデル出力をローカルで検査する」：AIが指定した本文ノードを根拠に拠点名を照合する。
// 括弧書きなどの補足を除いた名称でも照合し、根拠のない候補は後段で除外する。
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

// LOGIC.md「4. 画像confidenceと候補スコア」：順位付け結果に該当画像がない場合の診断用既定値。
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
    // LOGIC.md「1. ページを描画して根拠を採取する」：URLからページ情報を取得し、成功・失敗を問わず資源を閉じる。
    const capturedPage = await this.pageCapture.capture(input.url);
    try {
      await this.extractCapturedPage(capturedPage);
    } finally {
      await capturedPage.close().catch(() => undefined);
    }
  }

  private async extractCapturedPage(capturedPage: CapturedPage): Promise<void> {
    // LOGIC.md「1. ページを描画して根拠を採取する」：取得済みDOM情報と任意のブラウザー検査結果を抽出に使う。
    const snapshot = capturedPage.snapshot;
    const browserInspection = capturedPage.browserInspection;
    let screenshot: BrowserScreenshot | null = null;
    let mappingScreenshotMode: "FULL_PAGE" | "VIEWPORT_FALLBACK" | "UNAVAILABLE" =
      "UNAVAILABLE";
    let mappingScreenshotFallbackReason: string | null = null;

    if (browserInspection) {
      try {
        // LOGIC.md「1. ページを描画して根拠を採取する」：全ページ画像を試し、失敗時は初期表示範囲へ切り替える。
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
      // LOGIC.md「1. ページを描画して根拠を採取する」：ブラウザー検査が使えなかった理由を診断として返す。
      mappingScreenshotFallbackReason = capturedPage.browserInspectionFailure;
    }

    let extraction: Awaited<ReturnType<ArticleMapper["map"]>>;
    try {
      // LOGIC.md「2. GPT-6 Lunaへ渡す内容」「3. Lunaに求める出力」：ページ情報をAIへ渡して拠点と画像の対応候補を得る。
      extraction = await this.articleMapper.map({
        pageTitle: snapshot.title,
        pageUrl: snapshot.finalUrl,
        contentNodes: snapshot.contentNodes,
        images: snapshot.images,
        screenshot,
        accessibilitySnapshot: browserInspection?.initialAccessibilitySnapshot ?? "",
      });
    } catch {
      // LOGIC.md「全体フロー」のモデル判定段階：外部モデルの失敗をアプリケーション層のエラーとして伝える。
      throw new ModelServiceFailedError("The article location and image mapping request failed.");
    }

    // LOGIC.md「4. モデル出力をローカルで検査する」：AIが抽出した拠点名が指定本文にあるか再確認する。
    // 根拠が見つからない候補は出力対象から外し、理由と参照本文を診断用に残す。
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

    // LOGIC.md「4. 画像confidenceと候補スコア」：検証済み拠点ごとに画像の採否・根拠・失敗理由を組み立てる。
    const outputLocations = supportedLocations.map((location) =>
      this.toOutputLocation(location, snapshot, extraction.model),
    );

    // LOGIC.md「5. 最終レスポンスで確認できる項目」：未解決候補に参照本文を添えて根拠を追跡できるようにする。
    const toExtractionIssue = (
      candidate: { name: string | null; sourceNodeIds: string[]; reason: string },
    ): LocationExtractionIssueOutput => ({
      ...candidate,
      sourceTexts: snapshot.contentNodes
        .filter((node) => candidate.sourceNodeIds.includes(node.id))
        .map((node) => node.text),
    });
    const browserDiagnostics = browserInspection?.getDiagnostics();

    // LOGIC.md「5. 最終レスポンスで確認できる項目」：抽出結果とページ取得・ブラウザー検査などの診断情報をまとめる。
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
    // LOGIC.md「4. 画像confidenceと候補スコア」：本文根拠に近い画像を順位付けし、AIの画像IDを取得済み画像と照合する。
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
      // LOGIC.md「4. モデル出力をローカルで検査する」：AIの画像IDが取得済み画像にない場合は不正参照として記録する。
      const image = imageById.get(assignment.imageNodeId);
      if (!image) {
        invalidImageNodeIds.push(assignment.imageNodeId);
        continue;
      }
      const candidate = candidateByImageId.get(image.id);
      const pairingEvidence = candidate?.evidence ?? emptyPairingEvidence;
      // LOGIC.md「4. 画像confidenceと候補スコア」：閾値以上の画像だけを採用し、それ以外も診断には残す。
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
      // LOGIC.md「5. 最終レスポンスで確認できる項目」：採用画像に本文・DOM位置・候補スコアなどの根拠を付ける。
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

    // LOGIC.md「5. 最終レスポンスで確認できる項目」：同じ画像URLが重複して出力されないように整理する。
    const uniqueImages = [
      ...new Map(matchedImages.map((image) => [image.imageUrl, image])).values(),
    ];
    const uniqueInvalidIds = [...new Set(invalidImageNodeIds)];
    let imageFailure: LocationImageFailureOutput | null = null;

    if (uniqueImages.length === 0) {
      // LOGIC.md「5. 最終レスポンスで確認できる項目」：画像未取得・不正ID・確信度不足・AI未判定を区別して返す。
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

    // LOGIC.md「4. 画像confidenceと候補スコア」：採用画像があればCONFIRMEDとし、最大confidenceを代表値にする。
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
