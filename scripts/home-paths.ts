// Home-relative path resolution shared by the build stages that read the
// current home (merge composition, replace sidecars), using the segment
// mapping of home-diff.ts (spec §差分検知).
import { mapSegment } from "./home-diff.ts";

export function homeRelPath(distRelPath: string): string {
  const segments = distRelPath.split("/");
  return segments
    .map((segment, index) => mapSegment(segment, index < segments.length - 1).homeName)
    .join("/");
}
