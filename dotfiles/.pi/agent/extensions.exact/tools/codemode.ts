import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerCodemode(pi: ExtensionAPI): void {
  createCodemodeExtension()(pi);
}
