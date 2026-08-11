# readable-code スキル — 調査メモ

## 既存スキルの探索

### skills.sh (npx skills find)
- `readable`: コード可読性に直結する強力なスキルは無い。上位はデザナー/HTML向け。
- `clean code`: `sickn33/antigravity-awesome-skills@clean-code` (9.7K), `wondelai/skills@clean-code` (4.2K), `asyrafhussin/...@clean-code-principles` (1K)
- `refactor readability`: `code-simplifier` (231), `readability-scorer` (63) 等マイナー

### sickn33/clean-code の中身（最多インストール）
Robert C. Martin『Clean Code』準拠。9章構成:
1. Meaningful Names 2. Functions 3. Comments 4. Formatting
5. Objects/Data Structures 6. Error Handling 7. Unit Tests 8. Classes 9. Smells
→ **構造・設計品質**軸。クラス/SRP/例外/null 等の設計論寄り。

## 住み分け（差別化の軸）
- Clean Code 系 = 構造・設計（何に分割すべきか）
- code-review smell baseline (Fowler) = リファクタリングのシグナル（何が臭いか）
- ponytail（本リポジトリ常駐） = 書かないこと（行数最小化・YAGNI）
- **readable-code = 理解までの時間**（読んだ瞬間に分かるか）← The Art of Readable Code 軸

ponytail が「減らす」なら readable-code は「残った行を分かりやすく」。相補。

## 一次情報（Web）
- The Art of Readable Code 要約 (gist): 14技法 — Naming/Aesthetics/Commenting/Control flow/Breaking complexity/Remove vars/Refactor/Write less/Test readability
- dev.to: self-documenting vs comments — 解決の4階層 Logic → Name → Type → Comment(whyのみ)

## 適用判断
- 本文は日本語（dotfiles AGENTS.md / research-strategy スキルに倣う）。コード例・識別子は英語。
- 既存 clean-code スキルと被る名前/コメントは、軸（認知負荷）を明示して差別化。
