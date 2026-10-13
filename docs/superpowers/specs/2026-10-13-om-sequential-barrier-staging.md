# Spec — OM: pipeline sequential, memory barrier, konsolidasi ber-staging, decoupling second-brain

Status: menunggu eksekusi · Tanggal: 2026-10-13 · Pemilik: Ultron (orchestrator), dieksekusi via subagent

---

## Spec (apa & kenapa)

### S1 — Pipeline worker jadi strictly sequential
Maksimal **satu** subprocess worker (observer ATAU consolidator) hidup pada satu waktu.
`/om-parallel` dihapus; `serialWorkers` dipaksa `true` di kode (DEFAULTS + `normalizeSettingsConfig`),
jadi setelan `false` yang lama pun tidak bisa mengembalikan mode paralel.

Alasan: bridge observer (`BRIDGE_TAIL = 8`, dibangun saat dispatch) hanya membaca observasi yang
sudah ter-commit. Empat observer paralel melihat snapshot yang sama dan tidak melihat hasil
satu sama lain.

### S2 — Memory barrier sebelum render compaction
Urutan wajib di `session_before_compact`:

1. Tunggu semua observer in-flight selesai.
2. Kalau pool observasi sudah melewati `consolidateAtPoolTokens`: dispatch consolidator **lalu tunggu selesai**.
3. Baru render compaction.

Aturan tambahan:
- **Anti-kelaparan:** selama barrier aktif, observer baru tidak boleh didispatch (kalau tidak, tiap
  observer selesai memicu observer baru dan barrier tidak pernah selesai).
- **Fast-path skip dimatikan** kalau ada consolidator in-flight (`canSkipObserverWait` hanya untuk
  kasus tidak ada konsolidasi).
- Compaction hook **wajib menggerakkan** consolidator (memanggil trigger), bukan sekadar menunggu —
  kalau hanya menunggu, tidak ada yang akan mendispatchkannya (deadlock by omission).

### S3 — Konsolidasi ber-staging dengan promote atomik
- Live: `.memory/<sessionId>/` (symlink) → `.memory/<sessionId>.g<N>/` (direktori generasi nyata).
- Sebelum run: orkestrator membuat generasi kerja baru = **hardlink-copy** dari generasi live
  (aman karena `write`/`edit` konsolidator memakai `atomicWrite` temp+rename, sehingga hardlink
  putus saat file ditulis — file live tidak tersentuh).
- Worker dijalankan dengan `cwd`/`OM_MEMORY_DIR` = path generasi kerja (path nyata, bukan symlink).
- Exit kode 0 → INDEX.md dirender ulang **di generasi kerja**, lalu symlink `.memory/<sessionId>`
  digeser dengan satu `rename()` (atomik). Generasi lama baru dihapus setelah swap.
- Gagal / SIGKILL / stale → generasi kerja dibuang; live tidak tersentuh; batch **tidak** di-tombstone
  (diulang pada giliran berikutnya).
- Migrasi: `.memory/<sid>` yang masih direktori nyata dikonversi sekali (rename → `.g1`, buat symlink),
  idempoten; kalau `rename` gagal, tetap jalan in-place (fallback) tanpa kehilangan data.

### S4 — Tidak ada timeout
Tidak ada batas waktu untuk worker. Run yang lambat tapi progresif dibiarkan selesai. Yang ditangani
hanyalah integritas data (S3), bukan pemotongan waktu.

### S5 — `compactAtContextTokens` tetap 264.000
Tidak diubah (keputusan pemilik: model 1M context, 264k masih kecil dan kualitas masih bagus;
prioritas performa + cost). Durasi barrier dilaporkan lewat telemetri (S6) supaya keputusan ini
bisa ditinjau dengan data, bukan tebakan.

### S6 — Telemetri barrier & promote
Catat: durasi tunggu observer, durasi konsolidasi, hasil promote (ok/gagal), per run. Tampilkan di
`/om:status` dan timeline.

### S7 — Decoupling OM ↔ pi-second-brain
- Lokasi penyimpanan memori OM **tidak diubah** (symlink `/home/yusuf/.memory` dibiarkan apa adanya).
- **Auto-indexing dimatikan**: class root `om` di pi-second-brain (source `~/.pi/agent/second-brain/memory`,
  class `om`) tidak lagi didaftarkan/diwatch, sehingga direktori sesi baru tidak lagi otomatis jadi KB.
