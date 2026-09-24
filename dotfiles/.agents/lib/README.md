# .agents/lib

pi 拡張と dsh plugin が共有する、harness 非依存ロジックの local package。

## 契約

- package 名は `@dotfiles/agent-lib`。`exports` が `./<capability>` を `src/<capability>.ts` へ対応させ、build 产物は持たない（pi は source を node_modules 経由で解決し、dsh は bundle 時に inline する）
- 参照は `file:` 依存で行う。source tree と展開後（`~/`）で plugin から lib への相対位置が同じため、両環境で同じ指定が使える
  - pi: `dotfiles/.pi/agent/package.json` → `file:../../.agents/lib`
  - dsh plugin: `dotfiles/.dsh/plugins.exact/<plugin>/package.json` → `file:../../../.agents/lib`
- I/O・fetch・harness API（tool / provider 登録、UI、session、設定）は lib に入れない。それらは各 plugin 側の wiring に置く
- dsh 側の bundle 再 build は `build.run.sh` が `node_modules/@dotfiles/agent-lib` 配下の file 更新を検知して行う（`dotfiles/.dsh/plugins.exact/build.spec.md`）

## テスト

```sh
cd dotfiles/.agents/lib && bun test
```
