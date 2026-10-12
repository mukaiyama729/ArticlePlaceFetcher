import type { CandidateEvidence, ImageCandidate } from "./image-candidate.js";
import type { ContentNode, ImageNode, PageSnapshot } from "./page-snapshot.js";
import { matchesLocationName } from "./location-name.js";

const scoreCandidate = (
  locationName: string,
  anchors: ContentNode[],
  image: ImageNode,
): CandidateEvidence => {
  const captionMatchesLocation = matchesLocationName(image.caption, locationName);
  const altMatchesLocation = matchesLocationName(image.alt, locationName);

  let sameContainer = false;
  let sameSection = false;
  let domDistance = Number.POSITIVE_INFINITY;
  let visualDistancePx = Number.POSITIVE_INFINITY;

  for (const anchor of anchors) {
    if (anchor.groupId !== null && anchor.groupId === image.groupId) {
      sameContainer = true;
    }
    if (anchor.sectionId !== null && anchor.sectionId === image.sectionId) {
      sameSection = true;
    }
    domDistance = Math.min(domDistance, Math.abs(anchor.order - image.order));

    const anchorCenterY = anchor.box.y + anchor.box.height / 2;
    const imageCenterY = image.box.y + image.box.height / 2;
    visualDistancePx = Math.min(
      visualDistancePx,
      Math.abs(anchorCenterY - imageCenterY),
    );
  }

  const domProximity = Number.isFinite(domDistance)
    ? Math.max(0, 1 - domDistance / 20)
    : 0;
  const visualProximity = Number.isFinite(visualDistancePx)
    ? Math.exp(-visualDistancePx / 900)
    : 0;

  const candidateScore =
    0.3 * Number(sameContainer) +
    0.04 * Number(sameSection) +
    0.15 * domProximity +
    0.15 * visualProximity +
    0.18 * Number(captionMatchesLocation) +
    0.18 * Number(altMatchesLocation);

  return {
    candidateScore: Number(candidateScore.toFixed(4)),
    sameContainer,
    sameSection,
    domDistance,
    visualDistancePx: Number.isFinite(visualDistancePx)
      ? Math.round(visualDistancePx)
      : -1,
    captionMatchesLocation,
    altMatchesLocation,
  };
};

export const rankImageCandidates = (
  snapshot: PageSnapshot,
  sourceNodeIds: string[],
  locationName: string,
  maxCandidates: number,
): ImageCandidate[] => {
  const sourceIds = new Set(sourceNodeIds);
  const anchors = snapshot.contentNodes.filter((node) => sourceIds.has(node.id));

  if (anchors.length === 0) return [];

  return snapshot.images
    .map((image) => ({
      image,
      evidence: scoreCandidate(locationName, anchors, image),
    }))
    .filter(({ image, evidence }) => {
      const largeEnough =
        image.box.width >= 48 &&
        image.box.height >= 48 &&
        image.naturalWidth > 32 &&
        image.naturalHeight > 32;
      const hasSignal =
        evidence.sameContainer ||
        evidence.sameSection ||
        evidence.captionMatchesLocation ||
        evidence.altMatchesLocation ||
        evidence.candidateScore >= 0.3;
      return largeEnough && hasSignal;
    })
    .sort((left, right) => right.evidence.candidateScore - left.evidence.candidateScore)
    .slice(0, maxCandidates);
};
