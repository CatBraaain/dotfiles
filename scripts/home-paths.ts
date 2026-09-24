// Home-relative path resolution shared by the build stages that read the
// current home (merge composition, replace sidecars). Maps a dist-relative
// path through the segment mapping of spec §差分検知, including the
// transitional chezmoi naming of the current pipeline.
import { mapSegment } from "./home-diff.ts";

export function homeRelPath(distRelPath: string): string {
  const segments = distRelPath.split("/");
  return segments
    .map((segment, index) => mapSegment(segment, index < segments.length - 1).homeName)
    .join("/");
}
