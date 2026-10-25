# RAW深度合成

ピント位置をずらして撮ったRAW（DNG）を、手前から奥までピントの合った1枚に合成するWebアプリです。スマホのブラウザだけで動き、画像は端末の外に送信されません。

**使う:** https://rivrice.github.io/raw--focus-stack/

## できること

- **入力:** DNG（ベイヤー配列 / LinearRaw）。非圧縮・ロスレスJPEG・Deflate・非可逆JPEGに対応。iPhone ProRAW、Pixel / Galaxy などAndroidのDNG
- **位置合わせ:** 拡大縮小・回転・平行移動（フォーカスブリージングと手ぶれの補正）
- **合成:** 局所コントラストから深度マップを作り、フレーム間をなめらかにつないで合成
- **デモザイク:** 方向判定つき補間（Hamilton-Adams 系、特許期限切れの方式）
- **出力:** リニアDNG（16bit・カメラ色空間のまま。WBや色は現像ソフトで調整可）、16bit sRGB TIFF、JPEG

CR3 / NEF / ARW などカメラ固有のRAWは、Adobe DNG Converter などでDNGに変換してから読み込んでください。X-Trans と浮動小数点DNGには未対応です。

## 開発

依存パッケージはありません（Node.js 18 以上）。

```sh
npm run build   # src/ から index.html を生成
npm test        # 合成・位置合わせ・DNG読み書きのテスト
```

| ファイル | 内容 |
| --- | --- |
| `src/tiff.js` | TIFF/DNGの読み書き |
| `src/ljpeg.js` | ロスレスJPEG（LJ92）デコーダ |
| `src/dng.js` | DNG現像（黒レベル・ゲインマップ・デモザイク・色変換） |
| `src/align.js` | ピラミッド型Gauss-Newtonによる相似変換の位置合わせ |
| `src/engine.js` | 深度合成本体（2パス、1枚ずつ読み込んで省メモリ） |
| `src/output.js` | 描画・DNG/TIFF/ZIP書き出し・サンプル生成 |
| `src/worker.js` | Web Workerのメッセージ処理 |
| `src/ui.js`, `src/page.html` | 画面 |

`index.html` はビルド結果です。`src/` を編集したら `npm run build` してからコミットしてください。

## プライバシー

ページを開いたあとは外部と一切通信しません（外部フォント・解析ツール・広告なし）。画像は端末のメモリ上で処理され、どこにも送信・保存されません。ページ自体の配信は GitHub Pages が行うため、アクセスログは GitHub の[プライバシーステートメント](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)に従って扱われます。

## ライセンス・権利表記

- コード: [MIT License](LICENSE)。無保証です
- This product includes DNG technology under license by Adobe.（Adobe DNG Specification Patent License に基づく表記）
- DNG・Lightroom は Adobe の、iPhone・ProRAW は Apple Inc. の、Pixel は Google LLC の、Galaxy は Samsung Electronics の、Xperia は Sony Group の商標または登録商標です。本プロジェクトはこれらの企業と関係がなく、承認も受けていません
- 第三者のコード・ライブラリ・フォント・画像は含みません。サンプル画像は実行時にプログラムで生成しています。詳細は [NOTICE](NOTICE)
