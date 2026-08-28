---
name: concept-learning
description: >-
  概念を読者が理解・識別・区別・一般化できる資料へ設計するスキル。近い概念の混同、
  概念境界の曖昧さ、抽象性、既知知識との断絶、別事例へ適用できない問題を扱う。
  概念の説明、教材、研修資料、チュートリアル、比較表、図解、学習用ドキュメントを
  作成・改善するときは、ユーザーが明示しなくても必ず使う。記憶定着ではなく、概念を
  認識可能にする説明設計が必要な依頼で使う。
---

# 概念を認識可能にする資料設計

読者が対象概念を、未提示の事例でも識別・説明・適用できる資料を作る。技法の詳細と文献は、このファイルの「技法カタログ」にある。技法を選ぶ前と、選んだ技法の手順・例・差分を確かめるときに読む。

## 適用範囲

適用するのは、概念・規則・分類・原理・関係を説明する資料である。読者に必要なのが知識の想起・保持だけなら適用しない。Retrieval Practice や Spaced Practice を追加しない。

## 概念分析

資料を書き始める前に、次を特定する。不明な項目を推測しない。資料の正確さや読者の行動を左右するなら確認する。

| 項目 | 特定する内容 |
| --- | --- |
| 対象概念 | 何を識別・説明・適用できるようにするか |
| 読者 | 既知知識、誤解、扱える表現 |
| 境界 | 含む事例と含まない近い事例 |
| 重要点 | 帰属に必要な特徴（Critical Features）または未識別の側面（Critical Aspects） |
| 変異 | 重要点を見せるために変えるものと固定するもの |
| 転移先 | 既出例と表面が異なる未提示事例、期待結果、判定根拠 |

必要十分条件が存在しない曖昧な概念に、もっともらしい定義特徴を捏造しない。その場合は読者が識別すべき Critical Aspects と、近い事例との差を示す。

## 技法の選択

観測できた失敗に対応する第一候補を選ぶ。技法カタログの `使うとき` にある前提を確認する。前提を満たせず資料の正確さに関わるなら、不足する比較事例・既知事例・表現段階を確認する。複数の失敗が独立して残る場合だけ技法を追加する。

| 観測できた読者の失敗 | 第一候補 | 選択根拠 |
| --- | --- | --- |
| A を B と分類する、または差を説明できない | Contrasting Cases | 同じ比較軸で A / B の差を示せる |
| 含む / 含まない事例を誤分類する | Examples and Non-Examples | 正例と近い非例を用意できる |
| 定義を読んでも帰属に必要な特徴を挙げられない | Critical Features | 概念に必要な特徴を特定できる |
| 重要な側面に気づかず、変えた条件に引きずられる | Critical Aspects と Variation Theory | 変えるものと固定するものを制御できる |
| 正例・負例から分類規則を導けない | Concept Attainment | 仮説を検証できる事例群を用意できる |
| 既知概念との関係を説明できない | Analogical Encoding | 既知事例と新事例の関係構造を対応付けられる |
| 個別例は解けるが共通構造を言えない | Schema Induction | 少なくとも2事例を比較できる |
| 抽象表現で説明できない、または具体例から離れられない | Concreteness Fading | 具体物・図・記号の対応を保って段階化できる |
| 未提示事例で分類・説明・適用に失敗する | Schema Induction または Analogical Encoding | 失敗が構造抽出か既知知識との対応かを区別できる |

## 技法カタログ

### Critical Features

- **解く問題**: 読者が本質的特徴と表面的特徴を区別できない
- **使うとき**: 概念の帰属に必要な特徴を特定できる
- **手順**:
  1. 概念への帰属に必要な特徴を挙げる。
  2. 事例ごとに変化してよい特徴と分ける。
  3. 資料で両者を明示する。
