# Web Site Image Fetcher

記事ページをPlaywrightで描画し、紹介されている拠点名と対応画像を抽出するNode.js APIです。画像との対応には、ページ全体のスクリーンショットと構造化したDOM情報を使います。

## 処理の流れ

1. Playwrightでページを開き、記事本文、見出し、画像、alt、caption、DOM上のグループ、順序、画面座標を取得します。
2. Chrome DevTools MCPからアクセシビリティ情報とフルページスクリーンショットを取得します。MCPでフルページ画像を取れない場合は、初期ビューポート画像へフォールバックします。
3. GPT-6 Lunaへ、構造化DOM・アクセシビリティ情報・スクリーンショットをまとめて渡し、拠点抽出と画像対応付けを1回のResponses API呼び出しで行います。モデルは `gpt-6-luna`、推論強度は `max` に固定しています。Astraや別モデルへのフォールバック呼び出しはありません。大きな記事では応答に数分かかることがあるため、APIのモデル応答タイムアウトは300秒です。
4. 返された画像IDを取得済み画像へ照合し、拠点名が指定された本文ノードに実在することを検証します。画像confidenceが `CONFIRM_THRESHOLD` 未満の場合は確定扱いにしません。

confidenceはモデルの未校正な自己評価です。95%以上の精度を保証する数値ではありません。実運用で精度を主張するには、正解ラベル付きデータによる評価と校正が必要です。

## 起動

Node.js 22以降を使います。初回は依存パッケージとChromiumを準備してください。

```sh
npm install
npm run browser:install
cp .env.example .env
```

`.env` に `OPENAI_API_KEY` を設定して、開発サーバーを起動します。

```sh
npm run dev
```

ビルドして起動する場合は `npm run build`、続けて `npm start` を実行します。

## API

`POST /extractions`

```sh
curl http://127.0.0.1:3000/extractions \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/article"}'
```

レスポンスの `locations` に拠点と確定画像が含まれます。各画像には元URL、DOM上の根拠、confidence、モデルの判定理由を付けます。画像を確定できなかった拠点は `UNKNOWN` と `imageFailure` に理由を返します。

`diagnostics` では、ページから取得したノードと画像の数、モデルに送った件数、入力上限による省略数、スクリーンショットの取得方法、見出しごとの分類理由、判断できなかった候補を確認できます。`mappingScreenshotMode` は `FULL_PAGE`、`VIEWPORT_FALLBACK`、`UNAVAILABLE` のいずれかです。

## 環境変数

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 必須 | OpenAI APIキー |
| `HOST` | `127.0.0.1` | HTTPサーバーのlisten先 |
| `PORT` | `3000` | HTTPポート |
| `ENABLE_CHROME_DEVTOOLS_MCP` | `true` | Chrome DevTools MCPによる画面・DOM情報の取得 |
| `PAGE_TIMEOUT_MS` | `30000` | ページ描画のタイムアウト |
| `MAX_IMAGES` | `60` | 取得する最大画像数 |
| `MAX_CONTENT_NODES` | `180` | 取得する最大本文ノード数 |
| `MAX_PAGE_TEXT_CHARS` | `100000` | 1回のモデル入力に含めるDOM情報の文字数上限 |
| `CONFIRM_THRESHOLD` | `0.97` | 画像を確定扱いにするconfidenceの下限 |

モデルと推論強度はそれぞれ `gpt-6-luna` と `max` に固定しています。

## 制約

- 通常のHTML画像を対象にします。CSS背景画像やiframe内の画像は対象外です。
- 公開HTTP/HTTPSホストのみ開き、ページ内リクエストとリダイレクト先も検査します。
- ページ本文、スクリーンショット、画像URLなどのページ情報をOpenAI APIへ送ります。
- 永続化、認証、キュー処理は含みません。サーバーは既定で `127.0.0.1` にbindします。
