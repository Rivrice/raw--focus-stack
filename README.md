# RAW深度合成

ピント位置をずらして撮ったRAW（DNG）を、手前から奥までピントの合った1枚に合成するWebアプリです。スマホのブラウザだけで動き、画像は端末の外に送信されません。

**使う:** https://rivrice.github.io/raw--focus-stack/

## スマホでの使い方

### 1. 撮影する

1. カメラアプリをRAW（DNG）で撮れる設定にします。iPhoneは「ProRAW」か、RAW撮影に対応したカメラアプリを使います。Androidは「プロ」モードなどでRAW（DNG）保存をオンにします。
2. スマホを三脚や台に固定し、ピントを手前から奥へ少しずつずらしながら3〜10枚ほど撮ります。手持ちでも撮れますが、なるべく動かさないようにしてください。
3. 撮影中は明るさ（露出）とズームを変えないでください。

### 2. ページを開く

SafariかChromeで https://rivrice.github.io/raw--focus-stack/ を開きます。アプリ内のブラウザ（SNSやチャットアプリから開いた画面）では、ファイル選択がうまく動かないことがあります。ホーム画面に追加しておくと、次からすぐに開けます。

### 3. 合成する

1. **STEP 1**：「DNGファイルをまとめて選択」を押し、撮った写真をまとめて選びます。写真はファイル名の順に処理されます。順番が逆のときは「並びを逆にする」を押してください。
   - iPhoneで写真を選ぶとDNGとして読み込めない場合は、いったん「ファイル」アプリに保存してから、そこから選んでください。
2. **STEP 2**：ふだんは設定を変えずにそのまま進めて大丈夫です。ピント判定の範囲と境界のなめらかさは、画像の解像度に合わせて自動で設定されます。苔や草のような細かい部分は、合成のときに写真の中から見分けて、そこだけ狭い範囲で判定します。撮影の途中で明るさが変わった写真は、1枚目の明るさに揃えてから合成します（初期設定でオン）。4800万画素クラスの大きなRAWでは、自動で「1/2（高速）」が選ばれます。
3. 「深度合成を開始」を押します。終わるまで画面を開いたままにしてください。

### 4. 確認して保存する

1. **STEP 3**：「Before｜After」で、合成前と合成後を左右にドラッグして比べられます。画像をタップすると、その部分を等倍で確認できます。
2. 保存したい形式のボタンを押します。

   | ボタン | 向いている用途 |
   | --- | --- |
   | DNGで保存 | Lightroomなどで現像したいとき（RAWのまま） |
   | TIFFで保存 | 画像編集ソフトで仕上げたいとき（16bit） |
   | JPEGで保存 | そのまま共有したいとき |
   | 比較JPEGで保存 | 合成前後を並べた1枚で紹介したいとき |

3. iPhoneでは共有メニューが開くので、「ファイルに保存」か「画像を保存」を選びます。

> 撮影の前に試したいときは、STEP 2 の「サンプルで試す」で合成の流れを確認できます。

## できること

- **入力:** DNG（ベイヤー配列 / LinearRaw）。非圧縮・ロスレスJPEG・Deflate・非可逆JPEGに対応。iPhone ProRAW、Pixel / Galaxy などAndroidのDNG
- **位置合わせ:** 拡大縮小・回転・平行移動（フォーカスブリージングと手ぶれの補正）
- **合成:** 局所コントラストから深度マップを作り、フレーム間をなめらかにつないで合成
- **デモザイク:** 方向判定つき補間（Hamilton-Adams 系、特許期限切れの方式）
- **出力:** DNG（元と同じベイヤー配列・14bit可逆圧縮。WBや色は現像ソフトで調整可）、16bit sRGB TIFF（可逆圧縮）、JPEG、合成前後の比較JPEG

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
