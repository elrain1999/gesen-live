# Cloudflare 定期起動の運用と障害対応

## 初回と日常の確認

1. Android の Cloudflare ダッシュボードで **Workers & Pages → gesen-live-scheduler → Settings → Trigger Events → View events** を開きます。対象の Cron と実行時刻を確認します。**Observability → Logs** で `pages_fresh`、`pages_stale`、`pages_unconfirmed`、`github_dispatch_accepted` などの記録を開きます。 [Cron Events](https://developers.cloudflare.com/workers/configuration/cron-triggers/#view-past-events)
2. GitHub で [Actions → Collect broadcast snapshot](https://github.com/elrain1999/gesen-live/actions/workflows/update.yml) を開きます。Cloudflare 起動はイベントが `workflow_dispatch`、表示名の末尾が `(cloudflare)` です。Worker のログに実行 ID があれば同じ ID を照合します。GitHub の通常枠と第24工程の予備枠は `schedule` のままです。
3. 取得が必要な回は GitHub の `collect` と `deploy` の結果を確認し、[公開 JSON](https://elrain1999.github.io/gesen-live/streams.json) の `last_success_at` と [本番サイト](https://elrain1999.github.io/gesen-live/) の取得時刻が進むことを確認します。JSON の時刻は UTC、画面は JST です。画面更新が反映されても、個別ライブの確認時刻は各動画の `fetched_at` で判断します。ライブが空でも、更新停止警告があるときは現在の配信状況が未確認です。

GitHub API の200は実行 ID 付きの受付、204は本文なしの受付です。どちらも取得や配備の成功は示しません。最初の24時間は昼間と夕方の両方を含め、起動・スキップ・配備を照合します。設定完了後に自然起動した Cloudflare の回で、実際に公開時刻が進むまで本番検証は未完了です。

## 近接実行の扱い

- Worker は公開 JSON の最終取得成功が最近なら起動要求を送りません。現在のJSTで昼間50分未満、夕方8分未満が目安です。60分・10分の実行間隔に、runner 起動や配備の猶予を持たせた値です。公開 JSON が読めないときは起動を1回試みます。
- GitHub 側は本番の `schedule` と Cloudflare の実行を同じブランチの `concurrency` グループで直列化します。実行中の回は取り消さず、待機中の回は GitHub によって置き換わる場合があります。起動要求が重なっても、取得直前に復元したキャッシュの最終試行を同じ50分・8分で確認します。
- `Automatic collection mode: fetch` は通常取得です。`skip` は最近の試行があり、既に配備済み、または直近の取得が失敗していた場合などです。`reuse` は最近の成功キャッシュの公開を確認できず、YouTube を再取得せずにビルドと配備をやり直す場合です。意図した手動起動では Cloudflare 入力をオフのままにします。
- GitHub キャッシュが消失すると直前の試行を判定できません。Pages CDN が古い値を返すと追加の起動要求やキャッシュからの再配備が発生し得ます。YouTube の既存の日次上限とバックオフは通常取得に適用されます。

## 障害の切り分け

| 観測結果 | 確認する場所と操作 |
|---|---|
| Cron Events に記録がない | Worker 名と Cron 2本を確認します。設定変更直後は反映と表示を待ち、次の予定時刻を確認します。 |
| `cron_ignored` | UTC の Cron 式がセットアップ手順の2本と一致しているか確認します。 |
| `github_dispatch_token_missing` または HTTP 401 | Secret 名、デプロイ先、トークンの期限と取り消し状態を確認します。 |
| HTTP 403・404 | PAT の所有者、対象リポジトリ、Actions の Read and write、GitHub 側の Actions 有効状態を確認します。 |
| HTTP 422 | 第25工程の変更が `main` に入っており、`update.yml` の `workflow_dispatch` に `cloudflare` 入力があることを確認します。 |
| HTTP 429・5xx、または `github_dispatch_unconfirmed` | GitHub の実行一覧を先に確認します。通信が途切れた場合も要求が受理された可能性があります。Worker は同じ回の POST を再試行しません。 |
| 200・204の後に公開時刻が進まない | Actions の待機・取消、`collect` のモード、取得のエラー、`deploy` の結果を順に確認します。鮮度で `skip` した場合は時刻を更新しません。 |
| `generated_at` だけ更新された | YouTube の取得失敗やクォータを Actions のログで確認します。取得成功の判定には `last_success_at` を使います。 |

## トークンの更新・失効

期限前に GitHub で同じ対象と権限の新しい Fine-grained PAT を発行します。Cloudflare の **Settings → Variables and Secrets** で `GITHUB_DISPATCH_TOKEN` を新しい値に差し替えて配備します。次の対象 Cron で GitHub API の受付と実行履歴を確認したら、GitHub の **Settings → Developer settings → Personal access tokens → Fine-grained tokens** で旧トークンを削除します。新鮮なページでの `pages_fresh` だけでは交換後の認証を確認できません。

漏えいが疑われるときは先に GitHub で該当トークンを失効させます。外部起動を止める場合は Cloudflare の対象 Worker から Cron 2本を削除し、その Secret を削除します。GitHub の既存 Cron は引き続き利用できます。Cron の削除にも伝播時間があるため、即時停止が必要な場合はトークンの失効を先に行います。

Cloudflare は GitHub の cron 配信から独立した起動経路です。GitHub API、runner、YouTube、Pages の障害時は、その段階の復旧が必要です。
