# 12. デスクトップシェル・検証・配布境界

## 1. 現在地

`apps/desktop`はTauri 2のshellだけを所有し、UI・編集・音声・学習ロジックは`apps/studio`を再利用する。二重実装を作らず、Web版とnative版のrenderer差分を最小化する。

現在できること:

- Vite HMR付きのnative開発起動
- production executableと各OSのunsigned bundle生成
- SQLite v2 transactionによる通常保存、debounce前crash-draft保護、旧localStorageのfail-closed移行
- Rust所有のOS file pickerによるproject/MIDI/source audio読込とproject/MIDI/WAV atomic書出し
- Assistantのハミング変換向けaudio-onlyマイク入力（録音PCMはrenderer memoryだけに保持し、Projectへ保存しない）
- macOS WKWebViewで画面描画、再生/停止、SQLite保存、保護ACK直後の`SIGKILL`、process再起動復元を自動検証
- marker付き二段階protocolによるapp-owned local dataの全消去と、クラッシュ後の起動前再開
- Ubuntu / macOS / Windowsのdesktop matrixをrequired CIへ接続
- protected tagとapproval付きenvironmentから、macOS universal DMG / Windows NSIS / Linux AppImageの検証済みrelease candidateを生成

まだできないこと:

- GitHub Releaseや販売チャネルへの自動公開、updater配信
- Windows installerのinstall / launch / uninstall、macOS DMG初回起動、Linux AppImage音声を含む3OSの配布物E2E

## 2. 固定する互換性識別子

| 項目 | 値 | 理由 |
|---|---|---|
| production bundle ID | `com.composetutor.studio` | package・native app dataのidentity |
| test bundle ID | `com.composetutor.studio.test` | test processとproduction processを識別 |
| main window label | `main` | capability/navigation/test targetの境界 |
| `useHttpsScheme` | `true` | Windows custom protocol originの互換性を固定 |

bundle IDまたはschemeは公開後に変えない。native正本はbundle IDに対応するapp data directoryのSQLiteであり、旧WebView profileはexact snapshot migrationの入力としてだけ扱う。公開release前に各OSのN-1 upgrade testを追加する。

## 3. Production security boundary

- `app.security.capabilities`は`main`だけを明示選択する。
- `capabilities/main.json`はapplication-owned persistence/file/close commands、端末全消去用の`core:webview:allow-clear-all-browsing-data`、close-event listen/unlistenだけを列挙する。`core:default`、汎用fs、JS dialog、shell、openerは与えない。
- `withGlobalTauri`はfalse。rendererに`window.__TAURI__`を注入しない。
- Rustの`on_navigation`はbundled originだけを許可する。`tauri dev`時だけ`http://127.0.0.1:5173`を追加する（`tauri dev --release`も含む）。
- `on_new_window`は常にdenyする。
- asset protocol、remote capability、updaterを無効のままにする。
- CSPはremote script/CDNを許可しない。本番`connect-src`にはVite WebSocketを含めない。
- Permissions Policyはcameraを拒否したまま、同一originのmicrophoneだけを許可する。macOSは用途説明とaudio-input entitlementをbundleへ固定し、Linux WebKitGTKはaudio-onlyの`UserMediaPermissionRequest`だけを許可してvideo / mixed requestを拒否する。マイク用native commandやnetwork権限は追加しない。
- Tauri `removeUnusedCommands`でACLに無いcore commandsをproduction binaryから除く。
- protected tag preflightはproduction / development security object、main window / build / package identity、capability permission全件、global API、asset protocol、updater/plugin無効、local `frontendDist`、root / Studio / Desktopの全scripts・build tool依存・`pnpm-workspace.yaml`内のoverrides / 依存build script許可、内部package manifest / export、Tauri bundle全体をbuilt-inだけでexact比較する。production commandはpackage名filterを使わずworkspace実pathへ固定する。duplicate workspace、npmrc / pnpmfile、自動探索PostCSS config、platform override / repository Cargo configを禁止し、`pnpm-workspace.yaml` / `pnpm-lock.yaml` / `vite.config.ts` / `build.rs` / `Info.plist` / `Entitlements.plist`はregular fileかつ改行正規化SHA-256一致、`public/`はexact `_redirects`だけを許可する。Linuxのdirect `webkit2gtk` version / featureとmacOS plist参照もexact bundle / Cargo identityへ含める。
- `test:release-policy`は正規TOML parserでCargo feature、direct / build / target dependency、lib / bin / build targetをexact比較する。Studio / packagesのTS / JS source graphとrelative import境界をAST検査し、`fetch`、XHR、WebSocket、EventSource、beacon、WebRTC、WebTransport、Worker、HTTP / STUN / TURN、protocol-relative URL、meta refreshを拒否する。Rustはnetwork crate / std socket、未許可libc / windows-sys、source symlink、root外`#[path]`、conditional path、`include!`を拒否する。fixtureだけでなく現在repository自体を同じtest内で走査する。
- `renderer-assets` gateは必須の`production` / `e2e` profileでHTMLとhashed entryのexact inventoryを分離し、参照entryの実在、exact `_redirects`、CSS / HTML / JS以外の出力、symlink / file-count / byte境界、RTC・socket primitive、protocol-relative / 未許可remote URLを検査する。Studio production / E2E build、Desktop smoke / bundle、通常3OS CI、signed macOS / Windows / Linux buildの直後にそれぞれ実行し、platform-specificな生成物を署名・staging前に止める。

