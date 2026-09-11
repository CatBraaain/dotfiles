// SPEC（agents「画像入力を使う agent」・sandboxed-tools §2.1）: モデルレジストリの
// Model.input が "image" を含むモデルを画像入力対応とする。この判定の正本。
export function modelSupportsImages(model: { input?: readonly string[] }): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}
