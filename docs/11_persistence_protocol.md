# 11. プロジェクト保存・復旧プロトコル

## 1. 目的

保存途中のクラッシュ、容量不足、破損、非同期保存の完了順逆転が起きても、最後に検証できたプロジェクトを失わないことを目的とする。ブラウザ版とTauri/SQLite版は、同じ `ProjectRepository` とcanonical project codecを利用する。

## 2. 境界

- `@cts/project-model`
  - JSONサイズ上限
  - schema version判定とmigration
  - 完全な構造decode
  - domain validation
  - 安全なencode
- `@cts/project-persistence`
  - 非同期repository契約
  - localStorage世代保存
  - recovery journal
  - revision/activation付きcanonical save / crash protection coordinator
- Studio store
  - 2秒idle debounce / 30秒max wait
  - 保存・保護状態と失敗理由の表示
  - project切替前flush
  - lifecycle接続と復旧通知

## 3. localStorageレコード

論理キーは次の4種類。IDとoperation IDはURL encodingしてキーへ格納する。

```text
cts.persistence.v1.project.<id>.head
cts.persistence.v1.project.<id>.gen.<ordinal>.<operation-id>
cts.persistence.v1.project.<id>.intent
cts.persistence.v1.project.<id>.recovery.<activation-id>
```

旧版互換の `cts.project.<id>` は最新JSONのmirrorであり、正本ではない。

- generationはimmutable。project snapshotまたは削除tombstoneを格納する。
- headはcommit済みgenerationだけを指し、直前のcommit tokenとactive payload CRCも保持する。これにより、失敗した兄弟generationと本当の親世代、最新mirrorと古いmirrorを区別する。
- intentは「generation書込済み、head未切替」のクラッシュを識別する。
- recoveryはpagehide専用。activationごとに別キーへ保存し、複数タブの下書きを相互上書きしない。`baseHeadVersion`と、必要なら直前のin-flight saveを示す`predecessorWriteId`を記録し、Web Locksを迂回してcanonical headを書かず最新snapshotを退避する。旧単一`.recovery`キーは読み込み互換だけ維持する。
- head、generation、intent、recoveryはchecksumでmetadataを含む全内容を検査する。CRC32は偶発破損検出用であり、改ざん耐性を提供するMACではない。
- 既知より新しい`storageVersion`は全recordでstickyな`unsupported-version`として扱う。legacyや旧generationへfallbackせず、save/remove/recoveryで上書きしない。

## 4. 保存commit

1. projectをcanonical encodeし、実際に書くbytesを再decodeする。
2. ブラウザではproject単位のexclusive Web Lockを必須で取得する。取得待ちは5秒を上限とし、未取得のrequestだけを`AbortSignal`で破棄して通常の再試行可能なwrite failureへ戻す。取得済みのcommitは途中停止しない。Web Locksがないブラウザはcanonical save/removeを`lock-unavailable`でfail closedする。非ブラウザ/testで明示した場合だけ共有in-process queueを使う。
3. current headとexpected head versionを比較する。
4. stable `writeId` により応答喪失後のretryを冪等化する。
5. checksummed intentを書く。
6. immutable generationを書き、同じキーからread-back検証する。
7. headとintentが開始時のままか再検査する。
8. headをgenerationへ切り替え、read-back検証する。
9. intentと、同activation・同revision以前、または今回昇格したsnapshotと完全一致するrecovery journalだけを消す。別activationの分岐下書きは保持する。
10. 旧版mirrorをbest effortで更新する。
11. commit成功後だけ古いgenerationをGCする。currentから`parentHeadVersion`をたどったcommit済み祖先を失敗兄弟より優先し、最低3レコードを残す。

`expectedHeadVersion` は3状態を区別する。`null` は「証拠が何もないEmpty」を意味し、初回作成・初回削除だけに使う。省略は「head欠損・破損を明示的に直すRepair」であり、復旧可能なprojectの保存、またはcorrupt/conflict証拠の明示削除だけに使う。文字列はそのcommit tokenとのMatchである。EmptyをRepairの代用にはしない。

