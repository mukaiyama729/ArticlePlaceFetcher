export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ContentNode = {
  id: string;
  kind: "heading" | "text" | "caption";
  tag: string;
  domPath: string;
  text: string;
  order: number;
  groupId: string | null;
  sectionId: string | null;
  box: BoundingBox;
};

export type ImageNode = {
  id: string;
  domPath: string;
  url: string;
  srcset: string;
  alt: string;
  title: string;
  caption: string;
  order: number;
  groupId: string | null;
  sectionId: string | null;
  box: BoundingBox;
  naturalWidth: number;
  naturalHeight: number;
};

export type PageSnapshot = {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  contentNodes: ContentNode[];
  images: ImageNode[];
  captureDiagnostics: {
    discoveredContentNodeCount: number;
    capturedContentNodeCount: number;
    omittedContentNodeCount: number;
  };
};
