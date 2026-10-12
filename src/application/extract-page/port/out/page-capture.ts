import type { PageSnapshot } from "../../../../domain/extraction/page-snapshot.js";
import type { BrowserInspectionSession } from "./browser-inspection-session.js";

export type CapturedPage = {
  snapshot: PageSnapshot;
  browserInspection: BrowserInspectionSession | null;
  browserInspectionFailure: string | null;
  close(): Promise<void>;
};

export interface PageCapture {
  capture(url: string): Promise<CapturedPage>;
}