native file commandはRust内でpickerとI/Oを完結し、pathをrendererへ返さない。raw payloadはformat magic / structureと16 MiB project / 8 MiB MIDI / 128 MiB source audio / 192 MiB WAV上限を再検証し、候補名をUTF-8 240 bytesへ制限してatomic overwriteする。`file_open_audio`はWAV / MP3 / M4A / AACだけを専用permissionで許可し、basenameとbounded bytesだけを返す。

## 4. Test-only WebDriver isolation

macOSを含む実WebView検証にはTauri公式が案内するWebdriverIO embedded providerを使う。

- Cargo feature: `native-test`
- optional crate: `tauri-plugin-wdio-webdriver`
- config overlay: `tauri.test.conf.json`
- config overlay内のinline capability: `main-test`
- test bundle ID: `com.composetutor.studio.test`
- test WebView: `native-test` feature時だけincognito（非永続data store）

embedded serverはtest featureでだけcompileされ、さらに`WDIO_EMBEDDED_SERVER=true`で起動したときだけ登録される。test WebViewはincognitoで起動し、productionのlocalStorage/cacheを読み書きしない。bundle IDの違いだけをdata分離の根拠にはしない。production rendererにはWDIO frontend plugin、global Tauri API、WDIO IPC permissionを追加しない。

native-test binaryは`src-tauri/target/native-test/release`へ分離する。通常の`src-tauri/target/release`を上書きしないため、E2E失敗・中断後もtest server入りbinaryを配布pathへ残さない。embedded WebDriver portは実行ごとに空きportを割り当て、SQLite data directoryも実行ごとのOS tempへ隔離する。`write` / `restore` / `normal-close` / `normal-close-restart` / owned SIGKILL process / `sigkill-restart` / `sigkill-second-restart` / `erase` / `blank-restart`を連続実行し、保存復元と再出現防止を証明する。owned process内で編集し、現在revisionの保護済み表示と編集から1秒未満を確認した直後、親harnessが所有するexact child PIDだけへ`SIGKILL`する。`sigkill-restart`で復元と新しい通常保存、`sigkill-second-restart`で保存一覧1件、回復branchなし、新しい保存内容の維持まで確認する。親への`SIGINT`/`SIGTERM`はexact childの停止とlistener清掃へ転送し、孤児process、lock、portを残さない。normal-closeはWebDriverの`destroy()`直結closeを使わず、`native-test`featureだけが読む絶対pathの64桁ランダムtoken fileを外部からatomic生成し、Tauriの`window.close()`で実`CloseRequested`を発行する。renderer向けtest commandやraw close/destroy権限は追加しない。marker起動再開は同じ実binaryをWebDriver未登録で直接起動し、正常終了を要求する。全隔離directoryは終了後に削除する。

