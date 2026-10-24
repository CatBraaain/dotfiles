---
name: blender
description: >-
  Blender のモデリング、マテリアル、ライティング、カメラ、レンダリング、
  アニメーション、UV・テクスチャ、エクスポート作業を扱う入口スキル。
  3Dシーンやオブジェクトの作成・編集、画像のレンダリング、3Dアセットの書き出し、
  Python（bpy）による Blender自動化の依頼で使う。
  references/ 配下に同梱した専門スキルへ案内する。
---

# Blender

Blender で作業するエージェント向けの入口スキル。依頼に応じて `references/` 配下の専門スキルを選び、この環境での Blender実行方法を定める。

## この環境での実行規則

同梱スキルは Blender MCPバックエンドを前提としている。この環境には Blender MCPサーバーがないため、次の規則に読み替える。

- CLI で Blender をヘッドレス実行する:
  `blender --background --factory-startup --python-exit-code 1 --python <script.py>`。
- スクリプトの失敗は終了コードで検出する。成功を示すログ出力やファイルの存在確認だけを成功の根拠にしない。
- Blender の GUI は開かず、バックグラウンドモードだけを使う。
- CLI実行ごとに新しい Pythonプロセスが起動する。実行間でシーン状態を引き継ぐには、`.blend` ファイルを保存・読み込みする
  （`bpy.ops.wm.save_as_mainfile` / `bpy.ops.wm.open_mainfile`）。
- ユーザーの Blender設定を変更しないよう、`BLENDER_USER_CONFIG` に一時ディレクトリを指定する。
- Cycles の GPU描画は CUDA を使う。この環境（WSL）では OptiX の動作を確認できていないため、references のレシピが `OPTIX` を指定していたら `CUDA` に読み替える。`compute_device_type` の設定後、デバイス列挙と実描画で GPU が使えていることを確認する。
- 動画はフレーム連番の PNG から ffmpeg で MP4 を作る。`ffprobe` でフレーム数・解像度・duration を確認し、`ffmpeg -v error -xerror -i <out.mp4> -f null -` で完全デコードを確認する。エンコードと検証の終了コードは個別に確認する。
- スキルが `mcp__blender__execute_blender_code` などの MCPツール呼び出しを指示する場合は、同じ Blender Pythonコードをスクリプトファイルに書き、CLI で実行する。
- ビューポートのスクリーンショット確認を指示する場合は、カメラビューを画像ファイルへレンダリングし、そのファイルを読む。
- MCPバックエンド固有の機能（アドオンのソケット接続、アセットのダウンロード・生成ヘルパー）は利用できない。可能なら通常の `bpy` コードで代替する。CLI で代替できず、実際に MCP接続が必要な手順では、推測で進めず停止してユーザーに伝える。

## この環境での制作規則

シーン制作と検証で守る規則。references のレシピを補う、この環境での制作で確認済みの知見である。

- アセットを調達するときは、アセットごとに作者・公式ページ・取得URL・ライセンス・ファイルの SHA-256 を記録する。ミラー経由なら元の配布物との対応も確認する。HDRI・PBR は Poly Haven（CC0）、人物リグ付きの既存アニメーションは Quaternius Universal Animation Library（CC0）の利用実績がある。
- Poly Haven の API（`https://api.polyhaven.com/files/<asset-id>`）はアセット種別で応答構造が異なる。キー構造を仮定せず、応答を確認してからパースする。
- FBX を取り込んだら、単位・軸・実寸を取り込み結果で確認する。一律のスケール補正を当てはめない。
- リグの前向きは推測せず、つま先の方向と試写で確認する。
- その場で動く in-place アニメーションは、親オブジェクトの前進と分けて動かす。接地足の後退量に前進速度を合わせ、連続プレビューで足滑りを確認する。クリップ名から移動量や重心移動を期待しない。
- NLA で動作をループ・接続する。両端が同じポーズのループは、キー数より1少ないフレーム数が周期になることがある。
- パーティクルの `instance_object` は、インスタンス用オブジェクトを全コレクションから外したまま保存すると、再読込後に `None` になる。非表示コレクションに所属させて保存し、再読込後に参照と実描画を確認する。
- 依存ファイル（テクスチャ画像・流体 cache など）はパックするか相対パスにして保存する。絶対パスのまま残した依存は、移動・配布で壊れる前提で記録を残す。
- 生成直後の成功と、保存済み `.blend` の再読込・再描画の成功を別の検証として扱う。粒子数などの数値検証は白飛び・隠れ・黒い塊のような画の問題を検出できないため、再読込後の画像も目視で確認する。

