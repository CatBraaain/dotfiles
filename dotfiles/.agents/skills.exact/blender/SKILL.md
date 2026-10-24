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
  `blender --background --factory-startup --python <script.py>`。
- Blender の GUI は開かず、バックグラウンドモードだけを使う。
- CLI実行ごとに新しい Pythonプロセスが起動する。実行間でシーン状態を引き継ぐには、`.blend` ファイルを保存・読み込みする
  （`bpy.ops.wm.save_as_mainfile` / `bpy.ops.wm.open_mainfile`）。
- ユーザーの Blender設定を変更しないよう、`BLENDER_USER_CONFIG` に一時ディレクトリを指定する。
- スキルが `mcp__blender__execute_blender_code` などの MCPツール呼び出しを指示する場合は、同じ Blender Pythonコードをスクリプトファイルに書き、CLI で実行する。
- ビューポートのスクリーンショット確認を指示する場合は、カメラビューを画像ファイルへレンダリングし、そのファイルを読む。
- MCPバックエンド固有の機能（アドオンのソケット接続、アセットのダウンロード・生成ヘルパー）は利用できない。可能なら通常の `bpy` コードで代替する。CLI で代替できず、実際に MCP接続が必要な手順では、推測で進めず停止してユーザーに伝える。

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