normal-closeとUI eraseの自動testは、durable flushまたはstorage消去を観測してからnative close handoffを証明できるよう、`native-test` feature内に限り環境変数で50〜5000 msの終了猶予を指定できる。本番binaryは環境変数をcompileせず50 ms固定で、renderer向けtest APIやpath公開commandは追加しない。自発終了後はWDIOの汎用`DELETE /session`が接続拒否になるため、全UI/storage/server停止assertの後だけtest workerが予測不能tokenのproofをapp data外へatomic生成する。harnessは、その実行だけに渡したpath/tokenが完全一致するときに限り各close phaseの終了code 1を期待済みteardownとして受理し、proof前の失敗は通常どおり全体を失敗させる。

`@wdio/tauri-service@1.2.0`は`@wdio/native-utils@2.4.0`に無いexportを参照するため、root pnpm overrideで修正済み`2.5.0`を固定している。service側が依存を更新したreleaseへ上げるときにoverrideを削除して再検証する。

同じoverride blockで、上流rangeが追従するまで`serialize-javascript@7.0.7`（Mocha経由）と`esbuild@0.28.1`（Vite経由）も既知脆弱性修正版へ固定する。依存更新時は`pnpm audit`が0件であることと全Web/native gateを確認してから不要なoverrideを外す。

## 5. Commands

```bash
pnpm dev:desktop
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:typecheck:native
pnpm desktop:test:release-policy
pnpm desktop:e2e:native
pnpm desktop:build:smoke
pnpm desktop:size:check
pnpm verify:desktop
```

`desktop:e2e:native`は分離targetへtest featureのrelease binaryを作る。配布用pathとは共有しないが、`verify:desktop`とCIは最後にdefault featureのproduction buildも検証する。

## 6. Native smoke contract

自動testは最低限次を証明する。

1. 実WKWebView/WebView2/WebKitGTKで`.app-shell`が表示される。
2. URLがbundled originで、global Tauri APIが無い。
3. Web Locksが利用できる。
4. production meta CSPに3OSのTauri IPC originがあり、localhost WebSocketが無い。
5. transportが再生状態へ入り、再生位置が進み、停止できる。
6. projectをSQLiteへ保存済みにでき、localStorageに旧project recordを作らない。
7. 同じ隔離data directoryでnative processを再起動し、titleを復元できる。
8. 編集後1秒未満に現在revisionの`保護済み`表示へ到達し、その直後のexact child PIDへの`SIGKILL`から同じtitleを復元できる。
9. 復旧後に新しいtitleを通常保存し、二度目の再起動で保存一覧が1件、回復branchが無く、そのtitleが維持される。
10. native-only UIへ正確な`すべて消去`を入力し、現在のWebViewのonboarding/tutorial/recovery/local/session sentinelがすべて空になり、close handoffでembedded serverが停止する。
11. process終了後にSQLite本体/WAL/SHM/journal/markerが無く、app data外のsentinelが同一である。
12. checksum-valid markerと保存済みSQLite database一式、またはmarkerと単独sidecarから起動したWebDriver未登録binaryが、自動再開して正常終了し、family/markerを残さない。
13. 全消去後の別processではSQLite正本由来の旧titleと保存一覧が戻らない。
14. source audio pickerはWAV / MP3 / M4A / AACだけを受理し、絶対pathをrendererへ返さず、128 MiB超過と明白な拡張子 / container不一致をRustで予備拒否する。rendererは受け取ったbytesをWeb入力と同じ厳格parserで再検証する。
15. microphoneは同一originのaudio-only要求だけを許可し、video / mixed要求を拒否する。signed candidateではmacOS / Windows / Linux各OSで初回許可、拒否後のfile fallback、再許可、録音停止、device切断を手動smokeする。