## 同梱スキルの使い方

1. 下の対応表から、依頼に合うスキルを選ぶ。
2. そのスキルの `references/<skill-name>/SKILL.md` を読む。
3. レシピと規則に従い、コードの実行方法だけを上の CLI実行規則に読み替える。
4. 各スキル内の詳細な `references/` ファイルは、そのスキルの「When to load」（読み込み条件）節で必要とされる場合だけ読む。

## 用途と参照先の対応表

| 用途 | `references/` 配下のスキル |
| --- | --- |
| 全体の作業手順・複数スキルの連携 | `text-to-blender` |
| 形状の作成・編集 | `blender-modeling` |
| マテリアル・PBR・シェーディング | `blender-materials` |
| ライト・3点ライティング | `blender-lighting` |
| カメラの構図・被写界深度 | `blender-cameras` |
| レンダーエンジンの設定・出力 | `blender-rendering` |
| キーフレーム・シェイプキーのアニメーション | `blender-animation` |
| glTF・FBX・OBJ・USD・STL の書き出し | `blender-export` |
| UV展開・ベイク・アトラス | `blender-uv-texturing` |
| 制作工程全体の作業順序 | `blender-pro-workflow` |
| 2Dワイヤーフレーム画像からの3Dモデル作成 | `wireframe-to-3d` |
| 参照画像・テンプレートからの3Dモデル作成 | `reference-to-3d` |
| 参照資料から復元したモデルの検証 | `reference-analysis-validator` |
| シルエットからのメッシュ作成 | `contour-to-mesh` |
| 正面・側面・背面・上面の位置合わせ | `orthographic-registration` |
| レンダリング・比較・調整の反復 | `multiview-fit-loop` |
| フィット失敗後の修正キュー管理 | `fit-repair-optimizer` |
| 参照資料のパーツ分割 | `source-part-segmentation` |
| テクスチャの輪郭へのメッシュの適合 | `texture-driven-mesh-fitting` |
| 名前付き特徴点（ランドマーク）の修正 | `landmark-fit-repair` |
| 参照画像への見た目の調整 | `reference-look-calibration` |
| ブランドのマスコット・ロゴの再構築 | `mascot-logo-reconstruction` |
| レイヤー化したテクスチャ状態のアニメーション | `texture-state-animation` |
| HUD・円運動のアニメーション | `orbital-hud-motion` |
| コンタクトシートによるアニメーションの品質確認 | `animation-quality-gate` |
| 閉じた表面の UV被覆検査 | `closed-surface-uv-coverage` |
| アトラス領域への UV の適合 | `atlas-uv-fitting` |
| 複数スキル間の優先順位・引き継ぎ | `blender-skill-harmonizer` |
| 品質が不足する出力の改善ループ | `quality-refinement-autoloop` |
| 複数視点の制約を満たす形状の計算 | `multiview-constraint-solver` |

## よくある作業の推奨読み順

- オブジェクト作成からレンダリングまで: `text-to-blender` を最初に読み、続いて `blender-modeling`、`blender-materials`、`blender-lighting`、`blender-cameras`、`blender-rendering` を読む。
- ファイルの納品: 上記に `blender-export` を追加する。
- 参照画像からの再構築: `reference-to-3d` から読み始める。必要な検証・修正スキルは、このスキルの案内に従って読む。