- **Coupling di OM dihapus**: baris advertising `knowledge_search` di blok compaction
  (`src/ledger/render.ts`) + klaim di README + test yang mengunci baris itu.
- **Isi OM yang sudah ada di second-brain dihapus**: seluruh KB `class='om'` (20 KB, 2.997 chunk) +
  file vektor `<kbId>.bin` + sisa `.tmp`. File markdown memori OM **tidak dihapus**.

### Kriteria selesai (terukur)
1. `/om:status` tidak pernah menunjukkan >1 worker in-flight; `/om-parallel` tidak ada lagi.
2. `/om:compact` saat observer jalan → menunggu → (bila pool due) konsolidasi → render; terverifikasi
   oleh test + satu run nyata.
3. SIGKILL di tengah konsolidasi ⇒ isi `.memory/<sid>/` byte-identical dengan sebelum run, batch masih
   aktif di ledger (test).
4. Setelah promote sukses: tulisan konsolidator ada di `.memory/<sid>/`, generasi lama terhapus.
5. `select count(*) from knowledge_bases where class='om'` = 0; tidak ada class root `om`; restart pi
   tidak menciptakan ulang; file markdown memori OM tetap ada.
6. Seluruh test suite lolos (`vitest`), termasuk test baru di atas.

---

## Context (bukti & peta kode)

**Paket:** `/home/yusuf/.pi/agent/packages/pi-observational-memory` (TS, vitest, 368 test).
**Second brain:** `/home/yusuf/.pi/agent/packages/pi-second-brain`.

**Temuan pengukuran sesi ini** (root cause lambatnya konsolidasi):
- Waktu run ≈ `output_token ÷ decode_rate`. Output per run 30–45k token (separuhnya reasoning).
- Penyebab utama: `STATE.md` ditulis ulang penuh tiap batch tapi sudah 3.630 token (6× target
  "~600 token" di prompt), `JOURNEY.md` ditulis ulang lalu di-edit 5× lagi, dan file topik besar
  (maks 6.830 token) ditulis ulang utuh.
- Observer sehat: median 23–30s (cloud).

**Fakta kode yang relevan:**
- `src/runtime.ts` — `observersInFlight`, `consolidatorInFlight`, `observerTasks`, `whenObserversIdle()`,
  `observerSlotsAvailable` (serial ⇒ 1 slot global), `abortAllWorkers()`.
- `src/hooks/observer-trigger.ts` — `BRIDGE_TAIL = 8`, `bridgeContextBlock()` dipanggil saat dispatch,
  `pumpWorkerQueue()`, `shouldYieldToConsolidator()`, retry-slice + gap.
- `src/hooks/consolidator-trigger.ts:96` — `if (serialWorkers && observersInFlight.size > 0) return;`
  ⇒ penungguan observer **hanya** di mode serial.
- `src/hooks/compaction-hook.ts` — menunggu observer (`whenObserversIdle`), **tidak pernah** menunggu
  konsolidator (design R5); ada fast-path `canSkipObserverWait`.
- `agent/consolidator/tools.ts` — `write`/`edit` memakai `atomicWrite` (temp+rename) ⇒ hardlink-copy aman.
- `src/commands/switching.ts` — `/om-parallel` & `/om-sequential` menulis `serialWorkers` ke settings.

**Fakta coupling:**
- `/home/yusuf/.memory` → symlink ke `~/.pi/agent/second-brain/memory` (dibuat 2026-09-29).
- pi-second-brain: `startClassWatchers()`/class root (`index.ts`), `engine.ts` (class_root, reconcile),
  `knowledge_bases` (kolom `class`, `class_root`, `source_path`).
- DB: 20 KB `class='om'` (2.997 chunk), 3 di antaranya duplikat `om-01a0f880-d83`; vektor
  `storage/vectors/<kbId>.bin`; `deleteKB(db,id)` di `src/storage/sqlite.ts:612` (satu transaksi);
  tool resmi `knowledge_remove` (butuh konfirmasi eksplisit).
- OM: satu-satunya referensi = `src/ledger/render.ts:15` + `tests/render.test.ts:58-61` + README.

---

## Tasks