generation作成後にhead更新が失敗しても、intentがkey、operation ID、kind、parent headまで一致する場合だけ次回起動時の復旧候補になる。head欠損・破損時も裸の最高ordinal（単独tombstoneを含む）は採用しない。legacy mirrorとの完全一致または因果関係を検証できるrecoveryだけを明示的なcommit証拠として扱う。known-empty recoveryはmirrorが存在しない場合、または同一bytesの重複と証明できる場合だけ昇格でき、破損mirrorを「存在しない」とみなさない。

### 4.1 Native crash-draft保護

Tauri版は通常保存の2秒idle debounceを維持しつつ、受理した各revisionの最新snapshotを別の`persistence_stage_crash_draft`へ即時投入する。requestはcanonical saveと同じproject/activation/revision/write ID、expected head、任意のpredecessor write ID、canonical project JSONを使う。stagingはcanonical generation/headを更新せず、SQLite v2の`project_crash_drafts`へ`BEGIN IMMEDIATE` transactionで保存する。

- `(project_id, activation_id)`ごとに最新1件だけを保持する。同revisionでwrite ID、base head、predecessor、payloadまで一致するexact logical requestの再試行だけを冪等成功とし、同revisionのmetadata/payload違いとrevision後退はconflictにする。
- SQLiteは`WAL`と`synchronous=FULL`でcommitする。rendererはreceiptのproject/activation/revision/write ID/bytesを照合し、現在revisionと一致した後だけ`未保存の変更は保護済みです。自動保存を待っています。`を表示する。receipt前は`未保存の変更を保護中です。`であり、強制終了耐性を約束しない。
- protection I/Oはcanonical saveとは別のsingle-flightで最新revisionへcoalesceする。canonical flushは同revisionのstage I/Oが物理的にsettleするまで完了扱いにしない。
- canonical save成功時は、同activationでcommit revision以下のdraftだけを削除する。同revisionを消す場合はwrite IDとpayloadも一致させ、並行してstageされたN+1を削除しない。
- stage失敗はassertive statusで、現時点の編集を強制終了から保護できないことと、再試行/通常保存または緊急書き出しを案内する。通常保存の成功後はそのrevisionの保護失敗を解消できる。
- 起動時はまず件数64/合計64 MiB、実BLOB長、project IDをpayload decode前にpreflightする。verified deleted head配下の残留draftは内容をauthorityとして扱わず、そのtransaction内で未検証のままpurgeして復活とprivacy残留を防ぐ。それ以外は全draftのidentifier、format、payload/record checksum、canonical projectを検証してからmaterializeし、破損、future format、上限超過は元bytesを保持してfail closedする。
- 因果関係を検証できる未解決draftがproject内に1件なら`interrupted-save` generationとしてcanonical headへ昇格する。base/predecessorがcurrent headと比較不能、または複数activationの候補がある場合は全候補を`interrupted-save` branchへmaterializeし、端末時計で勝者を選ばない。
- verified deleted headはstageを拒否し、起動時に残留draftがあっても復活させない。通常removeと端末全消去も対象draftを削除する。
- native repositoryを包む層はdelegateが対応する場合だけcrash protection capabilityを公開する。legacy migrationがreadyになる前とclose開始後はstageを拒否し、closeはすでに受理したstage flightの物理完了を待つ。close失敗後はreadyへ戻して再試行できる。emergency journalのfuture/migration evidenceはcanonical saveと同じsticky規則でstageを止めるが、journal列挙自体が利用不能な場合はSQLiteの保護能力を不必要に無効化しない。

## 5. 削除