renderer-only Playwright E2Eは引き続き初回曲、MIDI/WAV/project export、競合・破損復旧を広く検査する。OS picker自体はRust helper testと手動3OS smokeで確認し、自動native E2Eはpathを公開するtest backdoorをproductionへ入れない。

この自動testはproduction profileを保護するためincognito WebViewを使う。したがって`clearAllBrowsingData()`のproduction profile上のcache/cookie残存までは証明せず、signed candidateの3OS手動smokeで補完する。

## 7. Runtime baseline

- macOS: 12.4以上、Vite targetはSafari 15.5。保存に必要なWeb Locksとmodal accessibilityに必要な`inert`を満たす。
- Windows: WebView2 105以上。installerは古いruntimeを検出してEvergreen bootstrapperを実行する。
- Linux: WebKitGTK 4.1。package metadataだけではminor versionを固定できないため、native smokeでWeb Locksを実測し、非対応時は保存をfail closedする。
- Linux AppImage: `bundleMediaFramework`を有効にしてGStreamerを同梱する。PR CIではAppImage生成までを検査し、配布前に生成物からの起動・音声smokeを追加する。
- `color-mix()`にはplain color fallbackを先に宣言し、上記baselineで未対応でも警告・focus surfaceを消さない。

PR CIは`size-budgets.json`のOS/CPU別上限でproduction executableを検査する。未計測OSの値はprovisionalとし、3OS CI初回観測後にbaseline + 20%程度へ締める。署名後installer/packageの上限はrelease workflowで別に検査する。

## 8. Native local-data erase boundary

プロジェクトメニューの「この端末のデータ」はnative版だけに表示する。通常のプロジェクト削除がlogical tombstoneであり、exact migration archiveや互換性recordが残り得ることを先に説明する。全消去は専用modalで正確な`すべて消去`入力を要求し、開始前の初期focusはcancelへ置く。開始後は成功・失敗を問わずEscape/backdrop/close button/cancelを無効化し、失敗時はeditorへ戻さず同じoperationを再試行する。

native shellの境界は次の通り。

1. app data directoryのprocess lockにより、別processのSQLite利用と消去を競合させない。lock pathは空・通常ファイル・単一linkに限定し、no-followで開いたhandleと現在pathの同一性をlock取得前後に検証する。SQLiteはrusqliteのdefault flagsに`SQLITE_OPEN_NOFOLLOW`を加え、canonical main / exact `-wal` / exact `-journal`だけを許可するguard VFSで開く。VFSはpathをprecheckし、original VFSの`xOpen`直後かつ最初のI/O前にactual fd/HANDLEのidentity・通常ファイル・単一link・retained directory identityを再検査する。初回mainは`create_new`で先に確保する。main actual handle確認直後に`locking_mode=EXCLUSIVE`と`temp_store=MEMORY`を設定するため、単一process WALは`-shm`を開かない。設定/migration後にもmain/WAL actual handleを再検証する。Unixでは最終app data directoryを`0700`、lock・DB family・erase markerを`0600`へ制限する。Windowsでは最終directoryをreparse非追跡・share-delete無しで保持し、公開WIN32 handleと128-bit file IDで照合する。renderer内では通常終了と全消去も同期lifecycle gateで排他し、どちらか一方だけが最初の非同期境界を越える。
2. `persistence_prepare_erase_all`はdatabase外のchecksum付きmarkerをatomic write・fsyncしてからrepositoryをsealし、SQLite本体と`-wal` / `-shm` / `-journal`を削除する。通常ファイルは単一linkだけをunlinkし、hardlinkやpath差替えを検出した場合はmarkerと全aliasを残してfail closedする。同じ`eraseId`はidempotent、別IDはconflictである。
3. rendererはprocess-wideのone-way write fenceを閉じ、`localStorage`と`sessionStorage`をclearし、Tauri WebViewの`clearAllBrowsingData()`でcacheを含むbrowsing dataを消した後、両storageを再clearして空であることを確認する。
4. `persistence_complete_erase_all`はdatabase familyが無いことを再検査してmarkerを削除する。そのprocessのrepositoryはsealedのまま、限定close commandでappを終了する。

