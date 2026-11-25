# 第32工程：検索枠・公開巻き戻り調査

調査日：2026-11-25。対象mainは `ec82badfd2fe54e8743d0adbe5b0dda22a434aff`。本工程はPR作成までとし、マージ・本番Worker配備・実APIによる負荷試験は実施していない。

## 確認できた検索消費構造

- 変更前のWorkerはJST日中17枠＋夜間42枠＝59枠。Actionsにも主枠・予備枠がある。近接実行はキャッシュ鮮度で抑制するが、遅延・キャッシュ欠落・手動実行に対する恒久的な共有台帳はなかった。
- 変更前のアダプターは1更新につきライブ6回＋予定2回まで検索し、検索429は1回再試行する。再試行もローカル80回に加算するが、保存先はActionsキャッシュ。これだけでは同じGoogle Cloudプロジェクトの全消費を保証できない。
- [#67](https://github.com/elrain1999/gesen-live/actions/runs/45577502238) は17:35 JSTにsearch 7回（成功5・429が2・再試行1・再試行成功1）、videos 25回、playlistItems 59回。ローカルPT日集計は20回。検索制限と、他の取得経路の正常動作は同時に成立している。
- [#86](https://github.com/elrain1999/gesen-live/actions/runs/45605723919) は20:35 JSTにsearch 2回とも429（再試行1）、videos 24回とplaylistItems 59回は全成功、ローカル日集計74回。いずれも取得・配備ジョブは成功表示だった。
- Google Cloud Consoleの100回／日、11/23・24超過、11/25 17:51 JSTに97回という値は依頼者提供。Console設定・プロジェクト内の別利用者・履歴全体へはアクセスしていない。429のAPI側理由は `rateLimitExceeded` と確認できるが、短期制限と日次枠枯渇の寄与、ローカル集計との差の内訳は確定できない。アーカイブ約500件がsearch枠超過の原因という証拠はない。

## 巻き戻り：観測事実と未確定事項

11/25 19:24〜20:44 JST開始の #79〜#87 を確認した。全件でcollect/deploy成功、check_backupはスキップ（Cloudflareのworkflow_dispatch）、取得では直前のv6-mainキャッシュを復元している。再取得・監査・ビルド・Pages成果物アップロードを行っている。

| 実行 | 開始JST | 生成対象の表示可能件数 |
|---|---|---:|
| [#79](https://github.com/elrain1999/gesen-live/actions/runs/45594717771) | 19:24 | 515 |
| [#80](https://github.com/elrain1999/gesen-live/actions/runs/45596310352) | 19:34 | 516 |
| [#81](https://github.com/elrain1999/gesen-live/actions/runs/45597888680) | 19:44 | 515 |
| [#82](https://github.com/elrain1999/gesen-live/actions/runs/45599450752) | 19:54 | 516 |
| [#83](https://github.com/elrain1999/gesen-live/actions/runs/45601012095) | 20:04 | 518 |
| [#84](https://github.com/elrain1999/gesen-live/actions/runs/45602615288) | 20:14 | 521 |
| [#85](https://github.com/elrain1999/gesen-live/actions/runs/45604180437) | 20:24 | 523 |
| [#86](https://github.com/elrain1999/gesen-live/actions/runs/45605723919) | 20:34 | 523 |
| [#87](https://github.com/elrain1999/gesen-live/actions/runs/45607257632) | 20:44 | 525 |

Pages設定はworkflow方式。上記時間帯のデプロイはmainの同じSHAで、10分刻みの配備履歴がある。#87の配備は20:45 JST、直接取得した公開 `/streams.json` は `generated_at=last_success_at=2026-11-25T11:44:48.748Z`、525件（archive 484・live 15・upcoming 26）だった。依頼者の19:31のライブ6件とは観測時刻も対象も異なるため比較して断定しない。

`check_backup` は古いバックアップをコピーする機能ではなく、公開JSONの成功時刻から追加取得を判定する機能。復元処理の実体はActions cache restore。429でも既存データをマージし、成功したvideos/playlistItemsの結果を保存する構造で、このログ範囲で11/23へ戻す処理は見つからなかった。

通常ページは相対URL `streams.json` をcache:no-storeで再取得し、Service WorkerやlocalStorageから復元する処理はない。固定プレビューでは埋め込みスナップショットを使う。依頼者が20:46に見た応答本文・レスポンスヘッダー・正確なURL・ブラウザ状態は残っていない。Actions成果物ZIPの取得は配信先の403で利用できず、生成ログと公開JSONで確認した。CDN、ブラウザ、別URL／固定プレビューのどれが原因かは未確定。11/23 23:34への巻き戻りがサーバーで発生したとは断定しない。

一方、コード上はキャッシュ復元後・公開直前の比較がなく、ブラウザも新しい表示データを古いHTTP応答で置換可能だった。この保護不足を確認し、独立した再現テストを付けて修正した。これを今回の事象の確定原因とはしない。

## 修正と最終設定

- `scripts/providers/youtube.cjs`：JST日中1回／夜間2回、再試行込み。既知動画・アップロード20本の経路は維持し、未確認ライブの検索を先行。PT日をまたぐ予約・遅延検索を停止。
- `scripts/search-budget.cjs`：専用GitブランチのSHA競合制御で最大80枠を先に予約。同一15分枠を重複予約しない。失敗・未使用分も返却しない。キャッシュがなくても台帳から80回を越える予約はしない。初回／台帳消失日は使用済み80で開始し、翌PT日から再開。台帳障害時は検索0回。
- `scripts/snapshot-guard.cjs`、`scripts/update.cjs`：生成時刻・最終成功時刻の両方を比較して復元と公開を保護。公開JSONの確認に失敗した場合は現行Pagesを保持して停止。
- `dist/app.js`：既に受信した新しい生成・成功時刻より古い応答を拒否。取得試行のラベルを明示。既存の部分失敗・停止警告、成功時刻、古いライブの非表示は維持。
- `update.yml`：夜間07・22・37・52分。Worker：夜間04・19・34・49分。日中は従来どおり。通常45更新枠、検索上界17×1＋28×2＝73回／PT日、予備・手動・push込みでも内部80予約。DST切替日は24時間と異なるため80で保護。
- `scripts/check-acquisition.cjs`と`acquisition_status`：部分取得を安全に公開した後、失敗・API延期・認証／台帳障害をActions失敗として報告。deployの条件はcollect成功のままなので、報告ジョブの失敗で部分公開・保存済みキャッシュを取り消さない。
- テストとAPI／Worker運用ドキュメントを更新。59チャンネル、複数同時配信、分類・検索、約500件のアーカイブ、スマートフォンレイアウトは維持。

## 検証

YouTubeへの実APIリクエストは本調査・テストで発行していない。

- `npm run build`：公開用レジストリ59件・公開ファイル検査成功。
- `npm test`：73テスト中69成功・既存Twitch凍結4スキップ、失敗0。通常・上限79/80・429・再試行・同時CAS・Worker/Actions/手動/push相当の共有・キャッシュ消失・PTリセット／DST・予約日のずれ・古い復元／公開・新しい正常データの保持・部分取得の報告を検証。
- `npm run test:browser`：既存チェックアウト入力で成功。両サイトパス、スマートフォン幅、複数ライブ、予定・アーカイブ、分類・検索、エラー／更新停止、同一ページへの古い応答を検証。
- 公開済み525件をローカルビルドへ入力：所属監査・資格情報検査とHTTPプレビューを通過。追加ブラウザ実行は本番形式の一覧とHTTP静的プレビューまで通過したが、最後のfile://プレビューは環境ポリシー `ERR_BLOCKED_BY_ADMINISTRATOR` により未完了。file://制限を回避する実装修正はしていない。
- ワークフローYAML構文解析、`git diff --check` 成功。GitHubのPR CIでも確認する。

## 残存リスクとマージ後の確認

1. 人間がPRをマージ後、mainから **Deploy scheduler Worker** を実行し、既存Secretを保持したまま15分Cronへ更新する。古いWorkerが当面10分起動しても新しいActionsの予約上限は適用される。
2. GITHUB_TOKENにContents writeが認められ、`youtube-quota-state/search-budget.json` が作成されることを確認。ルールで書けない場合、検索は停止して他の取得を続け、報告ジョブが失敗する。台帳を編集・削除して使用数を戻さない。初回導入日は検索を休止する。
3. 太平洋時間で少なくとも2日分、ConsoleのSearch Queries per dayが100以下、台帳予約80以下、実search回数が予約以内であることを確認。台帳予約数と実呼出数は未使用予約の分だけ一致しない。Consoleとの差や外部利用を照合する。同じCloudプロジェクトでこの台帳を使わない処理の消費は制限できない。
4. 日中・夜間・PT日付変更を含め、予約、実APIテレメトリー、collect/deploy/acquisition_status、公開JSONのgenerated_at/last_success_at、画面の部分失敗と停止を照合。手動・push・Workerの重複でも予約が復活しないことを確認。
5. 低予算では新規予定を全59チャンネル毎日検索できない。ライブ優先59回を使うと予定の検索枠は通常最大14回で、アップロード一覧と既知IDで補う。発見遅延は実測が必要。保存済みキャッシュ消失時の通常API消費も観測する。
6. 巻き戻り再発時は正確なURL、JST時刻、公開streams.json本文と生成／成功時刻、HTTP Age/ETag/Cache-Control、Actions実行とPages配備IDを同時に保存する。初回ページロードではブラウザ内の比較元がなく、CDN自身が古い応答を返した事実をこの修正だけで証明・排除できない。公開鮮度照会が不可の場合は自動公開が止まる。
7. file://の実機プレビューとAndroid実機の確認は別途行う。本番の2日分の運用実績はPR作成時点では未検証。