削除も通常保存と同じcommit手順を使い、immutable tombstone generationを作ってからdeleted headへ切り替える。cleanupに失敗して旧project generationが残っても、検証済みtombstoneが復活を防ぐ。`deleteId` はretry中固定し、削除応答の喪失にも冪等に対応する。検証済みdeleted headは表示とCASでは最優先するが、future/migration recordの未知bytesは削除しない。同一削除のretryは成功し、未知bytesを残した場合は`cleanupComplete: false`を返す。

## 6. 読み込み優先順位

native初期化は通常のload/listを公開する前にcrash draftを処理する。verified deleted head配下は未検証のままpurgeし、残りを全検証した後、因果的な1件をcanonical generationへ、比較不能な候補をbranchへ変換して元draftを削除する。その後の読み込み優先順位は次のとおり。

1. committed headが指す検証済みgeneration（verified deleted headは常にsticky）
2. current headをbaseとする、またはcurrent headのwrite IDを`predecessorWriteId`とする、より新しいrecovery journal
3. headと親versionが一致するintent付き中断generation
4. head欠損・破損時のintent/recovery/legacyによる明示的証拠
5. active payload CRCと一致するlegacy mirror、またはheadが旧形式の場合のlegacy mirror

同じbaseから複数activationの異なるrecovery/intent分岐が見つかった場合は、端末時計で片方を選ばない。全bytesを残して`conflict`診断として一覧へ出す。同一activationはrevision順、完全に同じproject JSONは重複として扱う。保存一覧は、current headから古くなったjournalも含めて分岐metadataを表示し、選んだ分岐を元IDへ昇格せず新しいproject IDのコピーとして開ける。元journalはコピー保存後も自動削除しない。

committed headまたは最新候補がfuture schemaの場合、古いgenerationへ黙ってdowngradeしない。元bytesを変更せず `unsupported-version` として一覧へ残す。

## 7. Coordinator不変条件

- repository saveは最大1件だけin-flight。
- crash protectionも最大1件だけin-flightで、canonical saveとは独立に最新revisionへcoalesceする。
- 同一activationでは最高revisionだけをqueueする。
- 遅れて到着した古いrevisionは最新pendingを上書きできない。
- receiptのproject ID、activation ID、revision、write IDを全て照合する。
- crash protection receiptはpayload bytesも照合し、現在revision以下の`protectedRevision`だけを単調に進める。
- 保存中のactivation切替は拒否する。
- cancel開始後は新規enqueueを拒否し、物理I/O完了後にだけ削除tombstoneを書く。
- save成功応答を失ったcancelはdurable headを再読込し、in-flight snapshotと完全一致するときだけ新しいhead tokenを採用する。別tabの異なるcommitなら削除せずactivationを維持して`conflict`にする。
- pagehide時はin-flightの有無にかかわらずrecovery capabilityを優先し、canonical headをWeb Locks外から更新しない。
- pending snapshotがin-flight saveの後続なら、そのwrite IDをrecoveryへ渡す。起動時はbase headまたはpredecessorが実際のcurrent headと一致した場合だけjournalを採用する。

## 8. デスクトップ版の端末全消去

「この端末のデータをすべて消去」は、通常のproject tombstone/GCとは別のnative-only protocolである。特定projectのexact migration snapshotだけを書き換えることはせず、Compose Tutor Studioのapp data全体を消去単位にする。

### 8.1 対象と対象外

対象:

- 全project head/generation/tombstone、recovery branch、中断save、unreadable/future診断
- checksum付きの旧localStorage exact snapshotとmigration staging/run
- `projects-v1.sqlite3`とWAL/SHM/journalを含むSQLite database family
- rendererのemergency recovery、tutorial/onboarding進捗、WebView local storage/cache

対象外:

- ユーザーがapp data外へ書き出したproject、MIDI、WAV
- OSバックアップ、filesystem snapshot、SSD wear leveling等に残る複製・痕跡

したがって、これはアプリが通常参照できるlocal dataの削除であり、媒体上のbytesを復元不能にするforensic/secure eraseを保証しない。

### 8.2 Marker付き二段階protocol

