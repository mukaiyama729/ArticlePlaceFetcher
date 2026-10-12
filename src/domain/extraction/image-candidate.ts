import type { ImageNode } from "./page-snapshot.js";

export type CandidateEvidence = {
  candidateScore: number;
  sameContainer: boolean;
  sameSection: boolean;
  domDistance: number;
  visualDistancePx: number;
  captionMatchesLocation: boolean;
  altMatchesLocation: boolean;
};

export type ImageCandidate = {
  image: ImageNode;
  evidence: CandidateEvidence;
};
