# Android で Cloudflare の定期起動を設定する

第25工程の PR をレビューして `main` にマージすると、GitHub が Cloudflare 用の入力を受け付けるようになります。マージ後に、Android のブラウザーで以下を設定します。メニューやコード編集欄が狭いときは、Chrome の ⋮ メニューから **PC 版サイト** を選びます。

Cloudflare は **Workers Free** を使います。独自ドメイン、クレジットカード登録、Workers Paid、Git 連携は不要です。料金プランを選ぶ画面では Free を選びます。Workers Free の Cron Trigger 上限はアカウント全体で5件で、この Worker は2件使います。 [Workers Free](https://www.cloudflare.com/products/workers/) · [利用上限](https://developers.cloudflare.com/workers/platform/limits/)

## GitHub で専用トークンを発行する

1. リポジトリ所有者の `elrain1999` で GitHub にログインします。右上のプロフィール画像から **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** を開きます。 [Fine-grained tokens](https://github.com/settings/personal-access-tokens)
2. **Token name** は `gesen-live-cloudflare` など用途が分かる名前にします。**Expiration** は期限付き（例として90日）を選び、失効前に更新日を控えます。
3. **Resource owner** は `elrain1999`、**Repository access** は **Only select repositories** で `gesen-live` のみを選択します。
4. **Permissions → Repository permissions** で **Actions → Read and write** を選びます。その他の任意権限は未付与にします。GitHub が自動付与する **Metadata: Read** はそのままにします。
5. **Generate token** を押し、表示された値を次の Cloudflare の **Secret** 入力に直接貼り付けます。トークンは手順書、コード、チャット、スクリーンショットに含めず、貼り付け後は端末のクリップボードから消します。 [GitHub のトークン管理](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) · [起動 API の権限](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)

API の最小権限はリポジトリ単位の **Actions: write** です。GitHub の権限設定では、単一 workflow や単一 API にまでは絞れません。Fine-grained PAT は個人で管理する1リポジトリ向けに、ダッシュボードで設定と更新ができます。GitHub App はインストールトークンを短命にできますが、App 登録、インストール、秘密鍵の保管と署名処理が加わるため、今回は Fine-grained PAT を採用しています。 [GitHub の認証方式一覧](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/github-credential-types)

## Cloudflare ダッシュボードで Worker を作る

1. [Cloudflare ダッシュボード](https://dash.cloudflare.com/) にログインし、**Workers & Pages → Create application → Start with Hello World** を選びます。Worker 名に `gesen-live-scheduler` を入力して **Deploy** を押します。初回に `workers.dev` のサブドメインを求められたら、無料のサブドメインを選択します。 [ダッシュボードでの作成](https://developers.cloudflare.com/workers/get-started/dashboard/)
2. GitHub のマージ済み `main` で [worker.mjs](https://github.com/elrain1999/gesen-live/blob/main/cloudflare/worker.mjs) を開き、コードの **Copy raw file** を押します。Cloudflare の作成済み Worker で **Edit code** を開き、既存のエントリーファイルの内容をすべて置き換えて **Deploy** を押します。単一ファイルです。
3. Worker の **Settings → Variables and Secrets → Add** で種類を **Secret** にし、名前に `GITHUB_DISPATCH_TOKEN`、値に GitHub の Fine-grained PAT を入力して保存・配備します。Cloudflare のコード編集欄や Wrangler ファイルには貼り付けません。 [Secrets の設定](https://developers.cloudflare.com/workers/configuration/secrets/)
4. **Settings → Domains & Routes** で、この Worker の `workers.dev` と **Preview URLs** を無効にします。Cron は HTTP 公開なしで動きます。**Settings → Observability** で **Workers Logs** を有効にします。 [workers.dev の設定](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) · [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
5. **Settings → Triggers → Cron Triggers**（画面によっては **Trigger Events**）で **Add Cron Trigger** を選びます。Cron 式を手入力する欄に下の2本を1件ずつ追加し、ほかの Cron が入っていないことを確認します。 [Cron Triggers の設定](https://developers.cloudflare.com/workers/configuration/cron-triggers/#via-the-dashboard)

| Cloudflare に登録する式（UTC） | JST |
|---|---|
| `47 0-7,15-23 * * *` | 00〜16時台の毎時47分 |
| `4,14,24,34,44,54 8-14 * * *` | 17〜23時台の毎時04・14・24・34・44・54分 |

UTC 15〜23時台は翌日の JST 00〜08時台です。合計59枠/日です。設定の反映には最大15分、初回の **Past Cron Events** 表示には最大30分かかる場合があります。変更後は [運用手順](cloudflare-operations.md) に沿って自然起動を確認します。

`cloudflare/wrangler.toml` は同じ2本の Cron、ログ有効、公開ルートなしをコードで保持するための設定です。Android のダッシュボード手順では Wrangler を実行する必要はありません。