1. rendererは通常終了と全消去の共有lifecycle gateを同期的に取得し、新規編集・保存・project切替を止めて、同じ`eraseId`でsingle-flightの消去を開始する。通常終了が先にgateを取得済みなら消去は不可逆処理へ入らず、消去が先なら通常終了はstorageへ触れず停止する。
2. nativeはapp dataのprocess lockを保持したまま、version・`eraseId`・checksumを持つbounded markerをdatabase外へatomic writeする。lock entryは空の通常ファイルかつ単一linkだけをno-followで開き、handleとpathの同一性をlock取得前後に確認する。Unixではlink安全性の確認後、最終app data directoryを`0700`、lockとmarkerを`0600`へ制限する。Windowsでは最終directoryを`FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS`かつshare-delete無しで保持し、junction/reparseとpath/handle差替えを拒否する。markerのdurabilityを確認する前にdatabaseを消さない。
3. repository connectionを閉じて`Pending(eraseId)`へsealする。以後、通常のinitialize/list/load/save/remove/migrationは拒否し、消去のstatus/retry/completeだけを受け付ける。
4. nativeはSQLite database familyをすべて削除する。存在しないfileはidempotent successとする。symlink/reparse pointは外部targetを追跡せずentryだけをunlinkする。通常ファイルはno-followで再確認した単一linkだけを削除し、hardlink、同じpathのdirectory、path/handle差替えなど安全に全別名を否定できない場合はmarkerを残してfail closedする。hardlink先のbytesや別名は削除しない。
5. renderer/native shellはemergency recovery、tutorial/onboardingを含むWebView browsing dataとcacheを消去する。成功するまでmarkerとsealを維持し、editorへ戻さない。
6. WebView側の完了後だけnativeがmarkerを削除して完了を確定し、アプリを終了する。

marker完了後のwindow-close handoffもtyped phaseで区別する。`persistence_complete_erase_all`成功時にnative close stateへ同じ`eraseId`のone-shot認可を記録し、そのIDが一致する場合だけ終了を受け付ける。close request送信中は`erase-close-pending`、nativeが要求を受理した後は`erase-close-accepted`とし、後者ではwindow destructionがまだ数秒遅れてもbusy/statusだけを表示して再試行を許可しない。dispatch後のfalse/reject/10秒timeoutは、native側ですでにdestroyがscheduleされた可能性があるため`erase-close-unknown`というterminal状態にする。accepted/unknownのどちらも`eraseAllLocalData`再呼出しはfalseを返し、close IPCを二重送信しない。

Storeと起動前recovery controllerは同じbounded handoff helperを使う。markerを再開するprepare/renderer clear/completeまでの失敗だけがretryableで、finish-close dispatch後はretry buttonを消す。起動時status再確認がidleで、消去待ちを一度も観測していない場合のunknown messageはデータを消去したと主張しない。

marker作成後のどこでprocessが停止しても、次回起動は通常のpersistence初期化より先にmarkerを検査する。`Pending`なら同じ`eraseId`で4〜6を再実行するため、databaseだけ消えてrenderer recoveryから内容が再出現する窓を作らない。失敗時もmodalを閉じず、同じstore actionから明示的に再試行する。markerが壊れている、未知versionである、または別`eraseId`と競合する場合は通常起動せずfail closedする。

SQLite初期化はprocess-wideのguard VFSを使う。canonical main pathをconnection寿命だけregistryへ登録し、`MAIN_DB` / exact `-journal` / exact `-wal`の`xOpen`で、既存pathのno-follow検査→original VFS open→SQLiteがI/Oを始める前のactual OS handle検査を行う。pre/postで最終directoryとpath identityが変わらず、通常ファイル・単一link・検証済みidentityである場合だけopenを返す。Unixはexact bundled SQLite 3.53.2・original VFS名`unix`をruntimeで確認した上で、固定された`unixFile`先頭ABIのdescriptorを`fstat`する。Windowsは公開`SQLITE_FCNTL_WIN32_GET_HANDLE`と128-bit `FILE_ID_INFO`を使う。不一致、未知VFS、SQLite version差異はすべて`CANTOPEN`でfail closedする。