- **資料表現**: 定義表、重要特徴 / 変化してよい特徴の対比表、注釈付き図
- **例**: 素数では「1より大きく、正の約数が2つ」が重要特徴。数字の大きさ・偶奇は変化しうる特徴
- **似た技法との違い**: Examples and Non-Examples は境界を見せる表現技法。本技法は先に何を境界にするかを分析する
- **参考**: Johnson et al. (2021), *Creating the Components for Teaching Concepts*, [article](https://pmc.ncbi.nlm.nih.gov/articles/PMC8458507/)

### Critical Aspects

- **解く問題**: 読者が重要な側面に気づかず、条件の変化に引きずられる
- **使うとき**: 必要十分条件ではなく、読者がまだ識別していない側面を特定する必要がある
- **手順**:
  1. 読者が識別していない critical aspect を特定する。
  2. その側面を見せるために変えるものと固定するものを決める。
  3. Variation Theory で事例列を設計する。
- **資料表現**: 変えるもの / 固定するものの表、制御した事例列、注釈付き図
- **例**: 長方形の面積では、幅と高さのうち読者が関係を見落としている側面を特定する
- **似た技法との違い**: Critical Features は概念への帰属に必要な特徴を扱う。Critical Aspects は学習者がまだ識別していない側面を扱う
- **参考**: Marton & Tsui (2004), *Classroom Discourse and the Space of Learning*, [HKU Knowledge Bank の要約](https://kb.edu.hku.hk/approaches_variation_theory)

### Examples and Non-Examples

- **解く問題**: 正例だけを見て概念の境界を過剰一般化する
- **使うとき**: 概念に含むものと、よく混同する含まないものを示せる
- **手順**:
  1. 正例を選ぶ。
  2. 正例に近い非例を選ぶ。
  3. 帰属を分ける特徴を明示して並べる。
- **資料表現**: 正例 / 非例の対、分類カード、二列表
- **例**: 三角形の正例に対し、開いた三辺・曲線を含む三辺・四辺形を非例として示す
- **似た技法との違い**: Contrasting Cases は複数事例から構造を比較して見つける。ここでは概念境界を明示する
- **参考**: K20 Center, *Examples and Non-Examples*, [strategy](https://learn.k20center.ou.edu/strategy/2804) ; Deans for Impact, *Using Examples and Non-Examples*, [guide](https://www.deansforimpact.org/files/assets/lbsdanchorchartene.pdf)

### Contrasting Cases

- **解く問題**: 近い概念・事例の差や背後の構造に気づけない
- **使うとき**: 何を変え、何を固定するかを設計した複数事例を用意できる
- **手順**:
  1. 比較で見せる軸を1つ選ぶ。
  2. ほかの重要でない差を抑えた事例を並べる。
  3. 共通性と差を読者に記述させる。
- **資料表現**: 比較表、並列した図・問題、差分に色を付けた図
- **例**: 同じ面積で底辺だけが異なる長方形を並べ、高さがどう変わるかを比較する
- **似た技法との違い**: Examples and Non-Examples は所属 / 非所属を分ける。Contrasting Cases は複数事例の関係・構造を見つける
- **参考**: Schwartz & Martin (2004), *Inventing to Prepare for Future Learning*, [paper](https://aaalab.stanford.edu/papers/CI2202pp129-184.pdf) ; Stanford AAA Lab, [overview](https://aaalab.stanford.edu/research/inventive-learning/contrasting-cases)

### Variation Theory

- **解く問題**: どの特徴を変え、何を固定すれば本質が見えるかを設計できない
- **使うとき**: Critical Aspects を識別させるために、事例の変異を制御できる
- **手順**:
  1. critical aspect と dimension of variation を決める。
  2. 他の側面を固定し、その次元だけを変える。
  3. 必要に応じて Contrast、Separation、Generalization、Fusion を使う。
- **資料表現**: 制御された事例列、変えるもの / 固定するものの表、段階図
- **例**: 長方形の面積では、高さを固定して幅を変え、次に幅を固定して高さを変える
- **似た技法との違い**: Contrasting Cases は比較の活動。Variation Theory は比較事例の変異設計を決める教授設計原理
- **参考**: Marton & Booth (1997), *Learning and Awareness* ; Marton & Tsui (2004), [HKU Knowledge Bank の要約](https://kb.edu.hku.hk/approaches_variation_theory) ; Kullberg, Kempe, & Marton (2017), [paper](https://doi.org/10.1007/s11858-017-0858-4)

### Concept Attainment

- **解く問題**: 定義を読んでも、読者自身が分類根拠を形成できない
- **使うとき**: 正例・負例を使って、読者に特徴仮説を検証させたい
- **手順**:
  1. 正例と負例を提示する。
  2. 読者に共通特徴の仮説を立てさせる。
  3. 新しい例で分類と根拠を確認する。
- **資料表現**: Yes / No の事例群、仮説欄、分類課題
- **例**: 三角形と非三角形のカードから、三辺で閉じるという規則を推論させる
- **似た技法との違い**: Examples and Non-Examples は境界を説明する。Concept Attainment は境界を読者が発見・検証する活動
- **参考**: Bruner, Goodnow, & Austin (1956), *A Study of Thinking* ; NAU, *Jerome Bruner on Concept Attainment Strategies*, [overview](https://jan.ucc.nau.edu/lsn/educator/edtech/learningtheorieswebsite/bruner.htm)

### Analogical Encoding

- **解く問題**: 新概念を既知知識と関係付けられない、または表面的な似方だけで誤って類推する
- **使うとき**: 既知事例と新事例の関係構造を対応付けられる
- **手順**:
  1. 既知事例と新事例を並べる。
  2. 要素ではなく関係構造の対応を示す。
  3. 対応しない差を明示し、新事例で同じ構造を探させる。
- **資料表現**: 対応表、対応矢印付きの並列図、共通構造 / 対応しない点の二列表
- **例**: レシピとプログラムを「順序付きの手順」として対応付け、食材と変数は同一物ではないと明示する
- **似た技法との違い**: 単なる比喩は理解を助けても構造対応を要求しない。Analogical Encoding は比較からスキーマと転移を作る
- **参考**: Gentner, Loewenstein, & Thompson (2003), [paper](https://groups.psych.northwestern.edu/gentner/papers/GentnerLoewensteinThompson03.pdf) ; Gentner (1983), [paper](https://doi.org/10.1207/s15516709cog0702_3)

### Schema Induction

- **解く問題**: 個別例は解けるが、共通する構造・規則としてまとめられない
- **使うとき**: 少なくとも2つの事例から共通する関係・手順・役割を抽出できる
- **手順**:
  1. 事例を比較し、変わる表面と共通する関係構造を分ける。
  2. 共通構造を図・文・手順として明文化する。
  3. 新事例へ適用する。
- **資料表現**: 概念図、役割表、一般化した手順、穴埋めの構造図
- **例**: 2つの割合問題から「比較量 = 基準量 × 割合」という共通構造を抽出する
- **似た技法との違い**: Schema Theory は背景理論。Schema Induction は資料で実行する抽出活動。Analogical Encoding はその比較操作を特に強調する
- **参考**: Gick & Holyoak (1983), [paper](https://doi.org/10.1016/0010-0285(83)90002-6) ; Rumelhart (1980), [chapter](https://web.stanford.edu/~jlmcc/papers/Rumelhart81.pdf)

### Concreteness Fading

- **解く問題**: 抽象表現が早すぎて理解できない、または具体例から離れられない
- **使うとき**: 具体物・図・記号の対応を保って段階化できる
- **手順**:
  1. 具体的表現を提示する。
  2. 同じ関係を保つ図・モデルへ移す。
  3. 記号・一般則へ移り、保存された関係を明示する。
- **資料表現**: 具体物 → 図 → 記号の3段階、対応線、段階ごとの同一構造の注釈
- **例**: りんご3個と2個 → 点3個と2個 → `3 + 2 = 5`
- **似た技法との違い**: 単一の具体例は抽象概念を1例で示すだけ。Concreteness Fading は抽象表現まで戻す段階設計
- **参考**: Fyfe et al. (2014), *Concreteness Fading in Mathematics and Science Instruction*, [paper](https://doi.org/10.1007/s10648-014-9249-3) ; ERIC, [record](https://eric.ed.gov/?id=EJ1036777)

### Transfer of Learning / Generalization

- **解く問題**: 資料の例だけではできるが、未提示事例へ適用できない
- **使うとき**: 資料の完了前に、読者が扱うべき別事例を1つ以上設定できる
- **手順**:
  1. 既出例と表面が異なる未提示事例を出す。
  2. 読者に分類・説明・適用をさせる。
  3. 期待結果と根拠で判定し、失敗なら原因に応じた技法へ戻る。
- **資料表現**: 新事例課題、分類根拠欄、近い転移 / 遠い転移の例
- **例**: 割合の規則を学んだ後、値引きではなく濃度の問題へ同じ構造を適用させる
- **似た技法との違い**: Generalization は共通構造を新事例へ広げる結果。Schema Induction と Analogical Encoding はその結果を作る技法
- **参考**: Barnett & Ceci (2002), [paper](https://doi.org/10.1037/0033-2909.128.4.612) ; Gick & Holyoak (1983), [paper](https://doi.org/10.1016/0010-0285(83)90002-6)

## 資料への適用

1. 選んだ技法を資料の中心構造にする。正例・非例・比較・類比・段階化を装飾として追加しない。
2. 比較対象は同じ軸で並べ、区別に必要な差に絞る。
3. 類比では、対応する関係と対応しない差を両方示す。表面的な似方だけで対応付けない。
4. 具体例から抽象表現へ進む場合、各段階の対応を明示する。具体例を外したときに何が保存されるかを示す。
5. 未提示事例への識別・説明・適用を求める資料では、分析した転移先で期待結果と判定根拠を確認できるようにする。
6. ユーザーが指定した形式を保つ。形式が指定されない場合は、選んだ技法の `資料表現` から、読者の問題を解くのに必要な要素だけを含む形式を選ぶ。
7. 依頼された資料だけを出力する。技法カタログ、未依頼の学習法、追加ファイルは出力しない。資料の設計理由は、求められた場合だけ添える。

## 完了前レビュー

- [ ] 対象概念と、読者ができるようになる行為を特定した
- [ ] 境界または Critical Features / Critical Aspects を明示した
- [ ] 選択した技法が観測した読者の失敗と前提に対応している
- [ ] 例・非例・比較・類比の差が、区別に必要な軸に限られている
- [ ] 表面的特徴ではなく関係・重要特徴を扱っている
- [ ] 転移を求める資料では、転移先と表面が異なる未提示事例で、期待結果と判定根拠を確認できる