消去完了後の限定close commandは、送信中の`erase-close-pending`、nativeがdestroy要求を受理した`erase-close-accepted`、dispatch後のfalse/reject/10秒timeoutである`erase-close-unknown`を区別する。受理済みでもOS/WebViewのwindow destructionまで猶予があり得るため、acceptedは成功progress、unknownは終了結果不明alertを表示したまま非dismissとし、どちらも画面内retryを出さない。同phaseでStore actionが再度呼ばれてもIPCを送らない。起動前recovery screenも同じtimeout/outcomeを使い、prepare/clear/completeまでの失敗だけをretryableにする。

通常終了と全消去はrenderer process内のatomic lifecycle gateを共有する。Rustはmain windowの実`CloseRequested`でだけopaque request IDを発行し、rendererはeventを同期cancelし、最初のawait前にStoreのproject mutation fenceを取得してからIDをclaimする。通常終了が先に所有した間の全消去拒否はまだ可逆であり、UIは「消去開始」としてlockしない。async flushはcanonical保存後の一覧refreshから戻った時点でもactivation / revision / persistedRevision / dirtyを再検証する。古いflush結果は成功にせず、最新snapshotと一致する同期recovery receiptが得られた場合だけcanonical `clean=false`のままclose-safeとする。flushまたは同期recovery成功後の単一close commandがIDを一度だけ消費し、Rust内でrepositoryを閉じてから破棄threadを予約する。dispatch前の失敗はmutation fenceを解放し、dispatch後は結果不明でも解放しない。独立した`persistence_close`、raw `close`、raw `destroy`はrenderer capabilityへ公開しない。

repository初期化のsingle-flightは失敗時だけ解除し、保存の再試行からnative migration / initializeを同一processで再実行する。初期化失敗後に編集済みなら、再試行で古い保存projectをactiveへ上書きせず現在snapshotを保存し、既存projectも保持する。

限定window-close command送信後の応答だけが不明になった場合、Storeは`close-handoff`へ遷移して`projectOperationBusy`を維持する。このphaseでは消去が始まっていないことを明示し、終了・消去・close IPCの再試行buttonを出さない。全close eventは同期cancelし、dispatch後はrenderer側の応答timeoutやrejectでもnormal-close ownershipを解放しない。消去完了は同じ`eraseId`、起動時status失敗後のidle終了はrepository初期化前のidle検証という別のone-shot認可だけを受け付ける。

起動時はApp、close guard、repository初期化、legacy migrationより先に`persistence_get_erase_all_status`を呼ぶ。pending markerまたはstatus判定失敗があれば編集画面をmountせず、専用recovery screenだけを表示する。pendingでは同じ`eraseId`の`prepare`を再実行して中断したdatabase-family削除を完了してから、WebView cleanup→marker完了→終了を再開する。失敗時は画面を閉じない。これによりnative databaseだけが消え、renderer emergency recovery/tutorial/onboardingから内容が再作成されるraceを防ぐ。

対象はCompose Tutor Studioのapp dataと現在のWebView profileであり、app data外へ書き出したproject/MIDI/WAVには触れない。OS backup、filesystem snapshot、SSD wear levelingに残るbytesのforensic/secure eraseは保証しない。

marker付き再開はprocess crashを対象とする。Unixではmarker作成・database family削除・marker削除の親directoryを同期するが、Windowsの通常file deleteに対するdirectory metadata write-throughは未実装であり、突然の電源断直後までのdelete永続性は保証範囲外である。配布前QAでは通常終了・強制process終了を検査し、power-loss/実NTFS検証またはwrite-through tombstoneは後続hardeningとして扱う。