main actual handleを検証した直後、最初のschema/WAL accessより前に`locking_mode=EXCLUSIVE`と`temp_store=MEMORY`を設定する。process lockにより単一process利用なのでWALのshared-memory indexはprocess内に置かれ、`-shm`を開かない。これにより永続sidecarはguard VFSを通るWAL/rollback journalだけになる。rusqlite/libsqlite3-sys/SQLiteを更新する場合、private `unixFile` prefix、VFS名、xOpen flag、exclusive-WALの`xShm`不使用を再監査し、瞬間差替えtestを更新するまでreleaseしてはならない。

この境界が防ぐのは既存unsafe entryとxOpen中の差替えである。検証後の任意時点に同一UIDの別processが新しいhardlinkを作る攻撃をOS sandboxなしで絶対阻止するものではない。同一UIDの継続的な能動攻撃を脅威modelへ含める配布形態では、OS sandbox/ACLによるapp data隔離を追加する。

通常終了と全消去はprocess-wide lifecycle gateで相互排他にする。Rustはmain windowの実`CloseRequested`を観測した場合だけprocess-localのopaque request IDを発行し、rendererはclose eventを同期cancelした直後、最初のawaitより前にStoreのproject mutation fenceを取得してからそのIDをclaimする。通常終了が先にgateを取得した場合、全消去actionの拒否は「消去開始」とみなさずmodalを恒久lockしない。rendererのasync flushはcanonical保存後の一覧refreshを待った後にも最新activation / revision / persistedRevision / dirty状態を再検証し、その間に編集が入った古い結果を成功にしない。canonical flushまたは最新snapshotと完全一致する同期recovery receiptの成功後、単一の限定close commandがIDを一度だけ消費し、Rust内でrepository closeの成功を確認してからwindow destructionをscheduleする。同期recoveryはcanonical `clean=false`のまま保護revisionを進め、次回初期化で通常のlocked I/Oから昇格する。`persistence_close`はrenderer capabilityとinvoke handlerへ公開しないため、単なる「connectionなし」やrenderer生成tokenだけでは終了できない。

初期化single-flightは成功時だけprocess寿命まで保持する。native migration / repository initializeが失敗した場合はPromiseを解除し、保存の明示再試行から初期化をやり直す。失敗後にactive projectがrevision 1以上へ編集されていれば、再初期化で保存済みprojectをactiveへ置換せず、現在snapshotを別projectとして保存して既存データも保持する。

限定close commandを一度dispatchした後に応答がtimeout/rejectした場合だけ、Storeをtyped `close-handoff` phaseへ移す。この状態は「データ消去は開始していない」「終了要求の結果は不明」を区別し、`projectOperationBusy`を維持して編集・消去・close IPC再試行を無効化する。rendererにはraw `close`/`destroy`権限を与えず、すべてのclose eventを同期cancelする。dispatch後は応答の消失やtimeoutでもnative側のrepository close/window破棄を取り消せないため、processが終了するまでnormal-close gateを解放しない。

### 8.3 検証要件