| # | Siapa | Isi | File utama | Depends on |
|---|---|---|---|---|
| A1 | worker | Substrat staging: helper generasi (workDir, hardlink copy, promote atomik, GC generasi lama, migrasi idempoten + fallback in-place) | `src/memory/paths.ts`, `src/runtime.ts` | — |
| A2 | worker | Sequential wajib: DEFAULTS + normalize memaksa `serialWorkers: true`; hapus `/om-parallel`; `/om-sequential` jadi no-op informatif; pesan `/om:consolidate` & `/om:compact` disesuaikan | `src/config.ts`, `src/commands/switching.ts`, `src/commands/consolidate.ts`, `src/commands/compact.ts`, `src/commands/status.ts` | — |
| A3 | worker | Barrier: `whenWorkersIdle()` (promise konsolidator dilacak), urutan observer→consolidator→render, flag anti-kelaparan, matikan fast-path saat konsolidator jalan, hook menggerakkan consolidator | `src/runtime.ts`, `src/hooks/compaction-hook.ts`, `src/hooks/observer-trigger.ts`, `src/hooks/consolidator-trigger.ts` | A1, A2 |
| A4 | worker | Telemetri barrier/promote → `/om:status` + timeline | `src/ui/status-controller.ts`, `src/ui/timeline.ts`, `src/commands/status.ts` | A3 |
| A5 | tester | Test: sequential-only, urutan barrier, anti-kelaparan, SIGKILL ⇒ live utuh + batch tetap aktif, promote atomik, migrasi generation; jalankan seluruh suite | `tests/*` | A1–A4 |
| A6 | reviewer | Audit fresh (read-only): bukti per kriteria selesai 1–5 | — | A5 |
| B1 | worker | Hapus coupling di OM: baris advertising di render + test + README | `src/ledger/render.ts`, `tests/render.test.ts`, `README.md` | — |
| B2 | worker | Matikan auto-indexing di pi-second-brain: class root `om` tidak didaftarkan/diwatch (tanpa menyentuh data) | `packages/pi-second-brain/index.ts` (+ `src/engine.ts` bila perlu) | — |
| B3 | orchestrator | Hapus 20 KB `class='om'` + vektor `.bin` + `.tmp`; verifikasi count=0; restart pi ⇒ tidak tercipta ulang; file markdown OM utuh | `storage/knowledge.db`, `storage/vectors/` | B2 |

Urutan eksekusi: **satu writer per waktu**. A2 → A1 → A3 → A4 → A5 → A6; B1 dan B2 hanya setelah
A-phase selesai (paket berbeda, tapi B1 menyentuh paket OM ⇒ tidak boleh bersamaan dengan writer OM).

---

## Risks

| Risiko | Mitigasi |
|---|---|
| Barrier membuat chat diam lama di titik kompaksi (tanpa timeout) | Telemetri S6 mencatat durasinya; staging membuat state selalu konsisten; kalau terbukti mengganggu, keputusan barrier bisa ditinjau ulang (bukan diubah diam-diam) |
| Deadlock: hook menunggu worker yang tidak pernah didispatch | A3 mewajibkan hook memanggil trigger consolidator; dites di A5 |
| Kelaparan: barrier tak pernah selesai karena observer baru terus muncul | Flag anti-kelaparan (A3) + test |
| Staging merusak data | Hardlink copy + promote hanya saat exit 0; fallback in-place kalau `rename` gagal; test SIGKILL |
| Migrasi layout pada sesi lama | Idempoten; kalau gagal → tetap in-place (tidak ada kehilangan data) |
| Test lama mengunci perilaku paralel | A5 memperbarui test yang memang menguji mode paralel; perilaku v4 (render deterministik, flush-ack, trust-packing) tidak boleh berubah |
| Hapus KB salah sasaran (ikuti FK/CASCADE) | `deleteKB` satu transaksi; hanya `class='om'`; file markdown tidak disentuh; bukti count sebelum/sesudah |
| Watcher menciptakan ulang KB setelah purge | Urutan wajib: B2 (matikan watcher) **sebelum** B3 (purge), lalu verifikasi setelah restart |

---

## Completion

Perubahan selesai bila:
1. `npm test` di paket OM lolos (suite lama + test baru A5), tanpa `skip`.
2. Bukti kriteria 1–4 (kutipan command → hasil) dari run nyata, bukan klaim.
3. `class='om'` = 0 KB, tidak dibuat ulang setelah restart, file markdown memori OM masih ada (kriteria 5).
4. A6 (reviewer) menyatakan tiap kriteria punya bukti `file:line` / output command.
5. Ringkasan perubahan + bukti ditulis ke README/CHANGELOG paket OM (bagian perilaku pipeline).
