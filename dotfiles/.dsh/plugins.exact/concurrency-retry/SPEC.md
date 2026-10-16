# dsh-concurrency-retry plugin Spec

登録済みProvider route の専用concurrency証拠だけを検知し、同じstep を無期限に待機リトライするhost/client plugin。

## 対象Provider と検出

対象母集団は `ctx.llm.listProviders()` が返す現在登録済みroute である。catalog由来route と hand-declared route を区別せず含める。`llm/adapters-updated` の発火後は最新の登録route集合を使い、未登録route は対象外とする。

Provider固有detector を先に使い、対応するdetector を持たないroute だけ共通detector を使う。detector保持route に共通detector を再適用しない。いずれも failure の `message`、安定 `code`、adapter が保持する `response` 情報から、同時実行を明示する専用証拠だけを判定する。

| Provider / detector | concurrency と確定する証拠 |
| --- | --- |
| `zai`、`zai-coding-cn` | code `1302` / `1305`、`rate limit reached for requests`、`temporarily overloaded` |
| そのほか登録済みroute | `concurrent request(s)`、`concurrency limit`、`too many concurrent`、`connection limit reached` |

quota・billing・usage-window の証拠は positive matcher より先に除外する。quota code `1113`、`1308`〜`1321`、`quota`、`usage limit/window`、`monthly` / `weekly` / `daily limit`、`billing`、`balance`、`credit`、`insufficient_quota`、`reset` / `resets` が failure に含まれる場合は既存経路へ委譲する。

`status: 429`、`code: RATE_LIMIT`、`providerRetryAfterMs` は単独では concurrency証拠にならない。専用証拠が判定できないfailure も対象外として推測せず、`next()` へ委譲する。

Codex (`openai-codex`) の `websocket_connection_limit_reached` は現行pi-ai adapter が SSE fallback へ切り替えて内部吸収するため `agent/request-error` の terminal failure として検出できない。Command Code (`commandcode`) は HTTP `429` を `RATE_LIMIT` へ正規化し、account pool の usage-window と共用するため、現行実装から concurrency専用の terminal code/message/response を検出できない。両者は専用terminal証拠が判明するまで Provider固有detector の対象外であり、共通detector は明示的な concurrency文言だけを扱う。

## waterfall と再試行

concurrency と確定したfailure は `agent/request-error` listener が `prepend: true` で処理する。`next()` は呼ばず、dsh-llm-retry の予算付きretry、dsh-agents の cooldown・model fallback、Provider adapter の通常retry へ渡さない。

| 状態 | 結果 |
| --- | --- |
| 登録済みroute の concurrency failure | warning を1回出し、待機開始event を1回appendし、待機後に `{ kind: "retry" }` を返して同じstep を再実行する。回数に上限はない |
| quota / billing / usage-window、非対象Provider、検出不能failure | `next()` を1回呼び、concurrency warning/event を出さず既存経路へ委譲する |
| 待機中に turn の abort signal が発火 | 待機を中断し `undefined` を返す。failure は terminal のままとする |

## 待機時間と状態

連続エラー回数 `n` に対して `5s × 2^(n-1)`（上限 `60s`）に ±20% の対称jitter を加える。`failure.providerRetryAfterMs` が正の有限値なら、その値を jitter なしで優先する。

連続エラー回数は agentごとの in-memory state で、同じturn と step の matching failure で加算し、turn または step が変わると `1` に戻る。プロセス再起動で消える。

## session event と表示

待機開始時に durable session event `concurrency-retry/wait` を1回appendする。待機完了・再送開始の event は appendしない。payload は次のとおり。

| フィールド | 型 | 値 |
| --- | --- | --- |
| `provider` | string | failure の Provider route |
| `attempt` | number | 現在の連続failure回数 |
| `waitMs` | number | jitter または provider override後の待機ミリ秒 |

warning は次の形式で出す。

```text
<provider> concurrency limit (attempt <n>); retrying the same step in <秒>s: <failure.message>
```

client bundle（`src/client/`、成果物 `lib/client.js`）は event を Conversation Definition で transcript内の chat node へ変換し、gray の1行で表示する。待機秒は `waitMs` の切り上げである。

```text
<provider> concurrency limit — retrying in <秒>s (attempt <n>)
```

status領域・通知・リアルタイムcountdown は持たない。