- UI: native-only表示、完全一致phrase gate、cancelへの初期focus、Escape/backdrop/Xの開始後lock、二重開始防止、failure alertとretryを検査する。
- close-first race: erase未開始の同期拒否ではmodalをlockせず、final close応答不明では`close-handoff`のOS終了専用alertへ切り替わりretry controlが無いことを検査する。
- close grace: `erase-close-accepted`へ遷移してからwindowが実際に破棄されるまでstatus表示だけであること、retry controlが無いこと、Store action再呼出しがclose IPCを増やさないことを検査する。
- close authorization: OS close event前のclaimが空、誤ID・再利用ID・repository close前のfinishが拒否されること、正しいIDでも一度だけclose/destroyへ進むことを検査する。false/reject/never-settling responseは`erase-close-unknown`またはstartup terminal outcomeとなり、画面内retryが無いことも検査する。
- Rust: marker atomicity/checksum/size/version、process lock、repository seal、database family列挙、guard VFS、SQLite `NOFOLLOW` open、初期化前後の単一link・path/actual-handle検証、main/WALのxOpen中瞬間差替えと外部bytes不変、exclusive WALで`-shm`不生成、symlink/reparse、非empty/multi-link lock、hardlinked database family、安全でないsidecar、Unix private mode、Windows directory reparse、同一`eraseId` retry、異なるID競合を検査する。
- crash matrix: marker前、marker直後、connection close後、各database file削除中、WebView cleanup前後、marker完了前で停止し、再起動時に通常project APIを公開せず再開することを検査する。
- native WebView E2E（自動）: 保存済みprojectと、onboarding・tutorial・emergency recovery namespaceを含むlocal/session sentinelをUI操作で消去する。SQLite family/marker不在、app data外sentinel維持、close handoff、正しいmarkerからの「完全な保存済みDB」「単独sidecar」起動再開、最後の空再起動を別process間で検査する。
- native WebView E2E（配布前3OS）: 自動testはincognito WebViewのため、production profileのcache/cookie、branch・future/unreadable・exact archiveの全組合せ、実際の外部export fileが変わらないことはsigned candidateで検査する。

## 9. 現在の制約

- localStorage自体にはatomic compare-and-swapがないため、Web Locks非対応ブラウザではcanonical更新を無効化する。完全なmulti-writer保証の次段階はTauri/SQLite transactionで行う。
- ブラウザ版JSONはcompact canonical payloadで保存・通常書出し・緊急書出し・再読込を同じ16MB上限に揃える。audio assetはまだproject bundleへ含めない。
- untrusted projectはUI展開前に、最大256小節かつ8192四分音符拍、拍子分子32、128 steps/bar、128 tracks、20,000 events/clip、最小event長1/960拍などの実用上限を検証する。track colorは外部URLを解釈できないhex色だけを許可する。
- Tauri版はSQLite正本へ切替済み。旧localStorage snapshotはcontent checksumだけを信用せず、全key/value/checksumをnative側で再検証し、候補のsource provenanceを証明してからmigration version単位でatomic公開する。future/corrupt recordは診断として保持し、decoder更新時はmigration versionを上げて再評価する。
- native repositoryはlegacy migration v1/v2を受理し、同一snapshot/projectでは完了済みの最高versionだけをlive authorityとして扱う。これによりv2で復旧できたprojectの旧unsupported/migration診断や旧branch/headはlive判定から外れる一方、異なるsnapshotのsticky evidenceとexact raw archiveは保持される。未完了の上位versionは下位versionを置き換えず、未知の将来versionがrunまたはstagingに残るdatabaseは初期化・全操作ともmutation前にfail closedする。rendererはProject schema v1→v2 migrationを含むlegacy migration v2を送信し、完了済みv1 markerがあってもexact raw archiveを新decoderで再評価する。
- native close requestは即時にwindow destructionを止め、async flush、同期recovery journal、SQLite close、限定close commandの順で終了する。OS強制killでは、現在revisionについて`保護済み` receiptを照合済みならcrash draftを次回起動で復元する。receipt前のstage中、保護失敗後、突然の電源断やstorage hardware故障までは保証しない。
- 旧localStorageのexact raw archiveは移行監査・future schema再処理のためSQLite内に残る。通常のプロジェクト削除では消えず、デスクトップ版の端末全消去だけがdatabase familyごと削除する。
- 端末全消去のmarker順序と再開はprocess crashを対象にする。Windowsではdirectory metadataの明示fsync相当を現在実装していないため、電源断直後のNTFS delete永続性までは保証せず、実機power-loss検証またはwrite-through設計を後続hardeningとする。