guard VFSはbundled SQLite 3.53.2とoriginal VFS名をruntimeでexact確認する。Unix actual fd検証は固定されたprivate `unixFile`先頭ABIへ依存するため、rusqlite/libsqlite3-sys/SQLite更新時は必ず再監査する。自動検証ではmain/WALのxOpen中差替えをtest hookで発生させ、SQLite I/O前の拒否、外部bytes不変、exclusive WALの`-shm`不生成を固定する。同一UIDが検証完了後に継続してfilesystem entryを操作する攻撃まで対象にする配布では、追加のOS sandbox/ACLが必要である。

自動検証ではmarkerのchecksum/version/atomicity、database family、初期化時のsymlink/hardlink/unsafe sidecar拒否と外部bytes不変、Unix private mode、Windows directory reparse、process lock、seal、same-ID retry、startup gate、WebView storage二重clear、UIのtyped phrase/focus/close lock/single-flight/retryに加え、実native UIの消去・終了、外部seed markerからの起動再開、空再起動を確認する。配布前の3OS smokeでは実production profileのcache消去、複雑な全record class、外部export実fileが残ることも確認する。

## 9. Protected signed release candidate

`.github/workflows/release.yml`は通常PR CIと分離し、stable SemVer tag（例: `v1.2.3`）のpush、またはそのtagをworkflowのrefとして選んだ手動実行だけを受け付ける。手動実行は`confirm_signed_release=true`も必要とする。tag、checkout ref、40桁commit SHA、root / Studio / Desktop package、Tauri、Cargoの5つのversionが一致し、tag commitが`main`上に無ければ署名jobへ進まない。

GitHub側で次を先に設定する。workflowだけではrulesetやreviewerの存在を作成・証明できない。

1. `v*.*.*`の作成・更新・削除を制限するrepository tag rulesetを有効にする。
2. `commercial-release` environmentを作る。
3. environmentにrequired reviewerを設定し、self-reviewを禁止する。
4. deployment branch/tag policyはselected tagsの`v*.*.*`だけを許可する。
5. 下記のsecretとvariableはrepository共通ではなく、このenvironmentへ置く。

| 種別 | 名前 | 内容 |
|---|---|---|
| secret | `APPLE_CERTIFICATE` | Developer ID Application `.p12`のbase64 |
| secret | `APPLE_CERTIFICATE_PASSWORD` | `.p12` export password |
| secret | `APPLE_API_PRIVATE_KEY_BASE64` | App Store Connect API `.p8`のbase64 |
| variable | `APPLE_API_ISSUER` | App Store Connect API issuer UUID |
| variable | `APPLE_API_KEY` | App Store Connect API key ID |
| variable | `APPLE_SIGNING_IDENTITY` | `Developer ID Application: ... (TEAMID)`の完全なidentity |
| variable | `APPLE_TEAM_ID` | 署名詳細と照合するApple Team ID |
| secret | `WINDOWS_CERTIFICATE` | commercial code-signing `.pfx`のbase64 |
| secret | `WINDOWS_CERTIFICATE_PASSWORD` | `.pfx` export password |
| variable | `WINDOWS_CERTIFICATE_THUMBPRINT` | 40桁SHA-1 certificate thumbprint（空白なしを推奨） |
| variable | `WINDOWS_TIMESTAMP_URL` | certificate providerのHTTP(S) RFC 3161 endpoint |

不足値は名前だけを表示してfail closedし、値は出力しない。Apple certificateとAPI private keyはimport stepだけへ渡す。ephemeral keychain、`.p12`、`.p8`はjob終了前に削除する。Windows `.pfx`もCurrentUser certificate storeから削除する。署名jobはGitHub `contents: read`だけで、tag、GitHub Release、外部配布先を書き換えない。

### 9.1 Gateと生成物

