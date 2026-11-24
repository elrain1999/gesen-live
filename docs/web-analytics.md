# Cloudflare Web Analytics の設定

Cloudflare の無料 Web Analytics を GitHub Pages に手動で追加する手順です。計測の対象は本番の配信一覧と「このサイトについて」です。

1. Cloudflare ダッシュボードで **Web Analytics → Add a site** を開きます。**Set up hostname** に `elrain1999.github.io` を入力し、候補に表示されたホスト名を選んで **Done** を押します。GitHub Pages を使ったまま、コードを手動で設置できます。 [Cloudflare のセットアップ手順](https://developers.cloudflare.com/web-analytics/get-started/#sites-not-proxied-through-cloudflare)
2. **Manage site** の JS スニペットを開き、`data-cf-beacon` の `token` の値を確認します。GitHub で `dist/analytics-config.js` の空文字にその値だけを記入する PR を作成します。この値はブラウザーに公開するサイト計測用トークンです。Cloudflare の API トークンや GitHub PAT は記入しません。
3. PR のマージ後、通常の Pages 更新を待ちます。本番ページを開いて Cloudflare の **Web Analytics** にデータが入ることを確認し、「このサイトについて」の説明も確認します。

計測を停止するときは同じファイルの値を空文字に戻し、Pages に反映します。未設定時は Cloudflare の計測スクリプトを要求しません。ローカルとプレビューも計測対象外です。