- source gate: lifecycle script無効のfrozen install、JavaScript/Rust audit、exact release policy、typecheck、unit/integration、browser E2E、native WebView write/restart/restore、Rust fmt/clippy/test、production build、profile付き最終renderer asset scan、size gate。各platform jobはsecret読込前にclean worktreeを確認し、同じrelease policyを再実行する
- macOS: Tauri公式の`universal-apple-darwin` targetでIntel + Apple Silicon DMGを作る。Developer ID + hardened runtimeで署名する。固定したTauri CLI 2.11.4が自動notarizeするappとは別に、署名済みDMGを`notarytool submit --wait --output-format json`で明示送信し、statusがexactly `Accepted`のときだけappとDMGをstapleする。standalone appに加えて配布DMG自身を`codesign`とGatekeeperの`type open`で検査し、read-only mount内のappもTeam ID、secure timestamp、2-architecture、Gatekeeperで再検査する。mount内とstandaloneのMach-O SHA-256が一致し、`stapler validate`と`hdiutil verify`も通ることを要求する
- Windows: imported certificateのprivate key、expiry、Code Signing EKU、thumbprintを検査する。ephemeral Tauri configで`digestAlgorithm: sha256`、`tsp: true`、provider timestamp URLを指定する。app executableとNSIS installerの両方について`Get-AuthenticodeSignature`の`Valid`、同一signer、timestamp certificate、SignTool `/pa /all /tw /v`を要求する。さらにPE certificate tableのCMSを読み、`SpcIndirectDataContent`のfile DigestInfoとprimary signerの両方がSHA-256 OID（`2.16.840.1.101.3.4.2.1`）、file digestが32 bytes、unsigned attributeにMicrosoft定義のRFC 3161 countersign OID（`1.3.6.1.4.1.311.3.3.1`）があることをlocale非依存で検査する。import前後のcertificate store差分は`-DeleteKey`で秘密鍵ごと削除する
- Linux: media framework入りAppImageを作り、production executable size gateとartifact gateを通す。配布ファイルのexecute bit、ELF + AppImage magic、`file`判定を確認し、`--appimage-extract`で展開した`AppRun`とproduction binaryが実行可能でなければ止める。現時点ではOS code signatureを付けず、最終SHA-256 manifestを完全性の配布境界とする
- 全OS: bundle内の配布形式をexactly oneに限定し、production executableからWDIO embedded server、test bundle ID、test plugin markerを走査する。installer/package上限は暫定でmacOS/Windows 128 MiB、media入りAppImage 512 MiBとし、初回release観測後に締める
- supply chain: exact frozen dependencyからSPDX 2.3 build SBOM、runtime license inventory、sanitized Cargo dependency inventory、`THIRD_PARTY_NOTICES.md`を作る。runtimeのunknown/非許可licenseはreleaseを止める。build-only unknownはSBOMに残し、runtime distributionの許可とは扱わない
- assembly: 3OS inventory内のsize/hash/verification labelを再検査し、全payloadの`SHA256SUMS`と`release-manifest.json`を作る。結果は30日保持のActions artifact `commercial-release-candidate-vX.Y.Z`だけであり、公開releaseではない

project本体のsource licenseはプロダクト所有者の判断事項なので、自動でMIT等を仮定せず`NOASSERTION`に固定する。公開販売前にproject licenseを決定し、生成noticeと各dependencyのlicense本文・帰属要件を法務レビューする。現在のallowlistにMPL-2.0が含まれるため、該当componentを変更・再配布するときのfile-level source obligationも確認する。

署名identity/secretsが無いローカル・PR環境では通常CIのunsigned bundleまでを検査し、商用release完了とは扱わない。公開前に残る必須gateは、候補artifactを使う3OSのinstaller/初回起動/file picker/close/audio smoke、N-1 upgradeによるSQLite保存データ維持、project license決定、公開操作の別approvalである。Updaterを追加するときはHTTPS endpoint、埋込み公開鍵、保護されたTauri signing keyをOS code signingとは別に検証する。
